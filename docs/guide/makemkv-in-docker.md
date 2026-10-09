# MakeMKV and Docker

Rexarr rips by **running `makemkvcon`**, the MakeMKV command-line program — it is not a service with an API. So
there is no way to point Rexarr at a MakeMKV container over the network: the binary has to be reachable *inside*
Rexarr's own container, or the two have to hand work to each other through a folder.

The published image (`ghcr.io/moonlightlaboratory/rexarr`, `moonlightlaboratory/rexarr`) deliberately ships
**without** MakeMKV, because MakeMKV may not be redistributed. These are the three ways to get there, in the order
most people should try them.

| | What you get | Effort |
| --- | --- | --- |
| [1. Build Rexarr with MakeMKV in it](#1-build-rexarr-with-makemkv-in-it) | One container, full pipeline: detect → rip → encode → import | One `docker build` |
| [2. Rip in a MakeMKV container, let Rexarr take over](#2-rip-in-a-makemkv-container-let-rexarr-take-over) | Keep the MakeMKV GUI you already run; Rexarr does the rest | A shared folder |
| [3. Rexarr on the host](#3-rexarr-on-the-host) | Host MakeMKV, Rexarr next to it | No containers for Rexarr |

!!! warning "You cannot mount `makemkvcon` from another container into the published image"
    MakeMKV's binaries are built against glibc; the published Rexarr image is Alpine (musl), so a `makemkvcon`
    bind-mounted from `jlesage/makemkv`, from the host, or from any Debian image simply will not start there. The
    image built in option 1 **is** Debian-based, which is what makes MakeMKV work inside it.

## 1. Build Rexarr with MakeMKV in it

`docker/Dockerfile.makemkv` builds the same Rexarr on Debian and compiles MakeMKV (OSS + binary packages from
makemkv.com) into it. Building it means accepting [MakeMKV's EULA](https://www.makemkv.com/eula/).

```bash
git clone https://github.com/MoonlightLaboratory/rexarr
cd rexarr
docker compose -f docker/docker-compose.makemkv.yml build
docker compose -f docker/docker-compose.makemkv.yml up -d
```

Or by hand:

```bash
docker build -f docker/Dockerfile.makemkv --build-arg MAKEMKV_VERSION=1.18.1 -t rexarr:makemkv .
docker run -d --name rexarr -p 3939:3939 \
  --device /dev/sr0 --device /dev/sg0 \
  -v ./config:/config -v /path/to/media:/data/media \
  rexarr:makemkv
```

- **Pass both device nodes.** `/dev/sr0` is the drive, and it has a generic SCSI node beside it that MakeMKV needs
  for Blu-ray. **It is not always `/dev/sg0`** — hard drives take `sg` numbers too, so the drive's node may be
  `/dev/sg1` or higher. Check which one is the optical drive before passing it:

  ```bash
  ls /sys/block/sr0/device/scsi_generic/   # on the host: the sg node that belongs to sr0
  lsscsi -g                                # same thing, if the host has lsscsi (the image does not)
  ```

  Inside the container, MakeMKV's own drive list is the authority — it prints the device it will use:

  ```bash
  docker exec -u 1000:1000 -e HOME=/config rexarr makemkvcon -r info | grep ^DRV
  ```

  A scan that opens the disc but finds no titles at all is often this node missing or wrong — though it can also be
  the MakeMKV key, or a drive whose firmware cannot decrypt Blu-ray
  ([makemkv.com's forum keeps a list](https://forum.makemkv.com/forum/viewtopic.php?f=19&t=18856)). Rexarr quotes
  what MakeMKV said on the disc page, which usually settles it.
- **The key** goes in once under **Settings → Disc ripping** and is kept in `/config/.MakeMKV/settings.conf`, so it
  survives rebuilds as long as `/config` is mounted. Blu-ray needs a registered key or the current free beta key.
- **`MAKEMKV_VERSION`** must be a version still on makemkv.com — they remove old ones. Rebuild with a new value
  when MakeMKV updates; nothing else changes.
- Not built in CI, for the same redistribution reason, so you rebuild it yourself when you update Rexarr — and
  that is also how you pick up an unreleased fix, since `ghcr.io/moonlightlaboratory/rexarr:main` has no MakeMKV
  in it:

  ```bash
  git pull
  docker compose -f docker/docker-compose.makemkv.yml build
  docker compose -f docker/docker-compose.makemkv.yml up -d
  ```

## 2. Rip in a MakeMKV container, let Rexarr take over

If you already run something like `jlesage/makemkv` for its GUI, keep it — let it do the decrypting and give Rexarr
the result through a shared folder. Two useful shapes:

### A disc backup or image → Rexarr treats it as a drive

Point the MakeMKV container's **backup / decrypted output** at a folder, and set that folder as
**Settings → Disc ripping → Virtual drives folder** in Rexarr.

```yaml
services:
  makemkv:
    image: jlesage/makemkv
    devices:
      - /dev/sr0:/dev/sr0
      - /dev/sg0:/dev/sg0
    volumes:
      - ./makemkv-config:/config
      - /srv/discs:/output          # backups and ISOs land here
    ports:
      - "5800:5800"                 # its web GUI

  rexarr:
    image: ghcr.io/moonlightlaboratory/rexarr:latest
    volumes:
      - ./rexarr-config:/config
      - /srv/discs:/srv/discs       # the SAME folder, same path is simplest
      - /srv/media:/data/media
    ports:
      - "3939:3939"
```

Every `.iso` / `.img` file and every `BDMV` or `VIDEO_TS` folder in `/srv/discs` then appears on Rexarr's **Discs**
page as a loaded virtual drive, and the normal pipeline runs: identify against your library, pick titles and
episodes, rip, encode, import. Rexarr feeds the image to its own `makemkvcon` — which the published image does not
have — so **this shape still needs option 1's image**, or option 3. Use it when you want the MakeMKV GUI for
awkward discs and Rexarr for everything after.

### Finished MKV files → Rexarr imports and encodes them

If the MakeMKV container writes **MKV files**, no ripping is left to do, and the published image is enough:

1. Point its output at Rexarr's rip folder (**Settings → Disc ripping → Rip directory**, e.g. `/data/rips`).
2. Name the files so the \*arr apps can parse them — `Show - S01E01 - Bluray-1080p Remux.mkv`,
   `Film (2024) Remux-1080p.mkv`.
3. **Import finished rips automatically** (on by default) hands them to Radarr / Sonarr every 10 minutes, or press
   **Import rip folder now**. Each file's result is listed, and files that were not imported stay where they are.
4. To encode them first, queue them from **Local media** or the library page with any profile.

This is the only shape where two containers genuinely "link": through the folder, not over the network.

!!! note "One disc, one program"
    Both containers can be given `/dev/sr0`, but only one can read the disc at a time. If MakeMKV's container holds
    the drive, turn off **Settings → Disc ripping → Disc ripping** (or at least *Start ripping automatically*) in
    Rexarr so the two do not fight over it.

## 3. Rexarr on the host

Install MakeMKV on the host the normal way and run Rexarr there too — `makemkvcon` is found automatically
(`/usr/bin/makemkvcon`, or the app bundle on macOS). Everything else (Radarr, Sonarr, download clients) can stay in
containers; they only need to agree on paths, which is what
[path mappings](../reference/settings.md#path-mappings) are for.

This is the simplest route on a desktop or a laptop that happens to have the drive, and the fastest to debug: the
same `makemkvcon` you can run yourself in a terminal.

## Checking it works

- **System → Status → Connections** shows the MakeMKV version Rexarr found, or why it could not start it.
- **Discs → Detect disc** polls the drives now; a drive that is configured but missing is flagged on Status.
- **Settings → Disc ripping → Check import access** asks Radarr and Sonarr whether they can see the rip folder,
  before you spend an hour on a rip that cannot be imported.

See [Disc ripping](disc-ripping.md) for the pipeline itself, and
[NAS and home servers](../getting-started/nas.md) for passing drives through on Unraid, TrueNAS, DSM and the rest.
