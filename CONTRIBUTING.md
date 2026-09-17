# How to Contribute

We're always looking for people to help make Rexarr better. There are a few ways to contribute, from
reporting bugs to writing code.

> [!NOTE]
> Rexarr is in **beta**. Expect larger changes than usual between releases; if you plan a big change, open an
> issue or discussion first so work does not collide.

## Reporting bugs and requesting features

- Search the [existing issues](https://github.com/MoonlightLaboratory/rexarr/issues) first.
- Use the issue templates. For bugs include your Rexarr version (System → Status → *Report an issue* fills it in),
  how you run it (Docker / source, OS), the profile involved and the relevant part of the log
  (System → Log Files, or the job log in Activity).
- **Remove API keys, passwords, hostnames and personal paths** from logs and screenshots before posting.
- Security issues are not reported in public issues – see [SECURITY.md](SECURITY.md).

## Versions

Rexarr uses four-part versions, `major.backend.feature.minor`:

| Version | Means |
| --- | --- |
| `0.0.0.X` | fixes, wording and other small changes |
| `0.0.X.0` | a new feature or page |
| `0.X.0.0` | backend work: server, storage layout, API or settings |
| `X.0.0.0` | a rewrite, or a release that breaks compatibility |

Maintainers bump it with `node scripts/bump-version.mjs <level>`; leave it alone in pull requests.

## Development

### Tools required

- [Node.js](https://nodejs.org/) 22.12 or later (npm comes with it)
- [FFmpeg](https://ffmpeg.org/) 6 or later on the `PATH`
- Optional: [MakeMKV](https://www.makemkv.com/) for disc ripping, [fre:ac](https://www.freac.org/) for music
- An editor with TypeScript support (VS Code, WebStorm, …)
- Radarr / Sonarr / Lidarr instances to test against are useful, but the test bench works without them

### Getting started

1. [Fork](https://github.com/MoonlightLaboratory/rexarr/fork) the repository and clone your fork
2. Install dependencies: `npm install`
3. Start the development servers: `npm run dev`
   - API server on http://localhost:3939 (restarts on changes)
   - Vite UI on http://localhost:7979 (hot reload, proxies the API)
4. Data goes to `./data` by default; set `REXARR_CONFIG_DIR` to use a throw-away folder
5. Optional: `npm run test-media` builds sample remuxes and disc images for testing without real media
   (see [Test bench](docs/README.md#test-bench-transcoding--disc-ripping-without-hardware))

### Before you open a pull request

```bash
npm run typecheck   # server and client
npm test            # server unit tests
npm run build       # production build of both
```

All three must pass; CI builds the Docker image for every pull request.

### Contributing code

- Branch from `main`, and use a descriptive branch name (`fix/cue-shift-jis`, `feature/opus-surround`); never
  work on your fork's `main`
- Keep a pull request to one feature or fix; split large changes
- Match the surrounding code: TypeScript everywhere, comment density and naming like the file you are in,
  the \*arr look for UI (see [Design](docs/README.md#design))
- Add or update tests next to the code (`*.test.ts`) for parsing, naming, estimates and other pure logic
- Update [the documentation](docs/README.md) when behaviour or settings change
- Commit messages: a short summary line, then what changed and why
- Rebase on `main` rather than merging `main` into your branch

### Pull requests

- We'll review as soon as we can; feedback may ask for changes
- Pull requests that only change code style or reformat files are unlikely to be merged
- Screenshots or a short recording help for UI changes (hide personal data)

## License of contributions

Rexarr is licensed under the [GNU GPL v3 or later](LICENSE.md). There is no separate contributor agreement: by
submitting a contribution you agree that it is licensed under the same terms as the project, and you confirm
that you have the right to contribute it.
