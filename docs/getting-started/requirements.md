# Requirements

## Hardware

Rexarr itself is a small server — it is **FFmpeg that needs the machine**. The numbers below are for the
transcoding you ask it to do; a Rexarr that only watches a library and rips the odd disc needs very little.

| | Minimum | Recommended |
| --- | --- | --- |
| CPU | 2 cores, x86-64 or arm64 | 8 cores or more — software x265 / SVT-AV1 is the whole workload |
| RAM | 2 GB | 8 GB (16 GB for 4K, or several encodes at once) |
| Disk for Rexarr | 2 GB: the app, its cache and metadata | SSD, 100 GB+ free for in-progress encodes and disc rips |
| Media storage | whatever your library needs | a Blu-ray remux is 20–60 GB, a DVD rip 4–8 GB |
| Optical drive | — | any DVD / Blu-ray drive for ripping; a UHD-capable drive for 4K discs |
| GPU | — | optional: NVENC / QuickSync / VAAPI / VideoToolbox for speed, at the cost of bitrate |
| Network | anything | wired gigabit when the media lives on a NAS |

- **RAM is per encode.** The Rexarr server sits at about 180 MB. One 1080p x265 encode peaks around 1 GB, one
  2160p HDR encode around 3.5 GB — so *Encodes at a time* × the per-encode figure is what you need on top.
- **Disk is per job.** An encode is written to the Transcodes folder and moved when it finishes, and a disc is
  ripped **and** encoded in the cache before the finished file is moved to the rip folder, so the cache has to hold
  the raw rip and the encode at the same time. Point `REXARR_TRANSCODE_DIR` / the rip directory at a roomy volume
  if the config disk is small — see [Storage and environment](../reference/storage.md).
- **A low-power NAS or a Raspberry Pi** runs Rexarr fine for library browsing, search and disc delivery, but
  software 4K encoding on one is measured in days. Use hardware encoding there, or encode on a desktop.

### What that means in practice

Measured on an Apple M1 Pro (10 cores, macOS 27, FFmpeg 9), one encode at a time. Your machine will differ — the
ratios are the useful part:

| Job | Speed | Peak RAM |
| --- | --- | --- |
| 1080p anime → x265 `medium`, CRF 20, 10-bit | 1.7× real time (a 24-minute episode in ~14 min) | 1.0 GB |
| 2160p HDR remux → x265 `medium`, CRF 20, 10-bit | 0.22× real time (a 2-hour film in ~9 h) | 3.5 GB |
| 1080p → HEVC VideoToolbox (hardware) | 7.3× real time | — |

Hardware encoding is roughly four times faster here and needs 20–40% more bitrate for the same quality, which is
why software encoding is the default for archiving remuxes — see [Transcoding](../guide/transcoding.md).

## Software

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

- **Operating systems**: Windows 10 / 11, macOS 11+ (Intel or Apple silicon), Linux on glibc or musl (x64, arm64,
  32-bit arm), FreeBSD, and Docker on amd64 / arm64 — see [Install from a release](install.md) and
  [Docker](docker.md).
- **FFmpeg must have the encoders you plan to use.** **System → Status** lists the ffmpeg version and every encoder
  it found; missing ones are flagged there and in the profile editor.
- **MakeMKV** decrypts commercial DVDs on its own. Blu-ray discs and images need a registered or current beta key.
- **macOS**: `brew install ffmpeg`, `brew install --cask freac`, MakeMKV from
  [makemkv.com](https://www.makemkv.com/). Rexarr finds the MakeMKV app bundle automatically.
- **Hardware encoding** needs the matching driver and an ffmpeg built for it — see
  [Transcoding](../guide/transcoding.md).
- On first launch, **System → Tools** checks for FFmpeg, fre:ac, MakeMKV and slskd and shows the install command
  for your platform (winget / Homebrew / apt) or the official download page.
