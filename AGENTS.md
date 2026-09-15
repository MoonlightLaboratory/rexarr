# AGENTS.md

Guidance for AI coding agents working in this repository. Humans: see [CONTRIBUTING.md](CONTRIBUTING.md).

## Project

rexarr is a Node.js / TypeScript web app: a Fastify API server and a React (Vite) client, sharing types.
It orchestrates FFmpeg, fre:ac and MakeMKV and talks to Radarr / Sonarr / Lidarr / Prowlarr / slskd.
Status: beta.

```
server/src/        Fastify server (ESM, TypeScript)
  routes/          HTTP API, one file per area (jobs, search, music, local, estimate, …)
  jobs/queue.ts    encode queue: waiting for imports, running ffmpeg / fre:ac, watchdog
  ffmpeg/          probe, argument builder (args.ts), naming, hardware mapping, size estimate
  arr/             Radarr / Sonarr / Lidarr / Prowlarr / slskd clients
  disc/            MakeMKV, drives, rip manager
  music/           fre:ac, MusicBrainz, cue sheets, Soulseek imports
  library/         local media scan and metadata
  search/          query parsing, smart search, release ranking
client/src/        React UI (pages/, components/, styles.css)
shared/            types.ts, presets.ts (built-in profiles, defaults), version.ts
docs/README.md     full documentation
```

## Commands

```bash
npm install
npm run dev         # API :7878 + Vite :7979
npm run typecheck   # both packages
npm test            # server tests: node --test with tsx, files src/**/*.test.ts
npm run build       # client then server
npm start           # serve the production build on :7878
```

Run `npm run typecheck` and `npm test` after changes; run `npm run build` before finishing.

## Conventions

- ESM everywhere; server imports use `.js` extensions (`import { x } from './file.js'`)
- Types shared between server and client live in `shared/types.ts`; new settings get a default in
  `shared/presets.ts`, a zod schema entry in `server/src/routes/settings.ts` and a merge in `server/src/store.ts`
- The version lives only in `shared/version.ts` (`package.json` keeps a three-part npm version)
- Match the style of the file you edit: comment density, naming, small pure helpers with tests
- UI follows the *arr frontend look; reuse existing classes in `client/src/styles.css` and components
  (`Page`, `ToolbarButton`, `Modal`, `DetailHeader`, `Labels`) instead of new patterns
- Long-running external work (ffmpeg, fre:ac, network shares) needs timeouts and must not block the event loop
- Never commit `data/`, `test-media/`, API keys, hostnames or personal paths (tests use generic examples)

## Testing tips

- Pure logic (parsers, naming, estimates, scoring) is unit tested; add cases next to existing ones
- `npm run test-media` generates sample remuxes / disc images; point a test instance at them with
  `REXARR_CONFIG_DIR=<tmp> REXARR_PORT=7879 npm start`
