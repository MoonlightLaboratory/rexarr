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
| Bazarr | `bazarr` | optional. Told to look at the disk and search for missing subtitles once a disc has been imported, rather than waiting for its own schedule. See [the guide](../guide/disc-ripping.md#subtitles-with-bazarr) |
| Lidarr | URL, API key, split image + cue downloads | API v1, enables the Music page |
| slskd | URL, API key, download folder, max peer queue | Soulseek album search |
| fre:ac | `freaccmd` path | empty = auto-detect |
| Tesseract | on / off, `tesseract` path | `ocr.enabled`, `ocr.tesseractPath`; empty path = auto-detect. Off copies picture subtitles as they are, whatever a profile asks for |
| Rip farm | on / off, approval, how many encodes to keep here | `agents.*`; see [Rip farm](../guide/rip-farm.md) |
| Local media | extra folders, scan interval, folder kinds | see [Local media](../guide/local-media.md) |
| MusicBrainz | on / off | CD and album lookups, Cover Art Archive |
| TheDiscDB | on / off | barcodes and disc contents for physical releases |
| OMDb | on / off, API key | `omdb.*`; genre, year and kind for titles the \*arr apps do not have |
| RexDB | on / off, index URL, when to contribute | `rexdb.*`; which episode is on which disc, from the shared database |
| CDDB / freedb | on / off, server | audio CD track titles when MusicBrainz has none |
| Notifications | any number of targets | see below |

### Notifications

**Add notification** opens a picker of the kinds below; add as many as you like, and each one chooses its own
events, so the phone can get failures only while a channel gets everything.

| Event | Sent when |
| --- | --- |
| `disc.inserted` | a disc is found in a drive, before it has been read |
| `rip.started` | MakeMKV has begun copying it |
| `rip.done` · `rip.failed` | the disc finished, or did not |
| `encode.done` · `encode.failed` | an encode finished, or did not |
| `import.done` | the files reached Radarr or Sonarr |
| `update.available` | a newer Rexarr is out |

`import.done` is not the same as `rip.done`: a rip with **Hand to Radarr / Sonarr** turned off finishes without
importing anything, and only the rips that were actually delivered send it. The first two are the ones something
else can act on while the disc is still in the drive — a light that says the drive is busy, a flow that starts
when a disc goes in — rather than only reporting afterwards.

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
| Title inside the file | `fileMetadata.title` | `clean` writes "Naruto - S01E01"; `none` writes no title at all. Plex and Jellyfin both read this tag and Jellyfin can be told to prefer it over the name it matched |
| Encoded-by comment | `fileMetadata.comment` | the "Encoded by Rexarr…" note inside the file |