# Storage and environment

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `REXARR_PORT` (or `PORT`) | `3939` | HTTP port. Takes precedence over the setting and locks the field |
| `REXARR_HOST` | `0.0.0.0` | Bind address |
| `REXARR_URL_BASE` | – | Reverse proxy sub-path, e.g. `/rexarr` |
| `REXARR_CONFIG_DIR` | packaged: OS config dir, source: `./data` | Root of everything Rexarr stores (`/config` in Docker). `REXARR_DATA_DIR` is accepted too |
| `REXARR_CLIENT_DIR` | auto | Override the location of the built UI |
| `REXARR_RESET_AUTH` | – | Start once with `1` to turn authentication off when locked out |
| `LOG_LEVEL` | `info` | Server log level |
| `PUID` / `PGID` / `UMASK` | – | Docker only: user, group and umask the entrypoint drops to |

## Folder layout

Everything lives under the config root and is listed with folder size and disk usage on **System → Status**:

| Path | Default | Override | Contents |
| --- | --- | --- | --- |
| Cache | `<config>/cache` | `REXARR_CACHE_DIR` | Regenerable data |
| Image Cache | `<config>/cache/images` | `REXARR_IMAGE_CACHE_DIR` | Posters and backdrops |
| Transcodes | `<config>/cache/transcodes` | `REXARR_TRANSCODE_DIR` | Encodes in progress, moved into place when finished |
| Disc Rips | `<config>/cache/rips` | `REXARR_RIP_DIR` (or Settings) | Raw MakeMKV output and in-progress rips |
| Program Data | `<config>/data` | `REXARR_PROGRAM_DATA_DIR` | Settings, profiles, job / disc history, events |
| Metadata | `<config>/data/metadata` | `REXARR_METADATA_DIR` | AniDB datasets |
| Backups | `<config>/data/backups` | `REXARR_BACKUP_DIR` | Configuration backups |
| Logs | `<config>/log` | `REXARR_LOG_DIR` | `rexarr.txt` + rotated logs |

The config root itself defaults to `C:\ProgramData\rexarr` on Windows, `~/.config/rexarr` elsewhere, `/config` in
Docker, and `./data` when running from source. An older flat config folder is moved into this layout automatically
on first start (logged under **System → Events**).

### Program data files

| File | Contents |
| --- | --- |
| `settings.json` | everything on the Settings pages |
| `profiles.json` | your profiles (built-in presets are in the code) |
| `jobs.json`, `queue.json` | job history and the queue |
| `rips.json` | discs and rips |
| `auto.json` | auto-transcode history, so nothing is encoded twice |
| `local-media.json`, `local-meta.json` | the local media index and its metadata matches |
| `events.json` | the Events list |

Back these up with **System → Backup** rather than by hand while Rexarr is running.

## Where encodes are written

Encodes go to **Transcodes** and are moved next to their output when done. If that folder is on a small disk, point
`REXARR_TRANSCODE_DIR` at a big volume or choose **Settings → Encoding → FFmpeg → Write encodes to → Next to the
output file**. When replacing an original, the finished encode is copied next to it before the original is deleted.

Disc rips are written and encoded in **Disc Rips** inside the cache, and only finished files are moved to the rip
directory you configured — see [Disc ripping](../guide/disc-ripping.md#the-pipeline).
