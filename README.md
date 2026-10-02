Roon Connect yt-dlp
==

A Roon extension that plays the audio from YouTube (and other sites [yt-dlp](https://github.com/yt-dlp/yt-dlp) supports) in a Roon zone. It runs as a Windows service and is controlled from a web page (`http://<host>:8081/`) or a small JSON API. It started from [roon-connect-stream-example](https://github.com/RoonLabs/roon-connect-stream-example).

## How it works

yt-dlp downloads only the audio, and only AAC, because Roon can't play Opus. A URL with no AAC audio fails with an error from yt-dlp. Playlist URLs play only the single video. Downloads are cached (see [packaging/README-service.md](packaging/README-service.md#download-cache)).

The audio is remuxed with ffmpeg, not transcoded, into a temp file. That file is served over HTTP with an exact `Content-Length` and support for Range requests, on the same port as the control page, at a new URL for every play (Roon caches downloads by URL, including failed attempts). Roon can open the stream URL more than once, for example a probe connection and then the playback connection, and every connection reads the same complete file. The media title and thumbnail are shown in Roon.

`ffprobe` detects the input codec, and the container and `Content-Type` are chosen to carry that codec unchanged:

| Input codec | Streamed as | Content-Type |
|---|---|---|
| MP3 | MP3 | `audio/mpeg` |
| AAC, ALAC | M4A (index at the start) | `audio/mp4` |
| FLAC | FLAC | `audio/flac` |
| Vorbis | Ogg | `audio/ogg` |
| PCM | WAV | `audio/wav` |

Any other codec is rejected with an error rather than transcoded.

By default Roon is told to fetch the audio from `127.0.0.1`, which only works when the service runs on the Roon Server machine. Otherwise set `ROON_STREAMER_HOST` (or `streamHost` in `settings.json`) to this machine's LAN IP.

## Development

The project uses [Deno](https://deno.com) 2.9 or later as package manager and runtime. ffmpeg, ffprobe and yt-dlp must be on your `PATH`.

```sh
deno install
deno task service
```

`deno task service` runs the service in a console with the same permissions as the compiled build. It keeps its data (Roon pairing, cache, temp files) in `%ProgramData%\RoonStreamer`, or in `ROON_STREAMER_DATA` if that's set. Then enable **Roon Connect yt-dlp** in Roon > Settings > Extensions.

The Roon API packages are vendored in `vendor/`, because Deno can't install `github:` dependencies. See [vendor/README.md](vendor/README.md).

## Build and install as a Windows service

```powershell
deno task package
```

This produces `dist\RoonStreamer.zip`, which contains:
- `roon-streamer.exe`: the service compiled to a single executable by `deno compile`. Its Deno permissions are fixed at build time: file access only to `C:\ProgramData\RoonStreamer`, plus network, environment variables, OS network info and running subprocesses. Subprocesses (ffmpeg, ffprobe, yt-dlp) aren't sandboxed.
- [WinSW](https://github.com/winsw/winsw), as `RoonStreamer.exe`. It's downloaded on the first build and checked against a pinned SHA256.
- The install scripts.

The service runs as LocalService. ffmpeg, ffprobe and yt-dlp are not included. See [packaging/README-service.md](packaging/README-service.md) for installing it, the settings and the API.

## Source layout

| File | Role |
|---|---|
| `service.mjs` | Entry point: control page, JSON API, startup and shutdown |
| `controller.mjs` | Play/stop logic |
| `lib.mjs` | Roon API: pairing, zones, settings, audio input sessions |
| `stream-server.mjs` | HTTP server: remuxes audio with ffmpeg and serves it to Roon |
| `ytdlp.mjs` | Downloads audio with yt-dlp |
| `cache.mjs` | Download cache |
| `config.mjs` | Settings from environment variables, `settings.json` or defaults |
| `control-page.mjs` | The web page |
