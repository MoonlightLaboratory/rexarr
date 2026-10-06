# How it compares

Rexarr overlaps with a few well-known tools without replacing any of them. This is an honest read of where each
one is stronger, written while Rexarr is still in beta.

## Automatic Ripping Machine

[ARM](https://github.com/automatic-ripping-machine/automatic-ripping-machine) is a ripping appliance: insert a
disc, wait for it to eject, let Plex or Emby pick up what landed. Rexarr is an \*arr companion that happens to rip
discs. The pipelines overlap; everything either side of them differs.

**What ARM does that Rexarr does not**

- Handles **any** disc: video, audio CD (through `abcde`), and data discs as ISO backups.
- Decides movie vs TV and names the folder from [OMDb](https://www.omdbapi.com/).
- Rips with **MakeMKV or HandBrake**, main feature or everything, and transcodes with HandBrake presets.
- Sends **notifications** — IFTTT, Pushbullet, Slack, Discord and more.
- Years of use behind it, a large community, and a Discord. Rexarr is in beta.

**Where Rexarr differs on the same job**

| | ARM | Rexarr |
| --- | --- | --- |
| Identifies a disc by | the disc label and OMDb | your own Radarr / Sonarr library, alternate titles and [AniDB](guide/anidb.md) season names |
| Episode handling | folder named for Plex / Emby | titles mapped to real episodes, with [specials and extras](guide/disc-ripping.md#specials-and-extras) (S00, OP / ED / OVA) |
| Audio tracks | all, or HandBrake's preset | [best per language, or whatever you tick](guide/disc-ripping.md#audio-tracks), per title |
| Encoding | HandBrake presets | [FFmpeg profiles](guide/profiles.md) — x265 / SVT-AV1 / AV1, hardware encoders with a test button, subtitle and HDR rules, output renaming |
| Hand-off | writes to a folder for Plex / Emby | [Manual Import to Radarr / Sonarr, then verified](guide/disc-ripping.md#delivery-and-import) — the file is gone from the rip folder *and* the item has a file |
| When the import fails | the files are simply there | the rip **fails** with the reason and both paths, and a sweep retries every 10 minutes |
| Missing from the library | — | the show or film is [added for you](guide/disc-ripping.md#adding-missing-shows-and-movies), unmonitored |
| Runs on | Linux (udev), Docker | Windows, macOS, Linux, FreeBSD, Docker |

**And the half ARM does not cover at all**: [searching and grabbing](guide/search.md) remux and full-disc releases
through Radarr / Sonarr / Prowlarr, [auto-transcoding](guide/auto-transcode.md) every new remux the \*arr apps
import, and [music](guide/music.md) through Lidarr — CD ripping with MusicBrainz tags, single-file albums with a cue
sheet split so Lidarr can import them, fre:ac profiles.

**Honest caveats**: Rexarr has no data-disc ISO backup and no notification integrations yet — both are on the
[roadmap](roadmap.md) — and its published Docker image cannot rip on its own because MakeMKV may not be
redistributed, so you [build the image with it](guide/makemkv-in-docker.md) or run on the host. ARM is the steadier
ripper.

!!! tip "Pick one per drive"
    Only one program can hold a disc at a time. If ARM already owns your drive, turn Rexarr's disc detection off
    and let it do the \*arr side — or point it at what ARM produced; see
    [MakeMKV and Docker](guide/makemkv-in-docker.md#2-rip-in-a-makemkv-container-let-rexarr-take-over).

**Pick ARM** if the optical drive is the point and your media server reads the output.
**Pick Rexarr** if you live in Radarr and Sonarr, and want discs to arrive as verified imports with encodes you
control — plus the same tool handling remuxes and music.

## Tdarr and Unmanic

[Tdarr](https://github.com/HaveAGitGat/Tdarr) and [Unmanic](https://github.com/Unmanic/unmanic) are **library
optimisers**: point them at a folder and they work through everything in it, on a schedule, to bring the whole
library to a target codec — Tdarr across several machines with worker nodes, health checks and plugins, Unmanic
with a simpler single-box design.

Rexarr is narrower on purpose. It encodes **what the \*arr apps just imported** (or what you select in the
library), using the profile for that media type, and it knows what a file *is*: a Blu-ray remux of a specific
episode, which it can rename so Sonarr stops calling it a remux, and whose source it can replace and rescan.
There is no worker fleet and no library-wide sweep.

Use Tdarr or Unmanic to re-encode a 20 TB back catalogue across three machines. Use Rexarr to keep new remuxes and
disc rips in the shape you want as they arrive — and for everything to do with discs and search, which neither of
them does. A library-wide option [is on the roadmap](roadmap.md#a-library-optimiser-option), behind stability.

## MakeMKV and HandBrake on their own

That is the manual version of the same pipeline, and it is fine for the occasional disc: MakeMKV for the rip,
HandBrake for the encode, then move the file somewhere Sonarr or Radarr will take it.

What Rexarr adds on top is the bookkeeping — which title is which episode, which audio tracks to keep, a profile
instead of remembering settings, the cache so half-finished files never reach the library, the import stated and
verified rather than hoped for, and a log of what happened to each file.
