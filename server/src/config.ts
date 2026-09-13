import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const APP_VERSION = '0.1.0';
export const PORT = Number(process.env.REXARR_PORT ?? process.env.PORT ?? 7878);
export const HOST = process.env.REXARR_HOST ?? '0.0.0.0';
export const DATA_DIR = path.resolve(process.env.REXARR_DATA_DIR ?? path.join(process.cwd(), 'data'));
export const LOG_LINES_KEPT = 400;

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
