import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export { APP_VERSION, REPO_URL } from '../../shared/version.js';
export const PORT = Number(process.env.REXARR_PORT ?? process.env.PORT ?? 7878);
export const HOST = process.env.REXARR_HOST ?? '0.0.0.0';
/** Root of everything rexarr stores (the Docker /config volume). REXARR_DATA_DIR is accepted for compatibility. */
export const CONFIG_DIR = path.resolve(process.env.REXARR_CONFIG_DIR ?? process.env.REXARR_DATA_DIR ?? path.join(process.cwd(), 'data'));
export const LOG_LINES_KEPT = 400;

const env = (name: string, fallback: string) => path.resolve(process.env[name] ?? fallback);

/**
 * Storage layout (Jellyfin-style), each overridable by an environment variable:
 *
 *   Cache          <config>/cache              REXARR_CACHE_DIR
 *   Image Cache    <cache>/images              REXARR_IMAGE_CACHE_DIR
 *   Transcodes     <cache>/transcodes          REXARR_TRANSCODE_DIR    in-progress encodes
 *   Disc rips      <cache>/rips                REXARR_RIP_DIR          default raw MakeMKV output
 *   Program Data   <config>/data               REXARR_PROGRAM_DATA_DIR settings, profiles, history
 *   Metadata       <data>/metadata             REXARR_METADATA_DIR     AniDB datasets
 *   Backups        <data>/backups              REXARR_BACKUP_DIR
 *   Logs           <config>/log                REXARR_LOG_DIR
 */
const cache = env('REXARR_CACHE_DIR', path.join(CONFIG_DIR, 'cache'));
const programData = env('REXARR_PROGRAM_DATA_DIR', path.join(CONFIG_DIR, 'data'));
export const PATHS = {
  config: CONFIG_DIR,
  cache,
  images: env('REXARR_IMAGE_CACHE_DIR', path.join(cache, 'images')),
  transcodes: env('REXARR_TRANSCODE_DIR', path.join(cache, 'transcodes')),
  rips: env('REXARR_RIP_DIR', path.join(cache, 'rips')),
  programData,
  metadata: env('REXARR_METADATA_DIR', path.join(programData, 'metadata')),
  backups: env('REXARR_BACKUP_DIR', path.join(programData, 'backups')),
  logs: env('REXARR_LOG_DIR', path.join(CONFIG_DIR, 'log')),
};
/** Where the JSON state files live (kept as a name so existing imports keep working). */
export const DATA_DIR = PATHS.programData;

/** Move a file or folder, falling back to copy + delete across devices. */
function moveSync(from: string, to: string) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

/** One-time migration from the old flat layout (<config>/settings.json, images/, logs/, anidb/, backups/, rips/). */
function migrateLayout() {
  const moves: [string, string][] = [
    ...['settings.json', 'profiles.json', 'jobs.json', 'rips.json', 'events.json', 'auto.json'].map((f) => [path.join(CONFIG_DIR, f), path.join(PATHS.programData, f)] as [string, string]),
    [path.join(CONFIG_DIR, 'images'), PATHS.images],
    [path.join(CONFIG_DIR, 'logs'), PATHS.logs],
    [path.join(CONFIG_DIR, 'anidb'), PATHS.metadata],
    [path.join(CONFIG_DIR, 'backups'), PATHS.backups],
    [path.join(CONFIG_DIR, 'rips'), PATHS.rips],
  ];
  const done: string[] = [];
  for (const [from, to] of moves) {
    try {
      if (from === to || !fs.existsSync(from) || fs.existsSync(to)) continue;
      moveSync(from, to);
      done.push(`${path.relative(CONFIG_DIR, from)} → ${path.relative(CONFIG_DIR, to) || to}`);
    } catch (err) {
      console.error(`[rexarr] could not migrate ${from} to ${to}: ${(err as Error).message}`);
    }
  }
  for (const dir of Object.values(PATHS)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* reported on the System page */
    }
  }
  if (done.length) console.log(`[rexarr] moved to the new storage layout: ${done.join(', ')}`);
  return done;
}
export const MIGRATED = migrateLayout();

/** Locate the built client bundle: env override, else walk up from this file looking for client/dist. */
function findClientDist(): string {
  if (process.env.REXARR_CLIENT_DIR) return path.resolve(process.env.REXARR_CLIENT_DIR);
  let dir = here;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'client', 'dist');
    if (fs.existsSync(path.join(candidate, 'index.html'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(here, '..', '..', 'client', 'dist');
}
export const CLIENT_DIST = findClientDist();
