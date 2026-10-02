import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.mjs';

// Roon may open the stream URL more than once (e.g. a probe connection
// followed by the real playback connection), so a single-client server such
// as `ffmpeg -listen 1` dies on the first disconnect. Instead, a complete
// file is served with an exact Content-Length and Range support to every
// connection: the input itself if it's already a suitable MP4, otherwise a
// temp file it is remuxed (not transcoded) to up front.
//
// One HTTP server runs for the life of the process. It serves the current
// stream, and hands every other request to the `routes` handler (the control
// page and API).

const execFileAsync = promisify(execFile);

let _servers = [];
let _current = null;          // { urlPath, file, size, mtime, id, fmt }
let _streamResponses = new Set();
let _log = (msg) => { };

// Audio is passed through untouched (-c:a copy), so the output container and
// Content-Type have to match the input codec. AAC and ALAC go in an M4A with
// the moov atom moved to the front (+faststart), so Roon can read the index
// and duration from the first block it downloads; raw ADTS has neither.
const M4A = { format: 'ipod', ext: 'm4a', contentType: 'audio/mp4', args: ['-movflags', '+faststart'] };
const CODEC_FORMATS = {
    mp3:    { format: 'mp3',  ext: 'mp3',  contentType: 'audio/mpeg' },
    aac:    M4A,
    alac:   M4A,
    flac:   { format: 'flac', ext: 'flac', contentType: 'audio/flac' },
    vorbis: { format: 'ogg',  ext: 'ogg',  contentType: 'audio/ogg'  },
};

function formatForCodec(codec) {
    if (CODEC_FORMATS[codec]) return CODEC_FORMATS[codec];
    // WAV/AIFF and other raw PCM
    if (codec.startsWith('pcm_')) return { format: 'wav', ext: 'wav', contentType: 'audio/wav' };
    throw new Error(`audio codec '${codec}' cannot be streamed without transcoding ` +
                    `(supported: ${Object.keys(CODEC_FORMATS).join(', ')}, pcm)`);
}

async function probeCodec(input) {
    const { stdout } = await execFileAsync(config.ffprobePath, [
        '-v', 'error',
        '-select_streams', 'a:0',
        '-show_entries', 'stream=codec_name',
        '-of', 'csv=p=0',
        input,
    ]);
    const codec = stdout.trim();
    if (!codec) throw new Error(`no audio stream found in ${input}`);
    return codec;
}

async function remux(input, fmt, output) {
    await execFileAsync(config.ffmpegPath, [
        '-hide_banner', '-loglevel', 'error',
        '-y',
        '-i', input,
        '-map', '0:a:0',
        '-c:a', 'copy',
        ...(fmt.args || []),
        '-f', fmt.format,
        output,
    ]);
}

// Whether `file` is an MP4 with its index (moov box) before the audio data
// (mdat box), as Roon needs and as yt-dlp writes when it runs ffmpeg itself
// (+faststart). Such a file can be served as it is, without a remux.
function moovBeforeMdat(file) {
    let fd;
    try {
        fd = fs.openSync(file, 'r');
        const size = fs.fstatSync(fd).size;
        const header = Buffer.alloc(16);
        for (let pos = 0; pos + 8 <= size;) {
            const n = fs.readSync(fd, header, 0, 16, pos);
            const type = header.toString('latin1', 4, 8);
            if (pos == 0 && type != 'ftyp') return false;
            if (type == 'moov') return true;
            if (type == 'mdat') return false;
            let boxSize = header.readUInt32BE(0);
            if (boxSize == 1) {
                if (n < 16) return false;
                boxSize = Number(header.readBigUInt64BE(8));
            }
            if (boxSize < 8) return false;    // includes 0: box runs to end of file
            pos += boxSize;
        }
        return false;
    } catch (e) {
        return false;
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}

// Parses a single "bytes=start-end" range; returns null for no/unsupported
// ranges and false for unsatisfiable ones.
function parseRange(header, size) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(header || '');
    if (!m || (m[1] == '' && m[2] == '')) return null;
    let start, end;
    if (m[1] == '') {
        // suffix range: last N bytes
        start = Math.max(0, size - parseInt(m[2], 10));
        end = size - 1;
    } else {
        start = parseInt(m[1], 10);
        end = m[2] == '' ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
    }
    if (start >= size || start > end) return false;
    return { start, end };
}

function serveStream(req, res, cur) {
    _log(`Stream client connected: ${req.socket.remoteAddress} ${req.method} ${req.url} ${req.headers.range || ''}`);
    const headers = {
        'Content-Type':  cur.fmt.contentType,
        'Accept-Ranges': 'bytes',
        'ETag':          `"${cur.id}-${cur.size}"`,
        'Last-Modified': cur.mtime.toUTCString(),
    };

    const range = parseRange(req.headers.range, cur.size);
    if (range === false) {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${cur.size}` });
        return res.end();
    }

    let start = 0, end = cur.size - 1;
    if (range) {
        ({ start, end } = range);
        res.writeHead(206, {
            ...headers,
            'Content-Range':  `bytes ${start}-${end}/${cur.size}`,
            'Content-Length': end - start + 1,
        });
    } else {
        res.writeHead(200, { ...headers, 'Content-Length': cur.size });
    }
    if (req.method == 'HEAD') return res.end();

    const stream = fs.createReadStream(cur.file, { start, end });
    stream.on('error', (err) => {
        _log(`ERROR: reading ${cur.file}: ${err.message}`);
        res.destroy();
    });
    _streamResponses.add(res);
    res.on('close', () => {
        _streamResponses.delete(res);
        stream.destroy();
    });
    stream.pipe(res);
}

function removeFile(file) {
    try {
        fs.rmSync(file, { force: true });
    } catch (err) {
        _log(`WARNING: could not delete ${file}: ${err.message}`);
    }
}

// Starts the long-lived HTTP server. `routes(req, res)` handles any request
// that isn't for the current stream and returns true if it responded.
export async function createServer({ port = config.httpPort, logger, routes } = {}) {
    if (logger) _log = logger;
    const handler = async (req, res) => {
        try {
            const cur = _current;
            if (cur && req.url == cur.urlPath && (req.method == 'GET' || req.method == 'HEAD'))
                return serveStream(req, res, cur);
            if (routes && await routes(req, res)) return;
            res.writeHead(404);
            res.end();
        } catch (err) {
            _log(`ERROR: handling ${req.method} ${req.url}: ${err.stack || err.message}`);
            if (!res.headersSent) res.writeHead(500);
            res.end();
        }
    };
    const listen = (host, opts = {}) => new Promise((resolve, reject) => {
        const server = http.createServer(handler);
        server.once('error', reject);
        server.listen({ port, host, ...opts }, () => {
            server.off('error', reject);
            resolve(server);
        });
    });

    // Separate IPv4 and IPv6 listeners rather than one dual-stack socket:
    // Deno ignores ipv6Only: false, so '::' alone would be IPv6-only.
    _servers = [await listen('0.0.0.0')];
    try {
        _servers.push(await listen('::', { ipv6Only: true }));
    } catch (err) {
        _log(`Not listening on IPv6 (${err.code || err.message})`);
    }
    _log(`HTTP server listening on port ${port} (${_servers.map((s) => s.address().address).join(', ')})`);
}

export async function closeServer() {
    await stopStream();
    const servers = _servers;
    _servers = [];
    await Promise.all(servers.map((server) => {
        server.closeAllConnections();
        return new Promise((resolve) => server.close(() => resolve()));
    }));
}

// Makes `input` the current stream: served as it is if it's already an MP4
// with its index first, otherwise remuxed to a temp file. Returns the
// stream's full URL, which is unique per call: Roon caches downloads by URL
// (including failed attempts), and the content behind a given URL never
// changes.
//
// With `keepInput: false` the stream server takes ownership of `input` and
// deletes it once it's no longer needed, including when this throws.
export async function startStream({ input, keepInput = true, logger }) {
    if (logger) _log = logger;
    await stopStream();

    try {
        const codec = await probeCodec(input);
        const fmt = formatForCodec(codec);
        const id = Date.now().toString(36);
        let file = input;
        let removeOnStop = !keepInput;
        if (fmt === M4A && moovBeforeMdat(input)) {
            _log(`Input codec ${codec}, already MP4 with its index first: serving ${input} as is`);
        } else {
            fs.mkdirSync(config.tempDir, { recursive: true });
            file = path.join(config.tempDir, `stream-${id}.${fmt.ext}`);
            _log(`Input codec ${codec}: remuxing to ${fmt.format} (${fmt.contentType}) without transcoding`);
            try {
                await remux(input, fmt, file);
            } catch (err) {
                removeFile(file);
                throw new Error(`ffmpeg remux failed: ${err.stderr?.trim() || err.message}`);
            }
            if (!keepInput) removeFile(input);
            removeOnStop = true;
        }
        const stat = fs.statSync(file);
        _log(`Serving ${stat.size} bytes from ${file}`);

        _current = { urlPath: `/stream-${id}.${fmt.ext}`, file, removeOnStop, size: stat.size, mtime: stat.mtime, id, fmt };
        return `http://${config.streamHost}:${config.httpPort}${_current.urlPath}`;
    } catch (err) {
        if (!keepInput) removeFile(input);
        throw err;
    }
}

// Stops serving the current stream, drops its open connections and deletes
// its file if the stream server owns it.
export async function stopStream() {
    const cur = _current;
    _current = null;
    for (const res of _streamResponses) res.destroy();
    _streamResponses.clear();
    if (cur?.removeOnStop) removeFile(cur.file);
}
