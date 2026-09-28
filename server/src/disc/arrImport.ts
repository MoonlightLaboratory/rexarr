/**
 * Importing ripped files into Sonarr and Radarr.
 *
 * Asking Sonarr to scan a folder (DownloadedEpisodesScan) makes it guess the series from the folder name, and
 * "Naruto (2002) - Disc 1" is not a series name, so the import was silently skipped. Instead Rexarr uses Sonarr's
 * Manual Import: it reads Sonarr's analysis of every file (quality, languages, rejections), states the series and
 * episodes it already knows, and then checks that the files really left the rip folder.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Radarr } from '../arr/radarr.js';
import type { Sonarr } from '../arr/sonarr.js';
import { toArrPath, toLocalPath } from '../paths.js';

interface ManualImportItem {
  path: string;
  relativePath?: string;
  folderName?: string;
  series?: { id: number; title: string };
  episodes?: { id: number; seasonNumber: number; episodeNumber: number; absoluteEpisodeNumber?: number }[];
  quality?: { quality: { id: number; name: string; source?: string; resolution?: number }; revision: unknown };
  languages?: unknown[];
  releaseGroup?: string;
  indexerFlags?: number;
  rejections?: { reason: string }[];
}

interface SonarrEpisode {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  absoluteEpisodeNumber?: number;
}

/** What Rexarr knows about one ripped file. */
export interface KnownEpisode {
  season: number;
  /** Episode numbers within the season, or absolute numbers when `absolute` is set. */
  episodes: number[];
  absolute?: boolean;
}

export interface ImportOutcome {
  file: string;
  imported: boolean;
  /** Why it was not imported, or "imported". */
  detail: string;
}

const VIDEO = /\.(mkv|mp4|m4v|avi|ts|m2ts|webm)$/i;
// rejections that come from Sonarr not recognising the file, which the explicit series / episodes fix
const FIXABLE = /unknown|unable to (identify|parse)|not parse|(series|episode)s? (was )?not (found|matched)|matched to/i;

/**
 * Whether the *arr app can see a folder. A path mapping that points at a folder the app does not have is the usual
 * reason an import quietly does nothing while the scan command still reports success. The app's file browser answers
 * "folder" for any path, real or not, so the folder is looked for in the listing of its parent. Anything unexpected
 * (an old *arr version, no permission) counts as "cannot tell" and does not block the import.
 */
export async function canSeeFolder(client: { http: { get: <T>(p: string, q?: Record<string, string | number | boolean | undefined>, t?: number) => Promise<T> } }, arrDir: string): Promise<boolean> {
  const dir = arrDir.replace(/[\\/]+$/, '');
  const parent = dir.replace(/[^\\/]+$/, '');
  if (!parent || parent === dir) return true;
  try {
    const res = await client.http.get<{ directories?: { path: string }[] }>('/filesystem', { path: parent, includeFiles: 'false' }, 20_000);
    if (!Array.isArray(res.directories)) return true;
    const same = (a: string, b: string) => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();
    return res.directories.some((d) => same(d.path, dir));
  } catch {
    return true;
  }
}

/**
 * Import the video files of a local folder into Sonarr. With `seriesId` and `known`, Rexarr states the series and the
 * episodes of each file; otherwise Sonarr's own match per file is used. Files in an Extras folder are left alone.
 */
export async function importIntoSonarr(
  sonarr: Sonarr,
  localDir: string,
  opts: { seriesId?: number; known?: Map<string, KnownEpisode>; dvd?: boolean; log?: (line: string) => void } = {},
): Promise<ImportOutcome[]> {
  const log = opts.log ?? (() => {});
  const arrDir = toArrPath(localDir, 'sonarr');
  // Never pass seriesId here: with it, Sonarr ignores `folder` and lists the series' own unassigned library files.
  const candidates = await sonarr.http.get<ManualImportItem[]>('/manualimport', { folder: arrDir, filterExistingFiles: true }, 120_000);
  // and only ever touch files that really are in the folder being imported
  const items = candidates.filter((c) => isInsideFolder(localDir, toLocalPath(c.path, 'sonarr')) && VIDEO.test(c.path) && !/(^|[\\/])extras([\\/]|$)/i.test(c.relativePath ?? c.path));
  if (!items.length) return [];

  const episodesBySeries = new Map<number, SonarrEpisode[]>();
  const episodesOf = async (seriesId: number) => {
    if (!episodesBySeries.has(seriesId)) {
      let list = await sonarr.http.get<SonarrEpisode[]>('/episode', { seriesId });
      // a show added moments ago has no episodes until Sonarr has fetched them from TVDB
      for (let i = 0; !list.length && i < 30; i++) {
        if (i === 0) await sonarr.http.post('/command', { name: 'RefreshSeries', seriesId }).catch(() => undefined);
        await new Promise((r) => setTimeout(r, 2000));
        list = await sonarr.http.get<SonarrEpisode[]>('/episode', { seriesId });
      }
      episodesBySeries.set(seriesId, list);
    }
    return episodesBySeries.get(seriesId)!;
  };
  // DVD rips: Sonarr guesses "Bluray-576p" from the resolution; say what they are
  let dvdQuality: ManualImportItem['quality'] | undefined;
  if (opts.dvd) {
    const defs = await sonarr.http.get<{ quality: { id: number; name: string } }[]>('/qualitydefinition').catch(() => []);
    const dvd = defs.find((d) => d.quality.name.toLowerCase() === 'dvd');
    if (dvd) dvdQuality = { quality: dvd.quality, revision: { version: 1, real: 0, isRepack: false } };
  }

  const outcomes: ImportOutcome[] = [];
  const files: Record<string, unknown>[] = [];
  const pending: { local: string; name: string; seriesId: number; episodeIds: number[]; size: number }[] = [];
  for (const c of items) {
    const name = path.basename(c.path);
    const seriesId = opts.seriesId ?? c.series?.id;
    if (!seriesId) {
      outcomes.push({ file: name, imported: false, detail: 'Sonarr does not know which series this is' });
      continue;
    }
    let episodeIds = (c.episodes ?? []).map((e) => e.id);
    const known = opts.known?.get(name);
    if (known) {
      const all = await episodesOf(seriesId);
      const found = known.episodes.map((n) => all.find((e) => (known.absolute ? e.absoluteEpisodeNumber === n : e.seasonNumber === known.season && e.episodeNumber === n)));
      if (found.some((e) => !e)) {
        outcomes.push({ file: name, imported: false, detail: `${known.absolute ? 'absolute episode ' : `S${String(known.season).padStart(2, '0')}E`}${known.episodes.join(', ')} is not in Sonarr` });
        continue;
      }
      episodeIds = found.map((e) => e!.id);
    }
    if (!episodeIds.length) {
      outcomes.push({ file: name, imported: false, detail: 'no episode matched' });
      continue;
    }
    // what Sonarr would refuse anyway: not an upgrade, a sample, …
    const blocking = (c.rejections ?? []).filter((r) => !FIXABLE.test(r.reason));
    if (blocking.length) {
      outcomes.push({ file: name, imported: false, detail: blocking.map((r) => r.reason).join('; ') });
      continue;
    }
    files.push({
      path: c.path,
      folderName: c.folderName,
      seriesId,
      episodeIds,
      quality: dvdQuality ?? c.quality,
      languages: c.languages ?? [],
      releaseGroup: c.releaseGroup,
      indexerFlags: c.indexerFlags ?? 0,
      releaseType: episodeIds.length > 1 ? 'multiEpisode' : 'singleEpisode',
    });
    const local = toLocalPath(c.path, 'sonarr');
    pending.push({ local, name, seriesId, episodeIds, size: fs.existsSync(local) ? fs.statSync(local).size : 0 });
  }
  if (!files.length) return outcomes;

  log(`Asking Sonarr to import ${files.length} file(s) from ${arrDir}`);
  const cmd = await sonarr.http.post<{ id: number }>('/command', { name: 'ManualImport', importMode: 'move', files });
  // wait for Sonarr (a move on the same NAS is quick; a copy between volumes can take a while)
  const deadline = Date.now() + 15 * 60_000;
  let status = '';
  let message = '';
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const c = await sonarr.http.get<{ status: string; message?: string }>(`/command/${cmd.id}`).catch(() => null);
    status = c?.status ?? status;
    message = c?.message ?? message;
    if (['completed', 'failed', 'aborted', 'cancelled', 'orphaned'].includes(status)) break;
  }
  for (const p of pending) {
    // a network share can report a moved file for a few seconds; Sonarr's own record is the real answer
    let gone = false;
    for (let i = 0; i < 10 && !gone; i++) {
      gone = !fs.existsSync(p.local);
      if (!gone) await new Promise((r) => setTimeout(r, 1500));
    }
    const inSonarr = gone || (await episodesHaveFile(sonarr, p.seriesId, p.episodeIds, p.size));
    outcomes.push({ file: p.name, imported: inSonarr, detail: inSonarr ? 'imported' : status === 'completed' ? `Sonarr did not import it${message ? ` (${message})` : ''}` : `Sonarr import ${status || 'did not finish'}${message ? `: ${message}` : ''}` });
  }
  return outcomes;
}

/** Sonarr now has a file of this size for every one of these episodes. */
async function episodesHaveFile(sonarr: Sonarr, seriesId: number, episodeIds: number[], size: number): Promise<boolean> {
  try {
    const all = await sonarr.http.get<(SonarrEpisode & { hasFile?: boolean; episodeFileId?: number })[]>('/episode', { seriesId });
    const eps = all.filter((e) => episodeIds.includes(e.id));
    if (!eps.length || eps.some((e) => !e.hasFile || !e.episodeFileId)) return false;
    const file = await sonarr.http.get<{ size: number }>(`/episodefile/${eps[0].episodeFileId}`);
    return !size || file.size === size;
  } catch {
    return false;
  }
}

/**
 * What to tell the user when a delivery did not import everything, or null when it did. An *arr scan command reports
 * success even when it imported nothing, so the files themselves are what counts.
 */
export function deliveryProblem(app: string, dir: string, remote: string, outcomes: ImportOutcome[]): string | null {
  if (!outcomes.length) return `${app} found nothing to import in ${remote}. The files are in ${dir}.`;
  const failed = outcomes.filter((o) => !o.imported);
  if (!failed.length) return null;
  return `${app} imported ${outcomes.length - failed.length} of ${outcomes.length} file(s): ${failed.map((f) => `${f.file} – ${f.detail}`).join('; ')}. The files are in ${dir}.`;
}

/** Whether a file lies inside a folder (at any depth). */
export function isInsideFolder(folder: string, file: string): boolean {
  const rel = path.relative(path.resolve(folder), path.resolve(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Nothing is still being written into the folder: no encode in progress and no file touched in the last minutes. */
export function folderIsSettled(dir: string, minAgeMs = 2 * 60_000): boolean {
  let settled = true;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith('.rexarr-rip-')) walk(p);
      } else if (/\.rexarr\.\w+$/.test(e.name) || Date.now() - fs.statSync(p).mtimeMs < minAgeMs) settled = false;
    }
  };
  try {
    walk(dir);
  } catch {
    return false;
  }
  return settled;
}

interface RadarrImportItem {
  path: string;
  relativePath?: string;
  folderName?: string;
  movie?: { id: number; title: string };
  quality?: { quality: { id: number; name: string }; revision: unknown };
  languages?: unknown[];
  releaseGroup?: string;
  indexerFlags?: number;
  rejections?: { reason: string }[];
}

/**
 * Import the video files of a local folder into Radarr, the same way as for Sonarr: Radarr's Manual Import with the
 * movie Rexarr already knows, then a check that the file really was imported. A folder scan command reports success
 * even when Radarr could not see the folder at all.
 */
export async function importIntoRadarr(radarr: Radarr, localDir: string, opts: { movieId?: number; dvd?: boolean; log?: (line: string) => void } = {}): Promise<ImportOutcome[]> {
  const log = opts.log ?? (() => {});
  const arrDir = toArrPath(localDir, 'radarr');
  const candidates = await radarr.http.get<RadarrImportItem[]>('/manualimport', { folder: arrDir, filterExistingFiles: true }, 120_000);
  const items = candidates.filter((c) => isInsideFolder(localDir, toLocalPath(c.path, 'radarr')) && VIDEO.test(c.path) && !/(^|[\\/])extras([\\/]|$)/i.test(c.relativePath ?? c.path));
  if (!items.length) return [];

  let dvdQuality: RadarrImportItem['quality'] | undefined;
  if (opts.dvd) {
    const defs = await radarr.http.get<{ quality: { id: number; name: string } }[]>('/qualitydefinition').catch(() => []);
    const dvd = defs.find((d) => d.quality.name.toLowerCase() === 'dvd');
    if (dvd) dvdQuality = { quality: dvd.quality, revision: { version: 1, real: 0, isRepack: false } };
  }

  const outcomes: ImportOutcome[] = [];
  const files: Record<string, unknown>[] = [];
  const pending: { local: string; name: string; movieId: number; size: number }[] = [];
  for (const c of items) {
    const name = path.basename(c.path);
    const movieId = opts.movieId ?? c.movie?.id;
    if (!movieId) {
      outcomes.push({ file: name, imported: false, detail: 'Radarr does not know which movie this is' });
      continue;
    }
    const blocking = (c.rejections ?? []).filter((r) => !FIXABLE.test(r.reason));
    if (blocking.length) {
      outcomes.push({ file: name, imported: false, detail: blocking.map((r) => r.reason).join('; ') });
      continue;
    }
    files.push({ path: c.path, folderName: c.folderName, movieId, quality: dvdQuality ?? c.quality, languages: c.languages ?? [], releaseGroup: c.releaseGroup, indexerFlags: c.indexerFlags ?? 0 });
    const local = toLocalPath(c.path, 'radarr');
    pending.push({ local, name, movieId, size: fs.existsSync(local) ? fs.statSync(local).size : 0 });
  }
  if (!files.length) return outcomes;

  log(`Asking Radarr to import ${files.length} file(s) from ${arrDir}`);
  const cmd = await radarr.http.post<{ id: number }>('/command', { name: 'ManualImport', importMode: 'move', files });
  const deadline = Date.now() + 15 * 60_000;
  let status = '';
  let message = '';
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const c = await radarr.http.get<{ status: string; message?: string }>(`/command/${cmd.id}`).catch(() => null);
    status = c?.status ?? status;
    message = c?.message ?? message;
    if (['completed', 'failed', 'aborted', 'cancelled', 'orphaned'].includes(status)) break;
  }
  for (const p of pending) {
    let gone = false;
    for (let i = 0; i < 10 && !gone; i++) {
      gone = !fs.existsSync(p.local);
      if (!gone) await new Promise((r) => setTimeout(r, 1500));
    }
    const imported = gone || (await movieHasFile(radarr, p.movieId, p.size));
    outcomes.push({ file: p.name, imported, detail: imported ? 'imported' : status === 'completed' ? `Radarr did not import it${message ? ` (${message})` : ''}` : `Radarr import ${status || 'did not finish'}${message ? `: ${message}` : ''}` });
  }
  return outcomes;
}

async function movieHasFile(radarr: Radarr, movieId: number, size: number): Promise<boolean> {
  try {
    const m = await radarr.http.get<{ hasFile?: boolean; movieFile?: { size?: number } }>(`/movie/${movieId}`);
    return Boolean(m.hasFile) && (!size || m.movieFile?.size === size);
  } catch {
    return false;
  }
}
