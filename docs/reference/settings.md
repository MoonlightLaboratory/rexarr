# Settings reference

Settings live under **Settings** (connections, encoding, automation, metadata, discs, path mappings) and
**Settings → General** (host, security, proxy, logging, updates, backups). Both pages have a *Show Advanced* toggle
that reveals the orange advanced fields, like Sonarr's.

Everything on these pages is also available as JSON: `GET /api/settings`, `PUT /api/settings`.

## General

- **Host** — Bind Address (`*`, `localhost` or an IP), Port, URL Base (reverse proxy sub-path, e.g. `/rexarr`),
  Instance Name (browser tab and login page), Application URL (used for webhook links), and SSL (HTTPS on its own
  port with a PEM cert + key or a `.pfx`). Host changes need a restart: the page shows a *Restart* button, and
  Rexarr restarts its web server in place, falling back to the old port if the new one cannot be bound.
  `REXARR_PORT` / `PORT`, `REXARR_HOST` and `REXARR_URL_BASE` take precedence and lock the fields.
- **Security** — Authentication *None*, *Basic (Browser Popup)* or *Forms (Login Page)*; *Authentication Required*
  can skip local addresses (a reverse proxy's `X-Forwarded-For` is honoured only when the proxy itself is local).
  Passwords are stored as salted scrypt hashes; sessions are signed cookies (30 days with *Remember me*); repeated
  failed logins are throttled and logged under **System → Events**. The **API key** (`X-Api-Key` header or
  `?apikey=`) always works — the webhook URLs on the Connections page include it when authentication is on. Locked
  out? Start Rexarr once with `REXARR_RESET_AUTH=1` to turn authentication off. *Certificate Validation* controls
  HTTPS checks for Radarr / Sonarr / Prowlarr and other servers (enabled, disabled for local addresses, disabled).
- **Proxy** — HTTP(S) proxy, with credentials, an ignore list such as `*.local, 192.168.1.*`, and a bypass for
  local addresses, for AniDB data, cover art and remote \*arr apps.
- **Logging** — Info / Debug / Trace (Debug and Trace add every HTTP request) and the log file size before
  rotation.
- **Updates** — branch and mechanism; the mechanism decides what **[System → Updates](system.md#updates)** tells
  you to run to install a release. Rexarr does not update itself, and in Docker you pull the new image.
- **Backups** — folder (relative to the config directory), interval (1–7 days) and retention: scheduled backups
  older than this are removed, and the newest three are always kept.

## Connections

| Connection | Fields | Notes |
| --- | --- | --- |
| Radarr | URL, API key | API v3. *Test* verifies it |
| Sonarr | URL, API key | API v3 |
| Prowlarr | URL, API key | optional, for raw indexer search |
| Lidarr | URL, API key, split image + cue downloads | API v1, enables the Music page |
| slskd | URL, API key, download folder, max peer queue | Soulseek album search |
| fre:ac | `freaccmd` path | empty = auto-detect |
| Local media | extra folders, scan interval, folder kinds | see [Local media](../guide/local-media.md) |
| MusicBrainz | on / off | CD and album lookups, Cover Art Archive |
| Notifications | any number of targets | see below |

### Notifications

Rexarr can tell you when an **encode finished or failed**, when a **disc finished or failed**, and when an
**update is available**. **Add notification** opens a picker of the kinds below; add as many as you like, and each
one chooses its own events, so the phone can get failures only while a channel gets everything.

| Target | What it needs |
| --- | --- |
| Discord | the channel's webhook URL (Channel → Edit → Integrations → Webhooks) |
| Slack | an incoming webhook URL |
| Telegram | a bot token from @BotFather and the chat id |
| ntfy | the topic URL (`https://ntfy.sh/your-topic`), or the server URL and the topic separately; an access token for protected topics. Failures are sent with a high priority |
| Gotify | the server URL and an app token |
| Pushbullet | an access token |
| Apprise API | the server URL, plus a config key for a saved configuration or the Apprise URLs for a stateless one — this is the way to reach IFTTT and everything else Apprise supports |
| Webhook | a URL of your own. It receives `{ event, title, message, failed, at }` as JSON |
| Custom Script | the path to an executable program. It is run on each event with `REXARR_EVENT`, `REXARR_TITLE`, `REXARR_MESSAGE`, `REXARR_FAILED`, `REXARR_VERSION` and `REXARR_AT` in its environment, and is given 30 seconds; a non-zero exit, a missing file or one that is not executable is reported |

**Test** sends one message with the values on screen, saved or not, and says what the target answered. A target
that fails later is not retried: the reason is written to **System → Events**, so a broken webhook never holds up
an encode or a rip.

!!! warning "A custom script runs as Rexarr"
    Anyone who can reach the Settings page can point this at any program on the machine and have Rexarr run it
    with Rexarr's own permissions. On an instance other people can reach, turn on authentication
    (Settings → General → Security) before you add one.

## Encoding

**FFmpeg**

| Field | Key | Meaning |
| --- | --- | --- |
| ffmpeg binary | `ffmpegPath` | empty = auto-detect |
| ffprobe binary | `ffprobePath` | empty = auto-detect |
| Encodes at a time | `concurrency` | enforced from job creation, also on the Activity page |
| Import poll interval (s) | `pollIntervalSeconds` | how often a waiting job asks the \*arr app |
| Write encodes to | `transcodeTemp` | `transcodes` (then move) or `output` (next to the final file) |
| Stop stalled encodes after | `stallTimeoutMinutes` | minutes without progress; 0 = never |
| Keep this computer awake | `preventSleep` | see [Keeping the computer awake](../guide/disc-ripping.md#keeping-the-computer-awake) |

**Transcoding** — hardware acceleration method, device, hardware decoding, fall back to software, and the *Test*
button. See [Transcoding](../guide/transcoding.md).

**Defaults** — default profile per media type (`defaultProfiles.movie` / `.tv` / `.anime` / `.music`) and what
search shows (`remuxOnly`, `searchDiscReleases`).

## Automation

Auto transcode: `auto.enabled`, `auto.includeExisting`, `auto.sources.radarr` / `.sonarr`,
`auto.scanIntervalMinutes`, `auto.maxPerScan`, `auto.profiles.movie` / `.tv` / `.anime`. See
[Auto transcode](../guide/auto-transcode.md).

## Metadata

AniDB for anime (`anidb.enabled`), with a refresh button and the dataset status. See
[AniDB](../guide/anidb.md).

## Disc ripping

| Field | Key | Meaning |
| --- | --- | --- |
| Disc ripping | `disc.enabled` | watch optical drives (on by default) |
| makemkvcon binary | `disc.makemkvPath` | empty = auto-detect |
| Rip directory | `disc.ripDirectory` | where finished files are delivered; empty = `<config>/cache/rips` |
| Minimum title length (seconds) | `disc.minTitleSeconds` | skips trailers and menus. 600 for movies, 1200 for hour-long episodes, lower for short anime |
| Best audio per language / every track | `disc.audioMode` | `best` or `all`; per-title choices override it |
| Include extras and specials | `disc.includeExtras` | also list titles shorter than the minimum |
| Shortest extra (seconds) | `disc.extraMinSeconds` | default 30 |
| Drive poll interval (seconds) | `disc.pollIntervalSeconds` | |
| Start ripping automatically once identified | `disc.autoRip` | |
| Transcode with the default profile | `disc.autoTranscode` | |
| Hand finished files to Radarr / Sonarr | `disc.autoDeliver` | |
| Eject when done | `disc.autoEject` | |
| Keep the raw MakeMKV rip after transcoding | `disc.keepRaw` | |
| Import finished rips automatically | `disc.autoImport` | the 10-minute rip-folder sweep |
| Add shows and movies when their disc starts ripping | `disc.addMissing` | |
| Monitor what was added | `disc.addMonitored` | off by default, so nothing is downloaded |
| Where added titles go | `disc.addTargets` | root folder and quality profile per kind; empty = like your library |
| Virtual drives folder (testing) | `disc.virtualDriveDirectory` | a folder of `.iso` / disc folders |
| Audio CDs | `disc.cd` | FLAC compression, Linux TOC reader, MusicBrainz lookup, MQA detection, import into Lidarr |

Buttons on this page: **Check import access** (asks Radarr and Sonarr whether they can see the rip folder) and
**Import rip folder now**. See [Disc ripping](../guide/disc-ripping.md).

## Path mappings

Translate the paths Radarr / Sonarr / Lidarr report into paths on this machine — needed whenever the \*arr app runs
in Docker or on another host:

| Remote path (what the app says) | Local path (what Rexarr opens) | App |
| --- | --- | --- |
| `/data/media/movies` | `/Volumes/Media/Movies` | radarr |
| `/media` | `/Volumes/Media` | sonarr |

Rules: longest match wins; mappings apply both ways, so a rip folder on this machine is translated back into the
path the app expects when Rexarr asks it to import. **System → Status** flags files an app reports that Rexarr
cannot see, and *Check import access* does the same for the rip folder.
