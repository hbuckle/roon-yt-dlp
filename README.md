Roon Connect Stream Example
==


## Quick start guide

### Running this sample

The project uses [Deno](https://deno.com) 2.9 or later as package manager and runtime:

```sh
deno install
deno task dev
```

The Roon API packages are vendored in `vendor/`, because Deno can't install `github:` dependencies. See [vendor/README.md](vendor/README.md).

### Getting it connected to Roon

1. Open Roon
2. In Roon, go to Settings > Extensions
3. This extension should be listed. Enable it by hitting the `Enable` button next to the "Roon Connect Stream Example".
4. Hit the `Settings` button (it's where the `Enable` button used to be located), and select the audio output you want this example to stream to.
5. Go back to Home in Roon make sure Roon has that audio output selected in the bottom bar. This will be useful to see stuff when you start playing audio.


### Using it

Back in the console where you ran this sample:

1. Hit enter a few times to ensure you see the prompt.
2. You can type `play http://strm112.1.fm/dubstep_mobile_mp3` and hit enter. It will take a few seconds to start streaming/buffering, but you should hear Roon playing this stream and see your brand taking over the bottom bar.
3. You can type `help` for more commands.

### Streaming from ffmpeg

`stream <input> [port]` uses `ffmpeg` to copy the audio from the file `<input>` into a temporary file, without transcoding. It serves that file, with an exact `Content-Length` and support for Range requests, from a small HTTP server at `http://<this machine's LAN IP>:<port>/stream-<id>.<ext>` (default port 8081). Each `stream` command gets a new URL, because Roon caches downloads by URL, including failed attempts. It then tells Roon to play that URL. For example:

```
stream ./test.mp3
```

Roon can open the stream URL more than once (for example, a probe connection and then the playback connection). The server handles that, because every connection reads the same complete file. `ffmpeg -listen 1` does not, and fails with a connection reset. Inputs with no end, such as internet radio URLs, aren't supported, because the whole input is copied before playback starts. The temp file is deleted on `stop` or `exit`.

The relay uses `ffprobe` to detect the input codec, then picks a container and `Content-Type` that carry that codec unchanged:

| Input codec | Streamed as | Content-Type |
|---|---|---|
| MP3 | MP3 | `audio/mpeg` |
| AAC, ALAC (e.g. .m4a, .aac) | M4A (index at the start) | `audio/mp4` |
| FLAC | FLAC | `audio/flac` |
| Vorbis | Ogg | `audio/ogg` |
| PCM (e.g. .wav, .aiff) | WAV | `audio/wav` |

Any other codec (Opus, AC-3, WMA, ...) is rejected with an error rather than transcoded.

### Streaming from YouTube and other sites

`yt <url> [port]` uses [yt-dlp](https://github.com/yt-dlp/yt-dlp) to download only the audio from `<url>`, then serves it to Roon the same way as `stream`. The audio isn't converted, and only AAC is downloaded, because Roon can't play Opus. A URL with no AAC audio fails with an error from yt-dlp. The media title is shown in Roon. Playlist URLs play only the single video. The downloaded file is deleted once the audio has been copied.

```
yt https://www.youtube.com/watch?v=...
```

Requirements:
- `ffmpeg` and `ffprobe` must be on your `PATH`, and `yt-dlp` too for `yt` (`winget install yt-dlp`).
- The Roon Core must be able to reach this machine on the port, so allow inbound TCP through your firewall. Windows prompts for Node.js the first time.

## Run as a Windows service

The same features can run unattended as a Windows service on the Roon Server machine, controlled from a web page (`http://<roon-server>:8081/`) or a small JSON API instead of the console. Roon then fetches the audio from `127.0.0.1`, so no IP address needs setting.

Build the package (needs network access the first time, to download [WinSW](https://github.com/winsw/winsw)):

```powershell
deno task package
```

This produces `dist\RoonStreamer.zip` containing:
- `roon-streamer.exe`: the service compiled to a single executable by `deno task compile`, with no separate Node install needed. Its permissions are fixed at build time: file access only to `C:\ProgramData\RoonStreamer`, plus network, environment variables, OS network info and running subprocesses.
- WinSW, as `RoonStreamer.exe`.
- The install scripts.

`deno task service` runs the same code in a console with the same permissions, for debugging. ffmpeg, ffprobe and yt-dlp are not included. See [packaging/README-service.md](packaging/README-service.md) for installing it and providing those tools.

Source layout:

| File | Role |
|---|---|
| `service.mjs` | Service entry point: control page, JSON API, startup and shutdown |
| `controller.mjs` | Play/stop logic |
| `stream-server.mjs` | HTTP server: remuxes audio with ffmpeg and serves it to Roon |
| `ytdlp.mjs` | Downloads audio with yt-dlp |
| `config.mjs` | Settings from environment variables, `settings.json` or defaults |
