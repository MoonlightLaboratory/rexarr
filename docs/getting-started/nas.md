# NAS and home servers

Rexarr runs on anything that can run a container. These are ready-made templates for the five systems people ask
about most, with the paths and user ids each one uses:

| System | Template | How you add it |
| --- | --- | --- |
| Unraid | [`rexarr.xml`](https://github.com/MoonlightLaboratory/rexarr/blob/main/distribution/nas/unraid/rexarr.xml) | Docker → Add Container → Template URL |
| ZimaOS / CasaOS | [`docker-compose.yml`](https://github.com/MoonlightLaboratory/rexarr/blob/main/distribution/nas/zimaos/docker-compose.yml) | Apps → Install a customized app → Import (a store listing is in review) |
| TrueNAS SCALE | [`docker-compose.yml`](https://github.com/MoonlightLaboratory/rexarr/blob/main/distribution/nas/truenas/docker-compose.yml) | Apps → Discover → Install via YAML |
| Synology DSM | [`docker-compose.yml`](https://github.com/MoonlightLaboratory/rexarr/blob/main/distribution/nas/synology/docker-compose.yml) | Container Manager → Project |
| OpenMediaVault | [`docker-compose.yml`](https://github.com/MoonlightLaboratory/rexarr/blob/main/distribution/nas/openmediavault/docker-compose.yml) | omv-extras → Compose → Files |

Three things decide whether it works, whatever the box:

1. **Mount your media at the same path Radarr and Sonarr use.** If all three see it as `/data/media`, nothing else
   is needed. If they do not, add the translation under **Settings → Path mappings** — see
   [Path mappings](../reference/settings.md#path-mappings), and use **Settings → Disc ripping → Check import
   access** before the first disc.
2. **Set `PUID` / `PGID` to the user that owns your shares**, and leave `UMASK=002`, so the files Rexarr writes can
   be moved and deleted by the \*arr apps.
3. **Keep `/config` on internal storage**, not on an SMB / NFS share. Rexarr writes its settings and history with
   atomic renames, which network filesystems do not always honour; it warns you under System → Status if it finds
   itself on one.

---

## Unraid

1. **Docker → Add Container → Template**, paste:
   `https://raw.githubusercontent.com/MoonlightLaboratory/rexarr/main/distribution/nas/unraid/rexarr.xml`
2. Defaults in the template: `/config` on `/mnt/user/appdata/rexarr`, media on `/mnt/user/data` mounted as `/data`
   (the layout the TRaSH guides use, and the one Radarr / Sonarr already have), `PUID=99`, `PGID=100`, `UMASK=002`.
3. Hardware encoding: show advanced settings and keep the `/dev/dri` device, then pick **Intel Quicksync** or
   **VAAPI** in Settings → Encoding → Transcoding and press *Test*.
4. Keep appdata on the cache pool — encodes write a lot.

## ZimaOS (and CasaOS)

1. **Apps → ⋯ → Install a customized app → Import**, and paste
   [the compose file](https://github.com/MoonlightLaboratory/rexarr/blob/main/distribution/nas/zimaos/docker-compose.yml).
   It carries the `x-casaos` block, so the icon, the web UI button and the port show up properly.
2. Defaults: `/config` on `/DATA/AppData/rexarr/config`, media on `/DATA/Media` (mounted at the same path inside, so
   it matches what other CasaOS apps see), `PUID=0` / `PGID=0` because ZimaOS runs its apps as root. Set them to a
   real user if you have one.
3. A ZimaBoard or ZimaCube has an Intel GPU: keep `/dev/dri` and use Quicksync or VAAPI.

## TrueNAS SCALE

Needs 24.10 (Electric Eel) or newer, where apps run on Docker.

1. **Apps → Discover Apps → ⋮ → Install via YAML**, paste
   [the compose file](https://github.com/MoonlightLaboratory/rexarr/blob/main/distribution/nas/truenas/docker-compose.yml)
   and change `tank` to your pool.
2. Give the **apps** user (568:568) read/write on the datasets, or set `PUID` / `PGID` to the user that owns your
   media. A dataset of its own for `/config` keeps snapshots sane.
3. Hardware encoding: keep `/dev/dri` if the system has an Intel iGPU.

## Synology DSM

Needs DSM 7.2+ with **Container Manager**.

1. Create `/volume1/docker/rexarr`, then **Container Manager → Project → Create**, point it at that folder and paste
   [the compose file](https://github.com/MoonlightLaboratory/rexarr/blob/main/distribution/nas/synology/docker-compose.yml).
2. `PUID` / `PGID`: run `id <your-user>` over SSH. DSM user ids usually start at **1026**, and **100** is the
   `users` group that owns the shares.
3. **Hardware encoding** only exists on the Intel models (DS918+, DS920+, DS923+ with an Intel CPU, DS1621xs+ and
   similar): uncomment `/dev/dri` there. ARM models (DS220j, DS223, RS819…) have no `/dev/dri` — leave
   Settings → Encoding → Transcoding on *None* and expect software encoding to be slow; see
   [Requirements](requirements.md#hardware).
4. DSM reserves ports below 1024 and some others for itself; 3939 is free.

## OpenMediaVault

1. Install **omv-extras**, then the **Compose** plugin (Services → Compose).
2. **Files → Add**, paste
   [the compose file](https://github.com/MoonlightLaboratory/rexarr/blob/main/distribution/nas/openmediavault/docker-compose.yml),
   replace the `/srv/dev-disk-by-uuid-…` paths with your disk (System → File Systems shows them), then **Up**.
3. `PUID` / `PGID`: `id <your-user>`; most OMV shares are owned by the `users` group (100).

---

## Hardware encoding on a NAS

Most x86 NAS boxes have an Intel iGPU, which is the difference between an encode finishing overnight and finishing
next week. Pass `/dev/dri`, choose **Intel Quicksync** or **VAAPI** in Settings → Encoding → Transcoding, and press
**Test** — it encodes three seconds and reports the fps or the exact ffmpeg error.

The image ships ffmpeg with VAAPI and the Intel drivers on amd64. NVENC needs an ffmpeg built with CUDA plus the
NVIDIA container runtime, and arm boards (Synology ARM, most OMV installs on a Pi) have neither — software x265 on
those is measured in days for 4K, so encode elsewhere or stick to 1080p. See
[Transcoding](../guide/transcoding.md) and [Requirements](requirements.md#hardware).

## Disc ripping on a NAS

The published image deliberately has **no `makemkvcon`**: MakeMKV may not be redistributed. To rip on the NAS,
build `docker/Dockerfile.makemkv` yourself (it compiles MakeMKV from makemkv.com, accepting their EULA), pass the
drive **and** its SCSI node (`/dev/sr0` *and* `/dev/sg0`), and enter your MakeMKV key once in Settings.

A USB drive on a NAS works, but check `Settings → Disc ripping → Rip directory` points somewhere roomy on the array
and that Radarr / Sonarr can see it. See [Disc ripping](../guide/disc-ripping.md).

## Where things go wrong

| Symptom | Fix |
| --- | --- |
| Rexarr cannot see a file Radarr reports | The containers mount the media at different paths — add a [path mapping](../reference/settings.md#path-mappings) |
| Imports fail with permission errors | `PUID` / `PGID` are not the user that owns the share; `UMASK=002` |
| Settings vanish after a restart | `/config` is on a network share — move it to internal storage |
| Encodes are slow | No `/dev/dri` passed, or an arm box with no hardware encoder at all |
| *Check import access* says the rip folder is not visible | Radarr / Sonarr see that folder under another path, or not at all |
| System → Status warns that a share is slow or stalled | The NAS share dropped out; reconnect it — Rexarr keeps checking |
