# Development

The repository is one npm workspace: `server/` (Fastify 5 + TypeScript), `client/` (React 19 + Vite), `shared/`
(types, presets, version) and `scripts/` (packaging, versioning, test media).

```bash
npm install
npm run dev     # Vite on :7979, API on :3939
npm run build
npm test        # node --import tsx --test "src/**/*.test.ts"
npm run lint
```

See [CONTRIBUTING.md](https://github.com/MoonlightLaboratory/rexarr/blob/main/CONTRIBUTING.md) for the contribution
guide and [AGENTS.md](https://github.com/MoonlightLaboratory/rexarr/blob/main/AGENTS.md) for the notes AI coding
agents are expected to follow.

## Test bench

Transcoding and disc ripping can be exercised without a disc or a GPU:

```bash
npm run test-media          # writes ./test-media (gitignored)
```

This generates, with ffmpeg only:

| Path | What it is |
| --- | --- |
| `Movies/Test Movie (2024)/Test.Movie.2024.1080p.BluRay.REMUX.mkv` | 1080p h264, FLAC English + Japanese, SRT eng/jpn, chapters |
| `TV/Test Show/Season 01/… S01E01/E02 … Remux.mkv` | two "episodes" with the same layout |
| `hdr/Test.HDR.2160p.BluRay.REMUX.mkv` | 10-bit HEVC tagged BT.2020 / PQ with HDR10 metadata (needs libx265) |
| `discs/TEST_DVD.iso` + `discs/TEST_DVD_FOLDER/VIDEO_TS` | a real DVD-Video (two titles, two audio languages) — needs `dvdauthor` (`brew install dvdauthor` / `apt install dvdauthor`) |

**Transcoding**: queue any of the MKVs directly (`POST /api/jobs` with `source.localPath`, or add `test-media/Movies`
as a Radarr root folder and use the library pages). Every built-in profile has been run against these.

**Disc ripping**: set **Settings → Disc ripping → Virtual drives folder** to `test-media/discs`. Every `.iso` /
`.img` file and every DVD or Blu-ray folder (`VIDEO_TS`, `BDMV`) there appears on the **Discs** page as a loaded
*virtual* drive. Rexarr feeds it to the real `makemkvcon` through its `iso:` / `file:` sources, so scanning,
identification, ripping, transcoding and \*arr delivery run exactly as with a physical disc; only eject is a no-op.

## Design conventions

The UI follows the \*arr frontend conventions so it feels like Sonarr / Radarr: a 60px header with global search, a
210px sidebar with status messages, a 60px per-page toolbar with icon-over-label buttons and sort / filter menus,
`#202020` page body, `#333` cards, filled labels, 4px-radius buttons and inputs, poster grids with episode progress
bars, backdrop detail headers and season blocks. The colour tokens in `client/src/styles.css` are named after
Sonarr's theme variables (dark and light themes; toggle in the header) with Radarr's yellow as the accent. The
styles are Rexarr's own implementation of that look, not copied source.

## Versions

Versions are `major.backend.feature.minor`:

| Part | Raised for |
| --- | --- |
| `X.0.0.0` | a rewrite, or a release that breaks compatibility |
| `0.X.0.0` | backend work: server, storage layout, API, settings |
| `0.0.X.0` | a new feature or page |
| `0.0.0.X` | fixes and small changes |

```bash
node scripts/bump-version.mjs feature   # major | backend | feature | minor, or an exact 0.2.0.0
```

The script updates `shared/version.ts` (the only place the version lives), the `package.json` files, the Dockerfile
label, the issue template and the docs, and starts `docs/release-notes/<version>.md`.

## Publishing a release (maintainers)

1. Bump the version and fill in the release notes it created.
2. Push to `main`, then **Actions → Release → Run workflow** (or push a tag `v<version>`).
3. The workflow builds every package with `scripts/package.mjs`, builds the Windows installers with Inno Setup
   (`distribution/windows/rexarr.iss`), starts the packages on Linux x64 / arm64, Alpine, macOS and Windows
   (`scripts/smoke-test.sh`), then publishes the GitHub release and the
   `ghcr.io/moonlightlaboratory/rexarr:<version>` image. Pre-release is ticked by default while Rexarr is in beta.

Build packages locally:

```bash
npm run build && node scripts/package.mjs --targets osx-arm64-app,linux-x64
```

Node runtimes are downloaded from nodejs.org and checked against their SHA-256 sums; output lands in `release/`.

## This documentation

The site is [MkDocs Material](https://squidfunk.github.io/mkdocs-material/) built from `docs/` and published to
GitHub Pages by `.github/workflows/docs.yml` on every push to `main` that touches the docs.

```bash
pip install mkdocs-material
mkdocs serve            # http://127.0.0.1:8000
mkdocs build --strict   # what CI runs
```

Pages are plain Markdown and stay readable on GitHub. Keep `mkdocs.yml`'s `nav` in step when adding a page.
