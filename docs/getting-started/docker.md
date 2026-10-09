# Docker

Pre-built images are published to **GitHub Container Registry** and **Docker Hub** — the same image, pick either:

```bash
docker pull ghcr.io/moonlightlaboratory/rexarr:latest
docker pull moonlightlaboratory/rexarr:latest
```

Tags: `latest` for the newest release, the version of each release (`0.1.7.2`), and **`main`** — the branch,
rebuilt on every push, which is how to try a fix before it is released:

```bash
docker pull ghcr.io/moonlightlaboratory/rexarr:main
```

All of them are linux/amd64 and linux/arm64, built by `.github/workflows/docker.yml`. `main` is where unreleased
work lives, so it moves and can break; `latest` is the safe one.

!!! tip "On a NAS?"
    Unraid, ZimaOS, TrueNAS SCALE, Synology DSM and OpenMediaVault have ready-made templates with the right paths
    and user ids — see [NAS and home servers](nas.md).

```bash
docker compose up -d          # uses the published image
docker compose up -d --build  # or build locally from ./Dockerfile
```

Or by hand:

```bash
docker run -d --name rexarr -p 3939:3939 -e PUID=1000 -e PGID=1000 \
  -v ./config:/config -v /path/to/media:/data/media \
  ghcr.io/moonlightlaboratory/rexarr:latest
```

## The image

Node 22 on Alpine with the distro ffmpeg (x264, x265, SVT-AV1, libaom, VP9, Opus), VAAPI drivers and fre:ac for
music — about 530 MB. Multi-stage build; the runtime layer carries only the compiled server, the client bundle and
production dependencies (about 45 MB of node modules). `--build-arg WITH_FREAC=0` leaves fre:ac out (about 90 MB
smaller) if you do not use music.

```bash
docker build -t rexarr .
# another architecture:
docker buildx build --platform linux/amd64,linux/arm64 -t rexarr .
```

The JavaScript is built once on the host platform; only the runtime layer is per-architecture.

## Volumes and permissions

- **`PUID` / `PGID` / `UMASK`** work like the LinuxServer images: the entrypoint reuses or creates a user with those
  ids, chowns `/config`, opens passed-through `/dev/sr*` / `/dev/dri/*` nodes, then drops privileges.
- **`/config`** holds everything (see [Storage and environment](../reference/storage.md): `cache/`, `data/`,
  `log/`). Mount it. To keep large in-progress encodes off the config disk, mount a volume at
  `/config/cache/transcodes` or set `REXARR_TRANSCODE_DIR`.
- **Media**: mount it at the **same path Radarr / Sonarr see it** (for example `/data/media` in all three) and no
  path mapping is needed; otherwise add one under **Settings → Path mappings**. The health check on the **System**
  page tells you when a file an \*arr app reports is not visible to Rexarr.
- **Rips**: point **Settings → Disc ripping → Rip directory** at a roomy mounted volume (`/data/rips`) that Radarr /
  Sonarr can see; *Check import access* asks both apps whether they can reach it (after path mappings).

## Hardware encoding

- Pass `/dev/dri` for Intel QuickSync / VAAPI (`LIBVA_DRIVER_NAME=iHD` is preset; the Intel drivers are included on
  amd64).
- AMD VAAPI needs mesa, which adds about 200 MB — build with `--build-arg WITH_AMD_VAAPI=1` if you want it.
- NVENC needs an ffmpeg with CUDA support (mount one and point **Settings → Encoding → FFmpeg** at it) plus the
  NVIDIA container runtime.
- VideoToolbox is macOS-only and therefore not available in Docker.

## Disc ripping in Docker

`makemkvcon` is not redistributable, so the default image cannot rip. Build `docker/Dockerfile.makemkv` yourself (it
compiles MakeMKV OSS + bin from makemkv.com, accepting their EULA), pass the drive nodes, and enter your MakeMKV key
once:

```bash
docker compose -f docker/docker-compose.makemkv.yml up -d --build
```

[MakeMKV and Docker](../guide/makemkv-in-docker.md) covers this in full, including what to do when you already run
a MakeMKV container of your own, and why its `makemkvcon` cannot simply be mounted into this image.

!!! note "Sleep prevention does not apply"
    Rexarr never tries to keep the host awake from inside a container — the host's own power settings decide. See
    [Keeping the computer awake](../guide/disc-ripping.md#keeping-the-computer-awake).

## Other details

- `HEALTHCHECK` hits `/api/health`.
- The server binds `0.0.0.0:3939`; `REXARR_PORT`, `REXARR_HOST`, `REXARR_DATA_DIR` and `LOG_LEVEL` are honoured.
- Automatic updates are not available in Docker — pull the new image instead.
