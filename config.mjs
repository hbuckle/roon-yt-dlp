import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Settings come from (highest priority first) environment variables,
// <dataDir>\settings.json, then the defaults below. ffmpeg, ffprobe and
// yt-dlp are distributed separately, so their paths are configurable and
// default to whatever is on PATH.

const dataDir = process.env.ROON_STREAMER_DATA
    || path.join(process.env.ProgramData || 'C:\\ProgramData', 'RoonStreamer');

function readSettingsFile() {
    try {
        return JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
    } catch (e) {
        if (e.code != 'ENOENT') throw new Error(`invalid ${path.join(dataDir, 'settings.json')}: ${e.message}`);
        return {};
    }
}

function load() {
    const file = readSettingsFile();
    const env = process.env;
    return {
        dataDir,
        tempDir:     env.ROON_STREAMER_TEMP || file.tempDir     || path.join(dataDir, 'tmp'),
        cacheDir:    env.ROON_STREAMER_CACHE_DIR || file.cacheDir || path.join(dataDir, 'cache'),
        // Downloads are kept for replay until the cache exceeds this; 0 disables it.
        cacheMaxMB:  parseInt(env.ROON_STREAMER_CACHE_MB ?? file.cacheMaxMB ?? 2048, 10),
        httpPort:    parseInt(env.ROON_STREAMER_PORT || file.httpPort || 8081, 10),
        streamHost:  env.ROON_STREAMER_HOST || file.streamHost  || '127.0.0.1',
        ffmpegPath:  env.FFMPEG_PATH        || file.ffmpegPath  || 'ffmpeg',
        ffprobePath: env.FFPROBE_PATH       || file.ffprobePath || 'ffprobe',
        ytdlpPath:   env.YTDLP_PATH         || file.ytdlpPath   || 'yt-dlp',
        // Extra host names (e.g. a DNS alias) the control API accepts in the
        // Host header, besides IP addresses, localhost and the computer name.
        allowedHosts: (env.ROON_STREAMER_ALLOWED_HOSTS?.split(',') || file.allowedHosts || [])
            .map((h) => h.trim().toLowerCase()).filter(Boolean),
    };
}

export const config = load();

// Prepares the data and temp directories; files left in the temp directory
// belong to a previous run (e.g. one that crashed) and are removed.
export function prepareDirs() {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.rmSync(config.tempDir, { recursive: true, force: true });
    fs.mkdirSync(config.tempDir, { recursive: true });
}

// Runs each external tool once so a missing or broken install is reported at
// startup instead of on the first play. Returns a list of problems.
export async function checkTools() {
    const tools = [
        ['ffmpeg',  config.ffmpegPath,  ['-version']],
        ['ffprobe', config.ffprobePath, ['-version']],
        ['yt-dlp',  config.ytdlpPath,   ['--version']],
    ];
    const problems = [];
    for (const [name, exe, args] of tools) {
        try {
            await execFileAsync(exe, args, { timeout: 30000 });
        } catch (err) {
            problems.push(`${name} (${exe}): ${err.code == 'ENOENT' ? 'not found' : err.message}`);
        }
    }
    return problems;
}
