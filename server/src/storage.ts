import fs from 'node:fs';
import path from 'node:path';
import type { StoragePath } from '../../shared/types.js';
import { PATHS } from './config.js';
import { store } from './store.js';

/** Recursive size with an entry cap so a huge rips folder cannot stall the request. */
function folderSize(dir: string, cap = 50_000): { bytes: number; files: number; truncated: boolean } {
  let bytes = 0;
  let files = 0;
  let seen = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++seen > cap) return { bytes, files, truncated: true };
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try {
          bytes += fs.statSync(p).size;
          files++;
        } catch {
          /* vanished */
        }
      }
    }
  }
  return { bytes, files, truncated: false };
}

let cache: { at: number; value: StoragePath[] } | null = null;

export function storagePaths(force = false): StoragePath[] {
  if (!force && cache && Date.now() - cache.at < 30_000) return cache.value;
  const ripDir = store.settings.disc.ripDirectory?.trim() || PATHS.rips;
  const defs: { id: StoragePath['id']; label: string; path: string; description: string; env: string; nested?: boolean }[] = [
    { id: 'cache', label: 'Cache', path: PATHS.cache, description: 'Regenerable data: images, in-progress encodes, raw rips', env: 'REXARR_CACHE_DIR' },
    { id: 'images', label: 'Image Cache', path: PATHS.images, description: 'Posters and backdrops from Radarr / Sonarr / TMDB', env: 'REXARR_IMAGE_CACHE_DIR', nested: true },
    { id: 'programData', label: 'Program Data', path: PATHS.programData, description: 'Settings, profiles, job and disc history, events', env: 'REXARR_PROGRAM_DATA_DIR' },
    { id: 'logs', label: 'Logs', path: PATHS.logs, description: 'rexarr.txt and rotated log files', env: 'REXARR_LOG_DIR' },
    { id: 'metadata', label: 'Metadata', path: PATHS.metadata, description: 'AniDB titles and Anime-Lists mappings', env: 'REXARR_METADATA_DIR', nested: true },
    { id: 'transcodes', label: 'Transcodes', path: PATHS.transcodes, description: store.settings.transcodeTemp === 'output' ? 'Unused – encodes are written next to their output' : 'Encodes in progress; moved into place when finished', env: 'REXARR_TRANSCODE_DIR', nested: true },
    { id: 'backups', label: 'Backups', path: PATHS.backups, description: 'Manual and scheduled configuration backups', env: 'REXARR_BACKUP_DIR', nested: true },
    { id: 'rips', label: 'Disc Rips', path: ripDir, description: ripDir === PATHS.rips ? 'Raw MakeMKV output before transcoding' : 'Raw MakeMKV output (set in Settings → Disc ripping)', env: 'REXARR_RIP_DIR', nested: true },
  ];
  const value = defs.map((d) => {
    const exists = fs.existsSync(d.path);
    let writable = false;
    let disk: StoragePath['disk'];
    if (exists) {
      try {
        fs.accessSync(d.path, fs.constants.W_OK);
        writable = true;
      } catch {
        writable = false;
      }
      try {
        const st = fs.statfsSync(d.path);
        const total = Number(st.blocks) * Number(st.bsize);
        const free = Number(st.bavail) * Number(st.bsize);
        disk = { totalBytes: total, freeBytes: free, usedBytes: Math.max(0, total - Number(st.bfree) * Number(st.bsize)) };
      } catch {
        disk = undefined;
      }
    }
    const size = exists ? folderSize(d.path) : { bytes: 0, files: 0, truncated: false };
    return { id: d.id, label: d.label, path: d.path, description: d.description, env: d.env, exists, writable, sizeBytes: size.bytes, fileCount: size.files, sizeTruncated: size.truncated, disk, overridden: Boolean(process.env[d.env]) };
  });
  cache = { at: Date.now(), value };
  return value;
}
