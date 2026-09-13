# rexarr

**Remux-first transcoding for the \*arr stack.** rexarr sits next to Radarr and Sonarr, finds
Blu-ray remux releases for the titles you pick, and re-encodes them with FFmpeg using profiles you
control – container, video encoder, quality, audio encoder, subtitles – with built-in presets for
movies, TV and anime.

```
Search (Radarr / Sonarr / Prowlarr)  →  remux-only results  →  Grab
        ↓
*arr downloads & imports the remux
        ↓
rexarr notices the import  →  ffprobe  →  ffmpeg with your profile  →  optional replace + rescan
```

## Features

- **Web UI in the \*arr style** – Movies, Series, Search, Activity, Profiles, Settings, System.
- **Remux-only search** – interactive search through Radarr / Sonarr (and raw Prowlarr search),
  filtered to `Remux-1080p`, `Remux-2160p`, `Bluray-1080p Remux`, `REMUX` titles, etc.
- **Automatic pipeline** – grab a release, rexarr polls the \*arr app until the file is imported,
  then queues the encode. Season packs expand into one job per episode.
- **Library view** – see which movies / episodes already have a remux on disk and transcode them
  (single, multi-select, whole season).
- **Profiles** – container (MKV / MP4 / WebM / MOV), video encoder (x264, x265, SVT-AV1, libaom,
  VP9, VideoToolbox, NVENC, QuickSync, VAAPI, AMF, or copy), CRF / CQ / quality, preset, tune,
  pixel format (8 / 10-bit), downscale, HDR10 passthrough, audio encoder (copy, AAC, Opus, E-AC-3,
  AC-3, FLAC, TrueHD) with bitrate / channels / language selection / commentary dropping,
  subtitle handling (copy, text-only, burn-in, none) with font attachments for anime, output
  directory / suffix / replace original / rescan in \*arr.
- **Built-in presets** – Anime x265 10-bit (animation tune, jpn+eng Opus, fonts kept), Anime
  SVT-AV1, Movie 4K HDR, Movie 1080p, Film grain, TV 1080p, Web MP4, VideoToolbox, NVENC,
  audio-only re-encode. Clone any preset to customise it.
- **Live progress** – percent, fps, speed, ETA and the full ffmpeg log streamed to the UI.
- **Command preview** – see the exact ffmpeg command a profile produces, against a sample UHD
  remux or a real file on disk.
- **Path mappings** – translate Docker / remote \*arr paths to local paths.
- **Disc ripping** – ARM-style: insert a disc, rexarr identifies it, rips it with MakeMKV, transcodes it and
  hands it to Radarr / Sonarr.

## Disc ripping (automatic ripping machine)

Enable **Settings → Disc ripping** and rexarr behaves like ARM:

1. Insert a Blu-ray / DVD. rexarr polls the drives through `makemkvcon` and creates an entry on the **Discs** page.
2. The title list is read (titles shorter than *minimum title length* are skipped) and the disc label is looked
   up in Radarr (movies) and Sonarr (series). You can correct the match, pick season / first episode number, and
   choose which titles to rip.
3. MakeMKV rips each selected title to a remux MKV named so the \*arr apps parse it (`Title (Year) Remux-1080p.mkv`,
   `Show - S01E01 - Bluray-1080p Remux.mkv`).
4. Optionally the rips are queued for transcoding with a profile (the raw rip is removed afterwards unless *keep raw* is on).
5. The folder is handed to Radarr / Sonarr via `DownloadedMoviesScan` / `DownloadedEpisodesScan` (added to the
   library first if needed) and the disc is ejected.

With *auto rip* on, steps 2–5 run without confirmation. Requires [MakeMKV](https://www.makemkv.com/) (`makemkvcon`);
rexarr auto-detects the macOS app bundle and `/usr/bin/makemkvcon`. Ejecting uses `drutil` on macOS and `eject` on Linux.

## Design

The UI follows the \*arr frontend conventions so it feels like Sonarr / Radarr: a 60px header with global
search, a 210px sidebar with status messages, a 60px per-page toolbar with icon-over-label buttons and
sort / filter menus, `#202020` page body, `#333` cards, filled labels, 4px-radius buttons and inputs, poster
grids with episode progress bars, backdrop detail headers and season blocks. The colour tokens in
`client/src/styles.css` are named after Sonarr's theme variables (dark and light themes; toggle in the header)
with Radarr's yellow as the accent. The styles are rexarr's own implementation of that look, not copied
source.

## Requirements

- Node.js 22.12+
- FFmpeg 6+ (7.x recommended) with the encoders you plan to use
- MakeMKV (optional, for disc ripping)
- Radarr v4 / Sonarr v4 (API v3); Prowlarr optional

## Run from source

```bash
npm install
npm run build
npm start          # http://localhost:7878
```

Development (Vite dev server on :7979 proxying to the API on :7878):

```bash
npm run dev
```

Environment variables:

| Variable            | Default   | Description                          |
| ------------------- | --------- | ------------------------------------ |
| `REXARR_PORT`       | `7878`    | HTTP port                            |
| `REXARR_HOST`       | `0.0.0.0` | Bind address                         |
| `REXARR_DATA_DIR`   | `./data`  | Settings, profiles and job history   |
| `REXARR_CLIENT_DIR` | auto      | Override location of the built UI    |

## Docker

```bash
docker compose up -d --build
```

- Image: Node 22 on Alpine with the distro ffmpeg (x264, x265, SVT-AV1, libaom, VP9, Opus) plus VAAPI drivers.
- `PUID` / `PGID` / `UMASK` work like the LinuxServer images so encodes written to your media share are owned by you.
- Config (settings, profiles, job history) lives in `/config`; mount it.
- Mount your media at the **same path Radarr / Sonarr see it** (for example both at `/data/media`) and no path
  mapping is needed. If the paths differ, add one under **Settings → Path mappings**. The **System** page's
  health check tells you when a file the *arr app reports is not visible to rexarr.
- Hardware encoding: pass `/dev/dri` for Intel QuickSync / VAAPI. NVENC needs an ffmpeg with CUDA support
  (use a host ffmpeg or a CUDA-enabled base image) and the NVIDIA container runtime.
- Disc ripping: MakeMKV does not ship `makemkvcon` as a distro package, so the default image cannot rip discs.
  Run rexarr on the host for ripping, or build a derived image with MakeMKV compiled in and pass `/dev/sr0`.
- A `HEALTHCHECK` hits `/api/health`; the server binds `0.0.0.0:7878` by default.

## Setup

1. Open **Settings**, enable Radarr and/or Sonarr, paste the URL and API key, click **Test**, save.
2. Check **System** – it lists the ffmpeg version and which encoders are actually available.
3. Pick default profiles per media type (movie / TV / anime) or create your own under **Profiles**.
4. **Search** for a title. If it is not in Radarr / Sonarr yet, rexarr adds it. Choose a profile,
   click **Grab** on a remux. The job appears in **Activity** as *Waiting for import* and starts
   encoding once the \*arr app has imported the download.
5. Or go to **Movies** / **Series**, filter to *Remux only* and transcode files you already have.

## How a profile becomes an ffmpeg command

- Streams are selected explicitly by index from `ffprobe` output: one video stream, audio streams
  filtered by language (with commentary dropped), subtitles filtered by language / type, font
  attachments when the container is MKV.
- Quality is mapped per encoder family: `-crf` for x264 / x265 / SVT-AV1 / libaom / VP9, `-cq` +
  `-rc vbr` for NVENC, `-global_quality` for QuickSync, `-qp` for VAAPI / AMF, `-q:v` for
  VideoToolbox.
- HDR sources keep colour primaries / transfer / matrix flags and, for x265, mastering-display and
  content-light metadata. Dolby Vision RPU layers are dropped (HDR10 base layer kept) with a
  warning.
- MP4 / MOV get `-movflags +faststart`, `hvc1` tagging for HEVC, text subtitles as `mov_text`;
  bitmap subtitles and incompatible audio codecs are dropped / re-encoded with a warning in the log.
- Output goes to `<name>.<ext>` next to the source (or your directory / suffix), written as a
  `.rexarr-part` temp file and renamed on success. With *Replace original* the source is deleted
  and Radarr / Sonarr are asked to rescan.

## Tests

```bash
npm test
```

## License

MIT
