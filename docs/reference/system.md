# System and maintenance

The **System** menu holds everything about the running server.

## Status

- **About** — Rexarr version, how it was installed (package, Docker, source), Node version, platform, uptime,
  config directory and the GitHub links. *Report an issue* opens a pre-filled bug report.
- **FFmpeg** — the binary in use, its version, and every video / audio encoder it actually has. Encoders a profile
  needs but ffmpeg does not have are flagged here and in the profile editor.
- **Hardware accel** — the methods the ffmpeg build supports and the devices found (`nvidia-smi`,
  `/dev/dri/renderD*`).
- **Connections** — Radarr, Sonarr, Prowlarr, Lidarr, slskd, fre:ac, MakeMKV: reachable or not, with the version
  each app reports.
- **Sleep** — whether a sleep inhibitor is currently held and why (see
  [Keeping the computer awake](../guide/disc-ripping.md#keeping-the-computer-awake)).
- **Storage** — every folder Rexarr uses with its size and the disk's free space (see
  [Storage and environment](storage.md)).

### Health checks

Run every 5 minutes (and on demand) and shown as warnings at the top of the page and in the sidebar:

- ffmpeg / ffprobe missing, not executable, or built for another processor — the message says which, including the
  Rosetta case on Apple silicon that otherwise only reports "Unknown system error -86"
- a hardware acceleration method that this ffmpeg cannot do
- a configured \*arr app that does not answer
- Soulseek configured without Lidarr
- a path an \*arr app reports that Rexarr cannot see (a missing path mapping), and a path mapping whose local folder
  does not exist
- MakeMKV missing while disc ripping is on, or a configured drive that has disappeared
- fre:ac missing while music profiles exist
- the program data folder not being writable

## Events

A log of what Rexarr did: jobs created and finished, auto-transcode scans, disc rips, imports and their results,
failed logins, storage migrations, restarts. Filter by level and component; clear the list when it gets long.

## Tasks

Scheduled work, with the last run, its result, the interval and the next run. Each one can be run now.

| Task | Interval | What it does |
| --- | --- | --- |
| Check health | 5 min | the health checks above |
| Check optical drives | *Drive poll interval* | detect inserted discs (only while disc ripping is on) |
| Import finished rips | 10 min | hand anything left in the rip folder to Radarr / Sonarr (only with *Import finished rips automatically*) |
| Check \*arr imports for waiting jobs | *Import poll interval* | has a grabbed release been imported yet? |
| Refresh AniDB data | weekly | the AniDB title dump and mapping (only while AniDB is on) |
| Detect FFmpeg encoders | on change | re-read what ffmpeg can do |
| Auto transcode new remuxes | *Scan every* | queue new remuxes (only while auto transcode is on) |
| Backup configuration | *Backup interval* | a scheduled backup |
| Clean transcode cache | daily | leftovers from cancelled or crashed encodes |
| Clean image cache | daily | posters and backdrops no longer referenced |

## Backup and restore

**System → Backup** lists backups with their size and time, takes one now, downloads one, deletes one, or restores
either a listed backup or an uploaded file. A backup contains settings, profiles, job and disc history and the
auto-transcode history — not your media.

Scheduled backups run every 1–7 days (Settings → General → Backups); backups older than the retention period are
removed, and the newest three are always kept.

Restoring replaces the current configuration and restarts the server.

## Logs

**System → Logs** shows `rexarr.txt` and its rotated files, with the level set in Settings → General → Logging
(Info / Debug / Trace; Debug and Trace add every HTTP request). Files rotate at the configured size. They can be
read in the UI, downloaded, or deleted.

The log folder is `<config>/log` — see [Storage and environment](storage.md).

## Shutdown and restart

**System → Shutdown** stops the server; **Restart** restarts it (also offered after host changes, which rebind the
web server in place). In Docker, use the container's own restart policy. API: `POST /api/system/shutdown`,
`POST /api/system/restart`.
