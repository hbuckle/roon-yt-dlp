# Roon Streamer service

Plays the audio from YouTube (and other sites yt-dlp supports) in a Roon zone. It runs as a Windows service on the Roon Server machine, and you control it from a web page.

## Requirements

- Windows 10/11 or Windows Server, on the same network as Roon Server. If it isn't the Roon Server machine itself, set `ROON_STREAMER_HOST` in `RoonStreamer.xml` (or `streamHost` in `settings.json`) to this machine's LAN IP: by default Roon is told to fetch the audio from `127.0.0.1`.
- **ffmpeg, ffprobe and yt-dlp.** These are not included. Either:
  - put them on the **system** PATH (System Properties > Environment Variables > System variables). The service runs as LocalService, which does not see your user PATH or files in your user profile, so a `winget install` done as a normal user usually is not enough; or
  - set their full paths in `RoonStreamer.xml` (the `FFMPEG_PATH`, `FFPROBE_PATH` and `YTDLP_PATH` entries).

## Install

1. Unzip the package.
2. Open PowerShell **as Administrator** in the unzipped folder, and run:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install.ps1
   ```
   This installs to `C:\Program Files\RoonStreamer`, gives the LocalService account write access to `C:\ProgramData\RoonStreamer`, starts the service, and adds firewall rules that allow the local subnet only. Use `-InstallDir` or `-Port` to change those defaults. Running it again upgrades in place.
3. In Roon, go to **Settings > Extensions**. Enable **Roon Connect yt-dlp**, open its **Settings**, and choose the zone to play in.

## Use

Open `http://<roon-server>:8081/` from any device on your network. Paste a URL and press **Play**; **Stop** ends playback. The audio downloads first, which can take a few seconds for a long video.

The same actions are available as a JSON API, for scripts or phone shortcuts. POSTs must send `Content-Type: application/json`, and must be addressed to this machine by IP address, `localhost` or its computer name; add any other name (such as a DNS alias) to `allowedHosts`. This stops other web pages opened on your network from controlling it.

```
POST /api/play    {"url": "https://www.youtube.com/watch?v=...", "zone_id": "..."}   (zone_id optional)
POST /api/zone    {"zone_id": "..."}
POST /api/stop
GET  /api/status  (includes roon.zones: the zone IDs and names)
```

Choosing a zone on the page or with `/api/zone` changes the same setting as the extension's Zone setting in Roon, and is remembered across restarts.

## Files

| What | Where |
|---|---|
| Program | `C:\Program Files\RoonStreamer` |
| Roon pairing (`config.json`), optional `settings.json`, temp files | `C:\ProgramData\RoonStreamer` |
| Logs | `C:\ProgramData\RoonStreamer\logs` |

Optional `settings.json` keys: `httpPort`, `streamHost`, `allowedHosts` (an array), `ffmpegPath`, `ffprobePath`, `ytdlpPath`, `tempDir`, `cacheDir`, `cacheMaxMB`. Environment variables set in `RoonStreamer.xml` take priority over it. The service's own code can only read and write files under `C:\ProgramData\RoonStreamer` (a Deno sandbox rule fixed when it's built), so `tempDir` and `cacheDir` must stay inside that folder. The sandbox doesn't apply to ffmpeg, ffprobe and yt-dlp, which run with the full rights of the LocalService account.

## Download cache

Downloaded audio is kept in `C:\ProgramData\RoonStreamer\cache`, so playing the same URL again starts almost at once. A different URL for the same video is recognised too. For YouTube URLs (`youtu.be/...`, `youtube.com/watch?v=...`, `/shorts/...`) that's instant; for other sites it takes a second or two for yt-dlp to look it up, but doesn't download again.

The cache is limited to `cacheMaxMB` (default 2048 MB). When a download takes it over that, the least recently played files are deleted until it fits again. A single file bigger than the limit is kept only until the next download. Set `cacheMaxMB` to `0` to turn caching off, or set the `ROON_STREAMER_CACHE_MB` environment variable in `RoonStreamer.xml`. To clear the cache, stop the service and delete the folder. If you change the port, re-run `install.ps1 -Port <port>` so the firewall rule matches.

## Keeping yt-dlp working

Sites change often, and an old yt-dlp eventually stops working with them. Update it regularly with `yt-dlp -U`, run as an administrator if it's installed under Program Files.

The single-file `yt-dlp.exe` unpacks itself every time it runs, which adds a second or so before each download starts. A yt-dlp installed with `pip` (or an unpacked build, if the release page offers one) starts faster; point `YTDLP_PATH` at it.

## Uninstall

Run `uninstall.ps1` from `C:\Program Files\RoonStreamer` as Administrator. It removes the service and firewall rules. Delete the two folders above for a full removal.
