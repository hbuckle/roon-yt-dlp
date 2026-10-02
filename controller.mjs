import fs from 'node:fs';
import * as re from './lib.mjs';
import { startStream, stopStream } from './stream-server.mjs';
import { downloadAudio } from './ytdlp.mjs';
import * as cache from './cache.mjs';

// Play/stop logic shared by the service (web page/API) and the console test
// app. Only one play runs at a time: a new play or a stop cancels the one in
// progress (killing yt-dlp if it is still downloading) and waits for it to
// finish before going on.

// Roon requires an icon for every session. Used when the media has no
// thumbnail (e.g. local files) and init() wasn't given one.
const DEFAULT_ICON = 'http://dev.roonlabs.com/public/puppy.png';

let _log = (msg) => { };
let _brand = { name: 'Roon Streamer', icon: DEFAULT_ICON };

let _status = { state: 'idle', title: null, error: null };
let _job = null;          // { abort: AbortController, done: Promise }

export function init({ logger, name, icon } = {}) {
    if (logger) _log = logger;
    if (name) _brand.name = name;
    if (icon) _brand.icon = icon;
}

export function status() {
    return { ..._status, roon: { ...re.status(), zones: re.zones() } };
}

// Changing zone stops anything playing in the previous zone.
export function selectZone(zoneId) {
    if (!re.status().paired) throw new Error('not paired with a Roon Core: enable the extension in Roon > Settings > Extensions');
    re.selectZone(zoneId);
}

function setStatus(state, title = _status.title, error = null) {
    _status = { state, title, error };
}

async function cancelJob() {
    const job = _job;
    if (!job) return;
    job.abort.abort();
    await job.done.catch(() => { });
}

async function run(title, work) {
    const roon = re.status();
    if (!roon.paired) throw new Error('not paired with a Roon Core: enable the extension in Roon > Settings > Extensions');
    if (!roon.zone) throw new Error('no zone selected: choose one on the control page or in the extension settings in Roon');

    await cancelJob();
    const abort = new AbortController();
    const job = { abort, done: null };
    _job = job;
    job.done = (async () => {
        try {
            const { url, icon } = await work(abort.signal, (s, t) => setStatus(s, t));
            if (abort.signal.aborted) return;
            _log(`Playing "${_status.title}" from ${url}`);
            re.play({ url, name: _brand.name, line1: _status.title, icon: icon || _brand.icon });
            setStatus('playing');
        } catch (err) {
            if (abort.signal.aborted) return;
            setStatus('error', _status.title, err.message);
            throw err;
        } finally {
            if (_job === job) _job = null;
        }
    })();
    return job.done;
}

// Plays a local file (or anything ffprobe/ffmpeg can open) without
// transcoding.
export function playFile(input, title = input) {
    return run(title, async (signal, update) => {
        update('preparing', title);
        return { url: await startStream({ input, logger: _log }) };
    });
}

// Downloads the audio of a web page (YouTube etc.) with yt-dlp and plays it.
// Downloads are kept in the cache (see cache.mjs) so replays skip yt-dlp.
export function playUrl(url) {
    return run(url, async (signal, update) => {
        cache.setLogger(_log);
        const cached = cache.lookup(url);
        if (cached) {
            _log(`Cache hit: "${cached.title}"`);
            update('preparing', cached.title);
            return {
                url:  await startStream({ input: cached.file, logger: _log }),
                icon: cached.thumbnail,
            };
        }

        update('downloading', url);
        const useCache = cache.enabled();
        const download = await downloadAudio(url, { logger: _log, signal, cache: useCache });
        if (useCache) cache.add(download.file, { url, title: download.title, thumbnail: download.thumbnail });
        try {
            if (signal.aborted) throw new Error('cancelled');
            update('preparing', download.title);
            return {
                url:  await startStream({ input: download.file, logger: _log }),
                icon: download.thumbnail,
            };
        } catch (err) {
            // e.g. a codec that can't be streamed: no point keeping it
            if (useCache && !signal.aborted) cache.remove(download.file);
            throw err;
        } finally {
            // startStream has already remuxed it into its own temp file
            if (useCache) cache.enforceLimit();
            else fs.rmSync(download.file, { force: true });
        }
    });
}

export async function stop() {
    await cancelJob();
    re.stop();
    await stopStream();
    setStatus('idle', null);
}
