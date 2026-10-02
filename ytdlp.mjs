import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { config } from './config.mjs';

// Kills a process and its children. yt-dlp starts ffmpeg itself (e.g. to fix
// up the M4A container), and on Windows killing yt-dlp alone leaves that
// ffmpeg running.
function killTree(proc) {
    if (process.platform == 'win32')
        execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], () => {});
    else
        proc.kill('SIGKILL');
}

function removeMatching(dir, test) {
    try {
        for (const f of fs.readdirSync(dir))
            if (test(f)) fs.rmSync(path.join(dir, f), { force: true });
    } catch (e) { }
}

// Downloads the audio-only stream for `url` with yt-dlp, without converting
// it, and returns the downloaded file path and the media title. Only AAC is
// accepted: Roon can't play Opus, which is the other common audio-only format.
// Aborting `signal` kills yt-dlp and removes any partial download.
//
// With `cache`, the file goes in config.cacheDir named by site and video ID,
// so a second URL for the same video finds it there and yt-dlp skips the
// download. Otherwise it goes in the temp directory under a unique name.
export async function downloadAudio(url, { logger, signal, cache = false } = {}) {
    const log = logger || ((msg) => {});
    const dir = cache ? config.cacheDir : config.tempDir;
    const prefix = `yt-${Date.now().toString(36)}.`;
    const template = cache ? '%(extractor_key)s-%(id)s.%(ext)s' : `${prefix}%(ext)s`;
    // this download's partial files (only one download runs at a time)
    const isPartial = cache ? (f) => /\.(part|ytdl)$|\.temp\./i.test(f) : (f) => f.startsWith(prefix);
    fs.mkdirSync(dir, { recursive: true });

    const args = [
        // ignore yt-dlp.conf files, which could add options such as --exec
        '--ignore-config',
        '--no-playlist',
        '--no-progress',
        '-f', 'bestaudio[acodec^=mp4a]',
        '-o', path.join(dir, template),
        '--restrict-filenames',
        '--no-simulate',
        '--encoding', 'utf-8',
        // one line of JSON, so titles can't be confused with other output
        '--print', 'after_move:%(.{title,thumbnail,thumbnails,filepath})j',
    ];
    if (config.ffmpegPath != 'ffmpeg') args.push('--ffmpeg-location', config.ffmpegPath);
    args.push('--', url);

    log(`yt-dlp: downloading audio from ${url}`);
    const stdout = await new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new Error('cancelled'));
        const proc = spawn(config.ytdlpPath, args, {
            windowsHide: true,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        });
        let out = '', err = '';
        proc.stdout.on('data', (d) => out += d);
        proc.stderr.on('data', (d) => err += d);
        const onAbort = () => killTree(proc);
        signal?.addEventListener('abort', onAbort, { once: true });
        proc.on('error', (e) => {
            signal?.removeEventListener('abort', onAbort);
            reject(e.code == 'ENOENT' ? new Error(`yt-dlp not found (${config.ytdlpPath})`) : e);
        });
        proc.on('close', (code) => {
            signal?.removeEventListener('abort', onAbort);
            if (signal?.aborted) reject(new Error('cancelled'));
            else if (code != 0) reject(new Error(`yt-dlp failed: ${err.trim() || `exit code ${code}`}`));
            else resolve(out);
        });
    }).catch((e) => {
        removeMatching(dir, isPartial);
        throw e;
    });

    let info = {};
    try {
        info = JSON.parse(stdout.trim().split(/\r?\n/).pop());
    } catch (e) {
        log(`yt-dlp: could not parse metadata: ${e.message}`);
    }
    // --restrict-filenames keeps the printed path ASCII, so console encoding
    // can't mangle it; check it really is a finished file in `dir`.
    const name = info.filepath && path.basename(info.filepath);
    const file = name && !isPartial(name) && fs.existsSync(path.join(dir, name)) ? path.join(dir, name) : null;
    if (!file) {
        removeMatching(dir, isPartial);
        throw new Error('yt-dlp finished but no downloaded file was found');
    }
    const title = info.title || url;
    const thumbnail = await pickThumbnail(info);
    log(`yt-dlp: downloaded "${title}" to ${file}${thumbnail ? `, thumbnail ${thumbnail}` : ''}`);
    return { file, title, thumbnail };
}

// yt-dlp's default `thumbnail` is often WebP (e.g. YouTube's vi_webp), which
// Roon may not display, so prefer JPEG/PNG from the full list. yt-dlp sorts
// `thumbnails` worst to best but doesn't check they exist (YouTube's
// maxresdefault.jpg is missing for many videos), so check them all at once
// and take the best one that exists.
async function pickThumbnail(info) {
    const isImage = (url) => {
        try {
            return /\.(jpe?g|png)$/i.test(new URL(url).pathname);
        } catch (e) {
            return false;
        }
    };
    const candidates = (info.thumbnails || []).map((t) => t?.url).filter(isImage).reverse();
    const exists = await Promise.all(candidates.slice(0, 5).map(async (url) => {
        try {
            return (await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(2000) })).ok;
        } catch (e) {
            return false;
        }
    }));
    const best = exists.indexOf(true);
    return best >= 0 ? candidates[best] : info.thumbnail || null;
}
