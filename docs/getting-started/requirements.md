# Requirements

| Component | Version | Needed for |
| --- | --- | --- |
| Node.js | 22.12+ | the server (bundled in every release package except FreeBSD) |
| FFmpeg / ffprobe | 6+, 7.x recommended | everything: probing, previews, transcoding |
| Radarr | v4 (API v3) | movies |
| Sonarr | v4 (API v3) | series |
| Prowlarr | any recent | optional: raw indexer search |
| MakeMKV | 1.17+ (`makemkvcon`) | optional: disc ripping, full-disc releases |
| fre:ac | 1.1.7+ (`freaccmd`) | optional: music encodes, CD ripping, cue splitting |
| cdparanoia | any | optional: audio CD table of contents on Linux |
| Lidarr | v2 (API v1) | optional: music library |
| slskd | any recent | optional: Soulseek album search |

Notes:

- **FFmpeg must have the encoders you plan to use.** **System → Status** lists the ffmpeg version and every encoder
  it found; missing ones are flagged there and in the profile editor.
- **MakeMKV** decrypts commercial DVDs on its own. Blu-ray discs and images need a registered or current beta key.
- **macOS**: `brew install ffmpeg`, `brew install --cask freac`, MakeMKV from
  [makemkv.com](https://www.makemkv.com/). Rexarr finds the MakeMKV app bundle automatically.
- **Hardware encoding** needs the matching driver and an ffmpeg built for it — see
  [Transcoding](../guide/transcoding.md).
- On first launch, **System → Tools** checks for FFmpeg, fre:ac, MakeMKV and slskd and shows the install command
  for your platform (winget / Homebrew / apt) or the official download page.
