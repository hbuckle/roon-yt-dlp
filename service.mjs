import fs from 'node:fs';
import { config, prepareDirs, checkTools } from './config.mjs';
import * as re from './lib.mjs';
import * as controller from './controller.mjs';
import { createServer, closeServer } from './stream-server.mjs';
import { CONTROL_PAGE } from './control-page.mjs';

// Entry point for running as a Windows service (see packaging/). There is no
// console: playback is controlled from a web page / JSON API served on the
// same port as the audio streams.

const logger = (msg) => {
    if (msg) process.stdout.write(`${new Date().toISOString()} ${msg}\n`);
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
let logo = null;          // { path, type, data }

// The extension's logo, which Roon shows as the source's icon, and which is
// also the control page's favicon. logo.ico holds several sizes; Roon may not
// decode ICO, so the largest PNG-encoded one is served as /logo.png.
function loadLogo() {
    const ico = fs.readFileSync(new URL('./logo.ico', import.meta.url));
    let best = null;
    for (let i = 0, count = ico.readUInt16LE(4); i < count; i++) {
        const entry = 6 + i * 16;
        const width = ico[entry] || 256;
        const offset = ico.readUInt32LE(entry + 12);
        const data = ico.subarray(offset, offset + ico.readUInt32LE(entry + 8));
        if (data.subarray(0, 8).equals(PNG_SIGNATURE) && (!best || width > best.width)) best = { width, data };
    }
    return best ? { path: '/logo.png', type: 'image/png', data: best.data }
                : { path: '/logo.ico', type: 'image/x-icon', data: ico };
}

function sendJson(res, code, body) {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
}

async function readJson(req) {
    let body = '';
    for await (const chunk of req) {
        body += chunk;
        if (body.length > 64 * 1024) throw new Error('request too large');
    }
    const json = body ? JSON.parse(body) : {};
    if (typeof json != 'object' || json === null || Array.isArray(json)) throw new Error('body must be a JSON object');
    return json;
}

// Whether a Host header names this machine: an IP address, localhost, the
// computer name (bare or with a domain), or one of config.allowedHosts.
function isOwnHost(host) {
    let name;
    try {
        name = new URL(`http://${host}`).hostname.toLowerCase();
    } catch (e) {
        return false;
    }
    const computer = (process.env.COMPUTERNAME || '').toLowerCase();
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(name) || name.startsWith('[')
        || name == 'localhost'
        || (computer && (name == computer || name.startsWith(computer + '.')))
        || config.allowedHosts.includes(name);
}

// Web pages can send POSTs to LAN addresses. A text/plain body skips the CORS
// preflight, and DNS rebinding makes the request look same-origin. So a POST
// must be JSON (browsers then send a preflight, which fails because no CORS
// headers are sent), from this server's own page if it comes from a browser,
// and to a Host that is this machine. Returns [status, error], or null if the
// request is OK.
function rejectPost(req) {
    if (!isOwnHost(req.headers.host || ''))
        return [403, `host not allowed: ${req.headers.host} (add it to allowedHosts)`];
    const origin = req.headers.origin;
    if (origin) {
        let originHost = null;
        try { originHost = new URL(origin).host; } catch (e) { }
        if (originHost != req.headers.host) return [403, `cross-origin request from ${origin}`];
    }
    if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] || ''))
        return [415, 'Content-Type must be application/json'];
    return null;
}

async function routes(req, res) {
    const url = new URL(req.url, 'http://localhost');

    if (req.method == 'POST' && url.pathname.startsWith('/api/')) {
        const rejected = rejectPost(req);
        if (rejected) {
            sendJson(res, rejected[0], { error: rejected[1] });
            return true;
        }
    }

    if (req.method == 'GET' && logo && (url.pathname == logo.path || url.pathname == '/favicon.ico')) {
        res.writeHead(200, { 'Content-Type': logo.type, 'Cache-Control': 'max-age=86400' });
        res.end(logo.data);
        return true;
    }

    if (req.method == 'GET' && url.pathname == '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(CONTROL_PAGE);
        return true;
    }

    if (req.method == 'GET' && url.pathname == '/api/status') {
        sendJson(res, 200, controller.status());
        return true;
    }

    if (req.method == 'POST' && url.pathname == '/api/play') {
        let body;
        try {
            body = await readJson(req);
        } catch (err) {
            sendJson(res, 400, { error: `invalid request: ${err.message}` });
            return true;
        }
        const target = body.url;
        // Only web URLs: the API must not be able to read arbitrary local files.
        if (typeof target != 'string' || !/^https?:\/\//i.test(target)) {
            sendJson(res, 400, { error: 'url must be an http(s) URL' });
            return true;
        }
        // Optional zone_id plays in that zone (and makes it the selected one).
        if (body.zone_id) {
            try {
                controller.selectZone(body.zone_id);
            } catch (err) {
                sendJson(res, 400, { error: err.message });
                return true;
            }
        }
        const roon = controller.status().roon;
        if (!roon.paired || !roon.zone) {
            sendJson(res, 409, { error: !roon.paired
                ? 'not paired with a Roon Core: enable the extension in Roon > Settings > Extensions'
                : 'no zone selected' });
            return true;
        }
        // Downloads can take a while, so respond straight away and let the
        // client poll /api/status.
        controller.playUrl(target).catch((err) => logger(`ERROR: playing ${target}: ${err.message}`));
        sendJson(res, 202, controller.status());
        return true;
    }

    if (req.method == 'POST' && url.pathname == '/api/zone') {
        try {
            controller.selectZone((await readJson(req)).zone_id);
        } catch (err) {
            sendJson(res, 400, { error: err.message });
            return true;
        }
        sendJson(res, 200, controller.status());
        return true;
    }

    if (req.method == 'POST' && url.pathname == '/api/stop') {
        await controller.stop();
        sendJson(res, 200, controller.status());
        return true;
    }

    return false;
}

async function main() {
    prepareDirs();
    // node-roon-api keeps its pairing token and settings in config.json in
    // the working directory.
    process.chdir(config.dataDir);
    logger(`Data directory: ${config.dataDir}`);

    const problems = await checkTools();
    for (const p of problems) logger(`ERROR: required tool unavailable: ${p}`);

    re.init({
        logger,
        enableProtocolTrace: false,
        extensionOptions: {
            extension_id: 'hbuckle.roon.yt-dlp',
            display_name: 'Roon Connect yt-dlp',
            display_version: '1.0.0',
            publisher: 'hbuckle',
            email: 'h.buckle@outlook.com',
        },
    });
    try {
        logo = loadLogo();
    } catch (err) {
        logger(`WARNING: no logo for Roon to show: ${err.message}`);
    }
    controller.init({
        logger,
        name: 'Roon Connect yt-dlp',
        icon: logo && `http://${config.streamHost}:${config.httpPort}${logo.path}`,
    });
    await createServer({ port: config.httpPort, logger, routes });
    logger(`Control page: http://localhost:${config.httpPort}/`);

    let stopping = false;
    const shutdown = async (signal) => {
        if (stopping) return;
        stopping = true;
        logger(`Received ${signal}, shutting down`);
        try {
            await controller.stop();
            await closeServer();
        } finally {
            process.exit(0);
        }
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGBREAK', () => shutdown('SIGBREAK'));
}

main().catch((err) => {
    logger(`FATAL: ${err.stack || err.message}`);
    process.exit(1);
});
