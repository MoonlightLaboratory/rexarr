# First-time setup

0. On first launch, **System → Tools** lists FFmpeg (required), fre:ac, MakeMKV and slskd with install steps for
   your platform. Close it with *Skip for now* / *Continue*; it stays available in the System menu.
1. Open **Settings → Connections**, enable Radarr and/or Sonarr, paste the URL and API key, click **Test**, save.
   Add Prowlarr for raw indexer search, Lidarr and slskd for [music](../guide/music.md).
2. Check **System → Status** — it lists the ffmpeg version and which encoders are actually available, and flags
   anything missing (ffmpeg, MakeMKV, fre:ac, a drive that disappeared, a path an \*arr app reports that Rexarr
   cannot see).
3. Add **path mappings** if Rexarr sees your media under different paths than Radarr / Sonarr do (typical with
   Docker or a remote \*arr app): **Settings → Path mappings**, remote path → local path, per app.
4. Pick default profiles per media type (movie / TV / anime / music) under **Settings → Encoding → Defaults**, or
   create your own under **[Profiles](../guide/profiles.md)**.
5. **Search** for a title. If it is not in Radarr / Sonarr yet, Rexarr can add it. Choose a profile, click **Grab**
   on a remux. The job appears in **Activity** as *Waiting for import* and starts encoding once the \*arr app has
   imported the download.
6. Or go to **Movies** / **Series**, filter to *Remux only* and transcode files you already have.

## Recommended next steps

- Turn on **[Auto transcode](../guide/auto-transcode.md)** so every new remux is encoded without you asking, and add
  a webhook in Radarr / Sonarr so it starts seconds after each import.
- Turn on **[AniDB](../guide/anidb.md)** if you keep anime — it fixes anime movie detection, romaji titles and disc
  identification.
- If you rip discs, read **[Disc ripping](../guide/disc-ripping.md)**: the rip directory has to be reachable by
  Radarr / Sonarr, and *Check import access* tells you before the first disc whether it is.
- Set **authentication** (Settings → General → Security) if Rexarr is reachable from outside your network, and take
  a first backup (**System → Backup**).
