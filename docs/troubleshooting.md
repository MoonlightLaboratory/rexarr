# Troubleshooting

Start at **System → Status**: the health checks name most problems directly, and **System → Events** and a job's own
**log** have the details.

## Nothing is transcoded after a grab

- The job sits at *Waiting for import*: Radarr / Sonarr have not imported the download yet. Check the \*arr app's
  queue — an import that is stuck there (a `.iso`, a sample, a failed unpack) never reaches Rexarr. Full discs are
  expected to stay *import pending* — that is how [full-disc releases](guide/disc-ripping.md#full-disc-releases-from-search)
  work.
- The file was imported but Rexarr cannot see it: **System → Status** says so. Add a
  [path mapping](reference/settings.md#path-mappings).

## "X is not visible to Rexarr" / wrong paths

Radarr in Docker says `/data/media/movies/…`; Rexarr on the host sees `/Volumes/Media/Movies/…`. Add a path mapping
per app (remote → local). Mappings work in both directions, so they also fix delivering rips back to the app. For
the rip folder, use **Settings → Disc ripping → Check import access**.

## An encoder is missing

**System → Status → FFmpeg** lists what your ffmpeg actually has. Install a build with the encoder you want (or
point **Settings → Encoding → FFmpeg** at one) — for example a CUDA-enabled ffmpeg for NVENC, or jellyfin-ffmpeg for
RKMPP. Profiles naming a missing encoder are flagged in the profile editor.

## "Unknown system error -86" on macOS

An Intel-only binary (ffmpeg, fre:ac or MakeMKV) on an Apple silicon Mac without Rosetta. Install the arm64 build,
or install Rosetta. Status and the health checks spell this out, including binaries that are not executable or not
where the setting points.

## Hardware encoding fails or is slow

- Use **Test** in **Settings → Encoding → Transcoding**: it encodes 3 seconds and shows the fps or the exact ffmpeg
  error.
- A failed hardware encode is retried on the CPU automatically; the job log and Events say so.
- In Docker, pass `/dev/dri` for QSV / VAAPI, and remember NVENC needs the NVIDIA container runtime.
- Hardware encoders need more bitrate for the same quality — for archiving remuxes, software x265 / SVT-AV1 is the
  better choice.

## An encode never finishes

Set **Stop stalled encodes after** (Settings → Encoding → FFmpeg) so a stalled network share or a hung driver fails
the job instead of blocking the queue. The queue limit is enforced from job creation, so a probing job cannot let
extra encodes start.

## Discs

See the [disc troubleshooting table](guide/disc-ripping.md#troubleshooting) for the full list. The common ones:

- **Nothing imported, rip failed with *cannot see …*** — the rip directory is not reachable by the app at that path.
  Fix the mapping and run *Import rip folder now*; the files are still there.
- **No titles found on this disc** — the OS mounted it, or MakeMKV cannot decrypt it (Blu-ray needs a key).
- **A title is missing** — it is shorter than *Minimum title length*; lower it or tick *Include extras and
  specials*.
- **The machine went to sleep mid-rip** — keep **Keep this computer awake while ripping or encoding** on
  (Settings → Encoding); **System → Status → Sleep** shows whether the inhibitor is held.

## Music

- **fre:ac missing** — install it and set the path in **Settings → Connections → fre:ac**. The Docker image has
  fre:ac but **no WavPack or Monkey's Audio** encoder.
- **An album will not import into Lidarr** — a single image + cue album is split automatically; if it already left
  Lidarr's queue, use **Music → Import Folder**.

## Locked out of the UI

Start Rexarr once with `REXARR_RESET_AUTH=1` to turn authentication off, then set it up again under
**Settings → General → Security**.

## Port already in use

`REXARR_PORT` (or `PORT`) wins over the setting and locks the field in the UI — check it is not set in your service
file, shell profile or Docker environment. Host changes made in the UI rebind the server in place and fall back to
the old port if the new one cannot be bound.

## Reporting a bug

**System → Status → Report an issue** opens a GitHub issue with your version, platform and install method filled in.
Please include the job log or disc log, and say what you expected. Security problems go to
[SECURITY.md](https://github.com/MoonlightLaboratory/rexarr/blob/main/SECURITY.md) instead.
