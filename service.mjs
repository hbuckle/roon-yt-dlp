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
    return body ? JSON.parse(body) : {};
}

async function routes(req, res) {
    const url = new URL(req.url, 'http://localhost');

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
            website: 'https://github.com/RoonLabs/roon-connect-stream-example',
        },
    });
    controller.init({ logger, name: 'Roon Connect yt-dlp' });
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
