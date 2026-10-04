# API

Rexarr's UI is a client of its own HTTP API; everything it does can be scripted.

## Authentication

With authentication off and a local request, nothing is needed. Otherwise send the API key
(**Settings → General → Security**):

```bash
curl -H "X-Api-Key: $KEY" http://localhost:3939/api/system
curl "http://localhost:3939/api/system?apikey=$KEY"
```

Session cookies are for the UI. `GET /api/health` is always public (`{ "ok": true, "version": "0.1.6.0" }`) — the
Docker `HEALTHCHECK` uses it.

## Library

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/library/movies` | Radarr movies with what is on disk |
| GET | `/api/library/movies/:id` | one movie with its files |
| GET | `/api/library/series` | Sonarr series |
| GET | `/api/library/series/:id` | one series |
| GET | `/api/library/series/:id/episodes` | episodes with files and quality |

## Search

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/search/smart?q=` | library + lookup + local, with parsed query chips |
| GET | `/api/search/local?q=` | local media index only |
| GET | `/api/search/lookup?q=` | TMDB / TVDB through Radarr / Sonarr |
| POST | `/api/search/add` | add a title to Radarr / Sonarr |
| POST | `/api/search/grab` | grab a release and create a job |

## Jobs, queue and events

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/jobs` | job list |
| POST | `/api/jobs` | create a job (`source.localPath` or an \*arr file id, plus `profileId`) |
| POST | `/api/jobs/bulk` | many jobs at once |
| POST | `/api/jobs/:id/cancel` · `/retry` · `/reorder` | job actions |
| DELETE | `/api/jobs/:id` | remove a finished job |
| GET | `/api/jobs/:id/log` | the full ffmpeg log |
| GET | `/api/queue` | queue state |
| POST | `/api/queue/limit` · `/api/queue/pause` | encodes at a time, pause / resume |
| POST | `/api/jobs/retry-failed` · `/api/jobs/clear` | bulk queue actions |
| GET | `/api/events` | server-sent events for live UI updates |

## Preview and estimates

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/jobs/:id/preview/live.jpg` | current source frame while encoding |
| GET | `/api/jobs/:id/preview/encoded.jpg` | frame from the file being written |
| GET | `/api/jobs/:id/frame?which=source\|output&t=&w=` | a frame at a timestamp |
| POST | `/api/estimate` | estimated output size for a profile and file |
| GET | `/api/image?url=` | cached poster / backdrop proxy |

## Profiles

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/profiles` | profiles and built-in presets |
| POST | `/api/profiles` · PUT `/api/profiles/:id` · DELETE `/api/profiles/:id` | manage profiles |
| POST | `/api/profiles/:id/clone` | clone (the only way to change a preset) |
| POST | `/api/profiles/preview` | the ffmpeg command and output name a profile would produce |

## Discs

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/disc/status` | MakeMKV info, drives, whether ripping is enabled |
| GET | `/api/disc/rips` | all discs and rips |
| POST | `/api/disc/detect` | poll the drives now |
| POST | `/api/disc/open` | open an image or disc folder by path |
| GET | `/api/disc/drives/candidates` | optical devices found on the machine |
| POST | `/api/disc/drives` · DELETE `/api/disc/drives/:id` | drives added by device path |
| GET/POST | `/api/disc/virtual` · DELETE `/api/disc/virtual/:id` | linked images as virtual drives |
| POST | `/api/disc/rips/:id/scan` · `/identify` · `/start` · `/cancel` | rip lifecycle |
| PATCH | `/api/disc/rips/:id` | media match, selected titles, episode map, roles, audio, options |
| POST | `/api/disc/rips/:id/estimate` | rip and encode size for a selection |
| POST | `/api/disc/rips/:id/add-to-library` | add the show / movie to Sonarr / Radarr now |
| DELETE | `/api/disc/rips/:id` | forget a rip |
| GET | `/api/disc/rip-directory/check` | can Radarr / Sonarr see the rip folder? |
| POST | `/api/disc/import-rips` | import what is left in the rip folder |
| POST | `/api/disc/drives/:index/cd` | read an audio CD |
| POST | `/api/disc/rips/:id/musicbrainz` | choose a MusicBrainz release for a CD |
| POST | `/api/disc/drives/:index/eject` | eject |

## Music

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/music/artists` · `/api/music/artists/:id` | Lidarr artists |
| GET | `/api/music/albums` · `/api/music/albums/:id` | albums and tracks |
| POST | `/api/music/mqa` | scan files for MQA |
| POST | `/api/music/add` | add an artist / album through Lidarr |
| GET | `/api/music/cue-splits` | image + cue splits in progress |
| POST | `/api/music/import-folder` | import a folder through Lidarr |
| GET | `/api/music/freac` | fre:ac version and encoders |
| GET | `/api/musicbrainz/search` | release search |
| GET | `/api/media/metadata?path=` | every tag, stream and format detail of a file |

## Local media

`GET /api/local/status`, `POST /api/local/scan`, `GET /api/local/items`, `GET /api/local/items/:id`,
`GET /api/local/items/:id/candidates`, `POST /api/local/items/:id/match`, `POST /api/local/metadata/refresh`,
`GET /api/local/items/:id/poster`.

## Automation and metadata

`GET /api/auto/status`, `POST /api/auto/scan[?dryRun=1]`, `POST /api/auto/reset`, `POST /api/webhook/radarr|sonarr`,
`GET /api/anidb/status`, `POST /api/anidb/refresh`, `GET /api/anidb/search?q=`.

## Settings and system

| Method | Path | Description |
| --- | --- | --- |
| GET/PUT | `/api/settings` | all settings |
| GET | `/api/settings/host` | host settings (port, bind, URL base, SSL) |
| POST | `/api/settings/apikey` | reset the API key |
| POST | `/api/settings/test/:app` | test a connection (`radarr`, `sonarr`, `prowlarr`, `lidarr`, `slskd`) |
| GET | `/api/settings/arr-options` | root folders and quality profiles from the \*arr apps |
| GET | `/api/system` · `/api/system/health` · `/api/system/ffmpeg` | status, health checks, encoders |
| GET | `/api/system/paths` | storage layout with sizes |
| GET/DELETE | `/api/system/events` | the Events list |
| GET | `/api/system/tasks` · POST `/api/system/tasks/:id/run` | scheduled tasks |
| GET/POST | `/api/system/backups` · GET/DELETE `/api/system/backups/:name` | backups |
| POST | `/api/system/backups/:name/restore` · `/api/system/backups/restore` | restore a backup or an upload |
| GET | `/api/system/logs` · `/api/system/logs/:name` · DELETE `/api/system/logs` | log files |
| POST | `/api/system/shutdown` · `/api/system/restart` | stop or restart the server |
| GET | `/api/transcoding/devices` · POST `/api/transcoding/test` | hardware devices and the encode test |
| GET | `/api/setup/tools` · POST `/api/setup/dismiss` | the first-run tools check |
| GET | `/api/fs/list?path=` | the server-side folder browser used by the UI |

!!! note "The API is still beta"
    Endpoints and payloads can change between releases while Rexarr is in beta. The
    [release notes](../release-notes.md) call out breaking changes, and the version's second number
    (`major.`**`backend`**`.feature.minor`) is raised when the API or storage layout changes.
