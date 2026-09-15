/**
 * Watches Lidarr's download queue for finished downloads that are album images with a cue sheet, which Lidarr
 * cannot import. Each one is split into FLAC tracks (fre:ac) inside the download folder under rexarr-split/, then
 * Lidarr is asked to import that folder for the same tracked download (DownloadedAlbumsScan + downloadClientId),
 * so the queue item completes as if the release had been split to begin with. Works for grabs made in Lidarr
 * itself as well as from rexarr's search. Soulseek downloads use splitFolderImages() before their import.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { store } from '../store.js';
import { bus } from '../events.js';
import { arr } from '../arr/index.js';
import { toArrPath, toLocalPath } from '../paths.js';
import { freacInfo, resolveFreac } from './freac.js';
import { findCueImages, splitCueImage, splitFolderFor, SPLIT_DIR, type CueImage } from './cue.js';

export interface CueSplitState {
  key: string;
  title: string;
  albumId?: number;
  path: string;
  status: 'splitting' | 'importing' | 'done' | 'failed';
  message: string;
  tracks?: number;
  error?: string;
  updatedAt: string;
}

const FILE = path.join(DATA_DIR, 'cue-splits.json');
let states: Record<string, CueSplitState> = {};
try {
  states = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Record<string, CueSplitState>;
  // a restart interrupts running splits: try them again
  for (const s of Object.values(states)) if (s.status === 'splitting') delete states[s.key];
} catch {
  /* none yet */
}
const save = () => {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(states, null, 2));
    fs.renameSync(tmp, FILE);
  } catch {
    /* best effort */
  }
};

const set = (s: Omit<CueSplitState, 'updatedAt'>) => {
  states[s.key] = { ...s, updatedAt: new Date().toISOString() };
  save();
  return states[s.key];
};

export function cueSplitStates(): CueSplitState[] {
  return Object.values(states).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function cueSplitForAlbum(albumId: number): CueSplitState | undefined {
  return cueSplitStates().find((s) => s.albumId === albumId);
}

/**
 * Split every cue image under `root` into rexarr-split/<album folder>. Returns the folder to import (the single
 * album folder, or rexarr-split/ when there are several discs) and the track count.
 */
export async function splitFolderImages(root: string, images: CueImage[], onLog: (l: string) => void, onProgress?: (pct: number) => void): Promise<{ importPath: string; tracks: number }> {
  const settings = store.settings;
  const fa = await freacInfo(settings.freacPath);
  if (!fa.available) throw new Error(`fre:ac is needed to split cue images: ${fa.error ?? 'freaccmd not found'}`);
  const base = fs.statSync(root).isDirectory() ? root : path.dirname(root);
  let tracks = 0;
  const outDirs: string[] = [];
  for (const [i, img] of images.entries()) {
    const outDir = splitFolderFor(img, base, images.length > 1);
    outDirs.push(outDir);
    const existing = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((f) => /\.flac$/i.test(f)) : [];
    if (existing.length === img.trackCount) {
      onLog(`${path.basename(outDir)}: already split (${existing.length} tracks)`);
      tracks += existing.length;
      continue;
    }
    fs.rmSync(outDir, { recursive: true, force: true });
    const files = await splitCueImage({
      freac: resolveFreac(settings.freacPath),
      ffmpeg: settings.ffmpegPath,
      image: img,
      outDir,
      hooks: { onLog, onProgress: (p) => onProgress?.(((i + p / 100) / images.length) * 100) },
    });
    tracks += files.length;
  }
  return { importPath: outDirs.length === 1 ? outDirs[0] : path.join(base, SPLIT_DIR), tracks };
}

const running = new Set<string>();

/** One pass over Lidarr's queue (called from the job queue's poll). */
export async function checkLidarrCueImages() {
  const { lidarr } = arr();
  if (!lidarr.configured || store.settings.lidarr.splitCueImages === false) return;
  const records = (await lidarr.queue()).records;
  const live = new Set<string>();
  for (const r of records) {
    const key = r.downloadId ? `dl:${r.downloadId}` : `q:${r.id}`;
    live.add(key);
    const prev = states[key];
    if (running.has(key) || (prev && prev.status !== 'failed')) continue;
    if (prev?.status === 'failed' && Date.now() - new Date(prev.updatedAt).getTime() < 30 * 60_000) continue;
    const finished = r.status === 'completed' || (r.size > 0 && r.sizeleft === 0) || /importPending|importBlocked|importFailed|failedPending/i.test(r.trackedDownloadState ?? '');
    if (!finished || !r.outputPath || /importing|imported/i.test(r.trackedDownloadState ?? '')) continue;
    const local = toLocalPath(r.outputPath, 'lidarr');
    if (!fs.existsSync(local)) continue;
    const images = findCueImages(local);
    if (!images.length) continue;
    running.add(key);
    void (async () => {
      const total = images.reduce((n, i) => n + i.trackCount, 0);
      const base = { key, title: r.title, albumId: r.albumId, path: local };
      set({ ...base, status: 'splitting', message: `Splitting ${images.length > 1 ? `${images.length} cue images` : 'cue image'} into ${total} tracks` });
      bus.notice('info', `${r.title}: cue image found – splitting into ${total} tracks for Lidarr`);
      appLog(`[cue] ${r.title}: ${images.map((i) => path.basename(i.cue)).join(', ')} in ${local}`);
      try {
        const { importPath, tracks } = await splitFolderImages(local, images, (l) => appLog(`[cue] ${l}`));
        await lidarr.importFolder(toArrPath(importPath, 'lidarr'), r.downloadId);
        set({ ...base, status: 'importing', tracks, message: `Split into ${tracks} tracks; Lidarr is importing ${path.basename(importPath)}` });
        bus.notice('info', `${r.title}: split into ${tracks} tracks, Lidarr is importing`);
      } catch (err) {
        const msg = (err as Error).message;
        set({ ...base, status: 'failed', error: msg, message: `Cue split failed: ${msg}` });
        bus.notice('error', `${r.title}: cue split failed – ${msg}`);
      } finally {
        running.delete(key);
      }
    })();
  }
  // Downloads that left the queue after importing: tidy up the split folder (Lidarr moved the tracks out)
  for (const s of Object.values(states)) {
    if (s.status !== 'importing' || live.has(s.key)) continue;
    const dir = path.join(fs.existsSync(s.path) && fs.statSync(s.path).isDirectory() ? s.path : path.dirname(s.path), SPLIT_DIR);
    removeIfNoAudio(dir);
    set({ ...s, status: 'done', message: `Imported by Lidarr (${s.tracks ?? '?'} tracks)` });
  }
  // forget finished entries after a week
  for (const s of Object.values(states)) if (s.status === 'done' && Date.now() - new Date(s.updatedAt).getTime() > 7 * 86400_000) delete states[s.key];
}

/** Remove a split folder once Lidarr has moved the tracks out of it (covers and empty folders only left). */
export function removeIfNoAudio(dir: string) {
  if (!fs.existsSync(dir)) return;
  const hasAudio = (d: string): boolean => fs.readdirSync(d, { withFileTypes: true }).some((e) => (e.isDirectory() ? hasAudio(path.join(d, e.name)) : /\.(flac|mp3|m4a|ogg|opus|wv|ape)$/i.test(e.name)));
  try {
    if (!hasAudio(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* leave it */
  }
}

function appLog(line: string) {
  console.log(line);
}
