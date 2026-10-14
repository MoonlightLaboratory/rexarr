# Auto transcode

Enable **Settings → Automation → Auto transcode new remuxes** and every Blu-ray remux that appears in Radarr or
Sonarr is queued automatically, with the profile for its type (movie, TV, or anime via Sonarr's series type or
[AniDB](anidb.md)). Per-type profiles can be overridden there; otherwise the default profiles are used.

!!! tip "A smart profile is worth using here"
    Auto transcode runs unattended on whatever turns up, and one fixed profile has to be right for all of it. A
    [smart profile](profiles.md#smart-profiles) decides per file instead — keep the TrueHD when it is 7.1 and make
    it FLAC when it is stereo, give animation the animation tune, leave 10-bit HDR alone. And when it decides
    nothing needs changing, no job is queued at all, which is what you want from something running on its own.
    They can be chosen for any of the three types, or set as the default profile for them.

- **Existing library**: by default the first scan only records the remuxes already present (a baseline) and
  transcodes new ones from then on. Tick *Also transcode remuxes already in the library* to work through the
  backlog, at most *Max new jobs per scan* at a time. **Preview** lists exactly what would be queued.
- **Schedule**: a scan runs every *Scan every (minutes)* — see **System → Tasks → Auto transcode new remuxes**.
- **Instant**: add a Webhook connection in Radarr / Sonarr (**Settings → Connect**, *On Import* + *On Upgrade*)
  pointing at `http://rexarr:3939/api/webhook/radarr` or `/sonarr`; a scan runs 15 seconds after each import. The
  Connections page shows the URLs with your API key when authentication is on.
- **No loops**: every file Rexarr queued, and every file it wrote, is remembered by path in `data/auto.json`, so a
  transcode that Radarr / Sonarr re-import (still named REMUX) is never transcoded again. Files that are not visible
  to Rexarr are reported — fix the [path mapping](../reference/settings.md#path-mappings) and they are picked up on
  the next scan. *Reset history* forgets everything.
- Auto-created jobs carry an **Auto** label in Activity and are logged under **System → Events**.

API: `GET /api/auto/status`, `POST /api/auto/scan[?dryRun=1]`, `POST /api/auto/reset`, `POST /api/webhook/:arr`.
