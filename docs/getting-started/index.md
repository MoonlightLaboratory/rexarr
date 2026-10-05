# Getting started

Rexarr is a single server with a web UI. Install it, point it at Radarr / Sonarr (and Lidarr if you use music),
pick your profiles, and it does the rest.

1. [Requirements](requirements.md) — Node.js is bundled in the release packages; FFmpeg is not.
2. Install it:
   - [From a release](install.md) — Windows installer, macOS app, Linux / FreeBSD tarball
   - [With Docker](docker.md) — `ghcr.io/moonlightlaboratory/rexarr`
   - [On a NAS](nas.md) — Unraid, ZimaOS, TrueNAS SCALE, Synology DSM, OpenMediaVault
   - [From source](from-source.md) — `npm install && npm run build && npm start`
3. [First-time setup](setup.md) — connections, profiles, and the first encode.

Rexarr listens on **http://localhost:3939** unless you change the port.
