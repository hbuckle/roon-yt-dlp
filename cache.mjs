import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';

// Cache of yt-dlp downloads, so playing the same thing again skips the
// download. Files live in config.cacheDir, named by yt-dlp as
// <extractor>-<video id>.<ext>; index.json records each file's title,
// artist, site, thumbnail, the URLs it was requested by, and when it was last
// played. When the files exceed config.cacheMaxMB, the least recently played are deleted.

const INDEX = 'index.json';
let _index = null;      // { entries: { [fileName]: { title, artist, site, thumbnail, size, lastUsed, urls } } }
let _log = (msg) => { };

export function enabled() {
    return config.cacheMaxMB > 0;
}

export function setLogger(logger) {
    if (logger) _log = logger;
}

function index() {
    if (_index) return _index;
    fs.mkdirSync(config.cacheDir, { recursive: true });
    try {
        _index = JSON.parse(fs.readFileSync(path.join(config.cacheDir, INDEX), 'utf8'));
    } catch (e) {
        _index = { entries: {} };
    }
    // Reconcile with the disk: forget entries whose file is gone, and delete
    // download files the index doesn't know (e.g. partial downloads from a
    // crash). Only yt-dlp's file types are touched, in case cacheDir is shared.
    const files = new Set(fs.readdirSync(config.cacheDir));
    for (const name of Object.keys(_index.entries))
        if (!files.has(name)) delete _index.entries[name];
    for (const name of files)
        if (!_index.entries[name] && isDownloadFile(name)) removeFile(name);
    save();
    return _index;
}

// Files yt-dlp writes for an AAC download: the audio (.m4a/.mp4/.aac), and
// partial or intermediate files (.part, .ytdl, .temp.m4a).
export function isDownloadFile(name) {
    return /\.(m4a|mp4|aac|part|ytdl)$/i.test(name);
}

function save() {
    const file = path.join(config.cacheDir, INDEX);
    fs.writeFileSync(file + '.tmp', JSON.stringify(_index, null, 2));
    fs.renameSync(file + '.tmp', file);
}

function removeFile(name) {
    try {
        fs.rmSync(path.join(config.cacheDir, name), { force: true });
    } catch (err) {
        _log(`WARNING: could not delete cached ${name}: ${err.message}`);
    }
}

// The video ID in the common YouTube URL forms, or null.
function youtubeId(url) {
    let u;
    try {
        u = new URL(url);
    } catch (e) {
        return null;
    }
    const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
    let id = null;
    if (host == 'youtu.be') id = u.pathname.slice(1);
    else if (host == 'youtube.com')
        id = u.pathname == '/watch' ? u.searchParams.get('v') : /^\/(shorts|live|embed)\/([^/]+)/.exec(u.pathname)?.[2];
    return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : null;
}

// Returns { file, title, artist, site, thumbnail } for a URL that was cached before, and
// marks it as just used; otherwise null. A YouTube URL also finds the video
// when it was cached under a different URL (e.g. youtu.be/... and
// youtube.com/watch?v=...), from the file name yt-dlp gave it, so yt-dlp
// doesn't need to run.
export function lookup(url) {
    if (!enabled()) return null;
    const entries = index().entries;
    let name = Object.keys(entries).find((n) => entries[n].urls.includes(url));
    const id = !name && youtubeId(url);
    if (id) name = Object.keys(entries).find((n) => n.startsWith(`Youtube-${id}.`));
    if (!name) return null;

    const e = entries[name];
    const file = path.join(config.cacheDir, name);
    if (!fs.existsSync(file)) {
        delete entries[name];
        save();
        return null;
    }
    e.lastUsed = Date.now();
    if (!e.urls.includes(url)) e.urls.push(url);
    save();
    return { file, title: e.title, artist: e.artist || null, site: e.site || null, thumbnail: e.thumbnail };
}

// Records a download that yt-dlp wrote into the cache directory (or found
// already there, when requested by a different URL).
export function add(file, { url, title, artist, site, thumbnail }) {
    const name = path.basename(file);
    const entries = index().entries;
    const e = entries[name] || { urls: [] };
    entries[name] = {
        title, artist, site, thumbnail,
        size: fs.statSync(file).size,
        lastUsed: Date.now(),
        urls: e.urls.includes(url) ? e.urls : [...e.urls, url],
    };
    save();
}

export function remove(file) {
    const name = path.basename(file);
    delete index().entries[name];
    removeFile(name);
    save();
}

// Deletes the least recently used files until the cache fits in cacheMaxMB,
// except `keepFile` (the one playing), which goes on a later call if it alone
// is over the limit.
export function enforceLimit(keepFile) {
    const entries = index().entries;
    const limit = config.cacheMaxMB * 1024 * 1024;
    const keep = keepFile && path.basename(keepFile);
    let total = Object.values(entries).reduce((sum, e) => sum + e.size, 0);
    const oldestFirst = Object.entries(entries).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [name, e] of oldestFirst) {
        if (total <= limit) break;
        if (name == keep) continue;
        _log(`Cache over ${config.cacheMaxMB} MB: removing "${e.title}" (${name})`);
        delete entries[name];
        removeFile(name);
        total -= e.size;
    }
    save();
}
