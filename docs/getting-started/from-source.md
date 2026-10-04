# Run from source

```bash
npm install
npm run build
npm start          # http://localhost:3939
```

Development, with the Vite dev server on `:7979` proxying to the API on `:3939`:

```bash
npm run dev
```

Tests:

```bash
npm test
```

The repository is one npm workspace with four parts:

| Folder | What it is |
| --- | --- |
| `server/` | Fastify 5 + TypeScript API, the queue, the \*arr clients, ffmpeg / MakeMKV / fre:ac handling |
| `client/` | React 19 + Vite UI |
| `shared/` | Types, built-in presets and the version (`shared/version.ts` is the only place the version lives) |
| `scripts/` | Packaging, version bump, test media, smoke tests |

See [Development](../development.md) for the test bench, the design conventions and how releases are published, and
[Storage and environment](../reference/storage.md) for every environment variable and folder.
