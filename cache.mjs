import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';

// Cache of yt-dlp downloads, so playing the same thing again skips the
// download. Files live in config.cacheDir, named by yt-dlp as
// <extractor>-<video id>.<ext>; index.json records each file's title,
// thumbnail, the URLs it was requested by, and when it was last played. When
// the files exceed config.cacheMaxMB, the least recently played are deleted.

const INDEX = 'index.json';
let _index = null;      // { entries: { [fileName]: { title, thumbnail, size, lastUsed, urls } } }
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

// Returns { file, title, thumbnail } for a URL that was cached before, and
// marks it as just used; otherwise null.
export function lookup(url) {
    if (!enabled()) return null;
    const entries = index().entries;
    for (const [name, e] of Object.entries(entries)) {
        if (!e.urls.includes(url)) continue;
        const file = path.join(config.cacheDir, name);
        if (!fs.existsSync(file)) {
            delete entries[name];
            save();
            return null;
        }
        e.lastUsed = Date.now();
        save();
        return { file, title: e.title, thumbnail: e.thumbnail };
    }
    return null;
}

// Records a download that yt-dlp wrote into the cache directory (or found
// already there, when requested by a different URL).
export function add(file, { url, title, thumbnail }) {
    const name = path.basename(file);
    const entries = index().entries;
    const e = entries[name] || { urls: [] };
    entries[name] = {
        title, thumbnail,
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

// Deletes the least recently used files until the cache fits in cacheMaxMB.
export function enforceLimit() {
    const entries = index().entries;
    const limit = config.cacheMaxMB * 1024 * 1024;
    let total = Object.values(entries).reduce((sum, e) => sum + e.size, 0);
    const oldestFirst = Object.entries(entries).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [name, e] of oldestFirst) {
        if (total <= limit) break;
        _log(`Cache over ${config.cacheMaxMB} MB: removing "${e.title}" (${name})`);
        delete entries[name];
        removeFile(name);
        total -= e.size;
    }
    save();
}
