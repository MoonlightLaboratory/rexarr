<p align="center">
  <img src="logo/rexarr.svg" alt="rexarr" width="128" height="128">
</p>

<h1 align="center">rexarr</h1>

<p align="center">
  <a href="https://github.com/MoonlightLaboratory/rexarr/releases"><img src="https://img.shields.io/badge/status-beta-e5a00d" alt="Beta"></a>
  <a href="https://github.com/MoonlightLaboratory/rexarr/releases"><img src="https://img.shields.io/github/v/release/MoonlightLaboratory/rexarr?include_prereleases&label=release" alt="Latest release"></a>
  <a href="https://github.com/MoonlightLaboratory/rexarr/actions/workflows/docker.yml"><img src="https://img.shields.io/github/actions/workflow/status/MoonlightLaboratory/rexarr/docker.yml?branch=main&label=docker" alt="Docker build"></a>
  <a href="LICENSE.md"><img src="https://img.shields.io/badge/license-GPL--3.0-blue" alt="License: GPL-3.0"></a>
</p>

> [!WARNING]
> **rexarr is in beta.** It works day to day, but settings, file layout and the API can still change between
> releases, and some integrations (Lidarr, Soulseek, audio CD ripping) have seen little real-world use. Keep
> backups (System → Backup), read the release notes before updating, and please
> [report what breaks](https://github.com/MoonlightLaboratory/rexarr/issues).

rexarr is a remux-first transcoding companion for Usenet and BitTorrent users of the \*arr stack. It sits next to
Radarr, Sonarr and Lidarr, finds Blu-ray remux and full-disc releases for the titles you choose, and re-encodes what
they import with FFmpeg – or fre:ac for music – using profiles you control. It can also rip discs with MakeMKV,
split album images, and find media on your disks that none of the \*arr apps manage.

## Getting Started

- [Installation with Docker](docs/README.md#docker)
- [Run from source](docs/README.md#run-from-source)
- [First-time setup](docs/README.md#setup)
- [Documentation](docs/README.md)
- [Requirements](docs/README.md#requirements)

## Support

[![GitHub Issues](https://img.shields.io/badge/GitHub-Issues-181717?logo=github)](https://github.com/MoonlightLaboratory/rexarr/issues)
[![GitHub Discussions](https://img.shields.io/badge/GitHub-Discussions-181717?logo=github)](https://github.com/MoonlightLaboratory/rexarr/discussions)

- Found a bug? [Open an issue](https://github.com/MoonlightLaboratory/rexarr/issues/new/choose) – System → Status → *Report an issue* fills in your version for you.
- Security problem? Please report it privately, see [SECURITY.md](SECURITY.md).

## Contributors & Developers

- [Contribution Guide](CONTRIBUTING.md)
- [How a profile becomes an ffmpeg command](docs/README.md#how-a-profile-becomes-an-ffmpeg-command)
- [Test bench (transcoding and disc ripping without hardware)](docs/README.md#test-bench-transcoding--disc-ripping-without-hardware)
- [Notes for AI coding agents](AGENTS.md)

## Features

### Current Features

- Web UI in the \*arr style – Movies, Series, Music, Search, Activity, Discs, Profiles, Settings and System
- Smart search across your library, TMDB / TVDB and AniDB, typo tolerant, understands `S01E05`, `2160p`, `remux`, `dv` and ids
- Remux-first release search through Radarr, Sonarr, Lidarr and Prowlarr, ranked by source quality
- Full-disc (ISO / BDMV / VIDEO_TS) releases ripped with MakeMKV after download, then encoded and imported
- Encoding profiles for x264, x265, SVT-AV1, libaom, VP9 and hardware encoders (VideoToolbox, NVENC, QuickSync, VAAPI, AMF)
- Built-in presets for movies, TV and anime, with HDR10 passthrough, audio / subtitle selection and font attachments
- Estimated output size for every profile before you encode
- Release-style output names (`Remux-2160p` → `Bluray-1080p`) with clean track metadata
- Automatic transcoding of new imports, with live progress, preview frames and the full FFmpeg log
- Disc ripping from physical drives and virtual drives (ISO files and folders)
- Music with Lidarr: fre:ac profiles using open-source encoders (FLAC, WavPack, MP3, Opus, Vorbis), audio CD ripping with MusicBrainz, MQA detection
- Soulseek (slskd) album search, and automatic splitting of image + cue downloads Lidarr cannot import
- Local media: finds movies, series and albums outside the \*arr apps, with TMDb, MusicBrainz and Cover Art Archive metadata
- Queue pause / resume, stall watchdog, free-space checks and network share health checks
- Path mappings, authentication, reverse proxy URL base, HTTPS, backups and scheduled tasks

## License

- [GNU GPL v3](LICENSE.md)
- Copyright 2026 MoonlightLaboratory, see [COPYRIGHT.md](COPYRIGHT.md)

rexarr is an independent project and is not affiliated with Sonarr, Radarr, Lidarr, Prowlarr, slskd, MakeMKV,
fre:ac, FFmpeg, TMDb or MusicBrainz.
