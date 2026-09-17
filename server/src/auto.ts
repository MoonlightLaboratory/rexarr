/**
 * Auto-transcode: finds Blu-ray remux files in Radarr / Sonarr and queues them with the right profile.
 *
 * Runs on a schedule (System → Tasks) and immediately when Radarr / Sonarr call the webhook after an import.
 * Every file it has seen is remembered by path in data/auto.json, together with every file Rexarr wrote,
 * so a transcode that Radarr / Sonarr re-import (still named "REMUX") is never picked up again.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AutoScanItem, AutoScanResult, AutoStatus, Job } from '../../shared/types.js';
import { DATA_DIR } from './config.js';
import { store } from './store.js';
import { arr } from './arr/index.js';
import { queue } from './jobs/queue.js';
import { anidb } from './anidb.js';
import { enrichMovie, enrichSeries } from './enrich.js';
import { appEvents } from './system.js';

interface AutoState {
  /** When the "ignore what is already in the library" baseline was taken. */
  baselineAt?: string;
  /** localPath -> why it is known */
  seen: Record<string, { at: string; reason: 'queued' | 'baseline' | 'output' | 'existing-job'; jobId?: string }>;
  lastScan?: AutoScanResult;
}

const FILE = path.join(DATA_DIR, 'auto.json');
let state: AutoState = { seen: {} };
try {
  if (fs.existsSync(FILE)) {
    const loaded = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Partial<AutoState>;
    state = { ...loaded, seen: loaded.seen ?? {} };
  }
} catch {
  state = { seen: {} };
}
function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(state));
    fs.renameSync(`${FILE}.tmp`, FILE);
  } catch {
    /* ignore */
  }
}

let scanning: Promise<AutoScanResult> | null = null;
let webhookTimer: NodeJS.Timeout | null = null;

function profileFor(mediaType: 'movie' | 'tv' | 'anime') {
  const s = store.settings;
  const id = s.auto.profiles[mediaType] || s.defaultProfiles[mediaType];
  return store.getProfile(id) ?? store.getProfile(s.defaultProfiles[mediaType]);
}

/** Run `fn` over `list` with at most `n` in flight. */
async function pool<T>(list: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
    while (i < list.length) await fn(list[i++]);
  }));
}

/** Collect every remux file Radarr / Sonarr currently report. */
async function candidates(): Promise<{ items: AutoScanItem[]; errors: string[] }> {
  const s = store.settings;
  const { radarr, sonarr } = arr();
  const items: AutoScanItem[] = [];
  const errors: string[] = [];
  await anidb.ensure();

  if (s.auto.sources.radarr && radarr.configured) {
    try {
      for (const raw of await radarr.movies()) {
        const m = enrichMovie(raw);
        if (!m.file?.isRemux) continue;
        items.push({
          arr: 'radarr',
          arrId: m.id,
          fileId: m.file.id,
          title: `${m.title} (${m.year})`,
          poster: m.poster,
          path: m.file.path,
          localPath: m.file.localPath,
          quality: m.file.quality,
          sizeBytes: m.file.size,
          mediaType: m.anime ? 'anime' : 'movie',
        });
      }
    } catch (err) {
      errors.push(`Radarr: ${(err as Error).message}`);
    }
  }

  if (s.auto.sources.sonarr && sonarr.configured) {
    try {
      // Read episode files directly (not the cached remux counts) so a fresh import is seen on the next scan.
      // Episode details are only fetched for series that actually have an unseen remux.
      const list = (await sonarr.series()).map(enrichSeries);
      await pool(list, 6, async (series) => {
        let files: Awaited<ReturnType<typeof sonarr.episodeFiles>>;
        try {
          files = (await sonarr.episodeFiles(series.id)).filter((f) => f.isRemux);
        } catch (err) {
          errors.push(`Sonarr ${series.title}: ${(err as Error).message}`);
          return;
        }
        if (!files.length) return;
        const mediaType = series.seriesType === 'anime' || series.anidbIds?.length ? 'anime' : 'tv';
        const unseen = files.filter((f) => !state.seen[f.localPath]);
        const episodes = unseen.length ? await sonarr.episodes(series.id).catch(() => []) : [];
        for (const f of files) {
          const e = episodes.find((x) => x.file?.id === f.id);
          items.push({
            arr: 'sonarr',
            arrId: series.id,
            fileId: f.id,
            episodeIds: e ? [e.id] : undefined,
            seasonNumber: f.seasonNumber,
            title: series.title,
            subtitle: e ? `S${String(e.seasonNumber).padStart(2, '0')}E${String(e.episodeNumber).padStart(2, '0')} · ${e.title}` : path.basename(f.path),
            poster: series.poster,
            path: f.path,
            localPath: f.localPath,
            quality: f.quality,
            sizeBytes: f.size,
            mediaType,
          });
        }
      });
    } catch (err) {
      errors.push(`Sonarr: ${(err as Error).message}`);
    }
  }
  return { items, errors };
}

/** Files Rexarr produced (outputs of any job) must never be treated as new remuxes. */
function knownOutputs(jobs: Job[]) {
  const out = new Set<string>();
  for (const j of jobs) if (j.outputPath) out.add(j.outputPath);
  return out;
}

async function doScan(dryRun: boolean, reason: string): Promise<AutoScanResult> {
  const s = store.settings;
  const started = Date.now();
  const { items, errors } = await candidates();
  const jobs = queue.list();
  const outputs = knownOutputs(jobs);
  if (!dryRun) for (const o of outputs) state.seen[o] ??= { at: new Date().toISOString(), reason: 'output' };
  const result: AutoScanResult = { at: new Date().toISOString(), reason, dryRun, found: items.length, queued: [], skippedSeen: 0, skippedMissing: [], skippedNoProfile: 0, pending: [], errors, durationMs: 0 };

  // First scan without "include existing library": remember everything that is already there.
  if (!dryRun && !state.baselineAt && !s.auto.includeExisting) {
    for (const it of items) state.seen[it.localPath] ??= { at: result.at, reason: 'baseline' };
    state.baselineAt = result.at;
    result.baseline = items.length;
    result.durationMs = Date.now() - started;
    state.lastScan = result;
    save();
    appEvents.add('info', 'Auto transcode', `Baseline taken: ${items.length} existing remux file(s) will be left alone; new remuxes are transcoded from now on`);
    return result;
  }

  for (const it of items) {
    if (state.seen[it.localPath] || outputs.has(it.localPath)) {
      result.skippedSeen++;
      continue;
    }
    const existing = jobs.find((j) => j.source.localPath === it.localPath && !['failed', 'cancelled'].includes(j.status));
    if (existing) {
      result.skippedSeen++;
      if (!dryRun) state.seen[it.localPath] = { at: result.at, reason: 'existing-job', jobId: existing.id };
      continue;
    }
    if (!fs.existsSync(it.localPath)) {
      // Not remembered, so it is picked up once the path mapping is fixed.
      result.skippedMissing.push(it.path);
      continue;
    }
    const profile = profileFor(it.mediaType);
    if (!profile) {
      result.skippedNoProfile++;
      continue;
    }
    if (result.queued.length >= s.auto.maxPerScan) {
      result.pending.push({ ...it, profileName: profile.name });
      continue;
    }
    if (dryRun) {
      result.queued.push({ ...it, profileName: profile.name });
      continue;
    }
    try {
      const job = queue.create({
        title: it.title,
        subtitle: it.subtitle,
        poster: it.poster,
        profileId: profile.id,
        trigger: 'auto',
        source: { kind: it.arr === 'radarr' ? 'movie' : 'episode', arr: it.arr, arrId: it.arrId, fileId: it.fileId, episodeIds: it.episodeIds, seasonNumber: it.seasonNumber, arrPath: it.path, localPath: it.localPath },
      });
      state.seen[it.localPath] = { at: result.at, reason: 'queued', jobId: job.id };
      result.queued.push({ ...it, profileName: profile.name, jobId: job.id });
    } catch (err) {
      errors.push(`${it.title}: ${(err as Error).message}`);
    }
  }

  result.durationMs = Date.now() - started;
  if (!dryRun) {
    state.lastScan = { ...result, pending: result.pending.slice(0, 50) };
    save();
    if (result.queued.length) appEvents.add('info', 'Auto transcode', `Queued ${result.queued.length} remux file(s)${result.pending.length ? `, ${result.pending.length} more next scan` : ''}`, result.queued.map((q) => `${q.title}${q.subtitle ? ` ${q.subtitle}` : ''}`).join(', '));
    if (result.skippedMissing.length) appEvents.add('warning', 'Auto transcode', `${result.skippedMissing.length} remux file(s) are not visible to Rexarr – check path mappings`, result.skippedMissing.slice(0, 5).join('\n'));
    for (const e of errors) appEvents.add('error', 'Auto transcode', e);
  }
  return result;
}

export const autoTranscode = {
  /** Scan now. Concurrent calls share one scan. */
  scan(dryRun = false, reason = 'manual'): Promise<AutoScanResult> {
    if (!dryRun && !store.settings.auto.enabled) return Promise.reject(new Error('Auto transcode is disabled in Settings'));
    if (dryRun) return doScan(true, reason);
    if (scanning) return scanning;
    scanning = doScan(false, reason).finally(() => {
      scanning = null;
    });
    return scanning;
  },

  /** Called by the Radarr / Sonarr webhook; debounced so a season pack import triggers one scan. */
  webhook(source: string, eventType: string) {
    if (!store.settings.auto.enabled) return false;
    if (eventType && !/download|import|upgrade|rename/i.test(eventType)) return false;
    if (webhookTimer) clearTimeout(webhookTimer);
    webhookTimer = setTimeout(() => {
      webhookTimer = null;
      void this.scan(false, `${source} webhook`).catch(() => {});
    }, 15_000);
    return true;
  },

  /** Remember a finished transcode's output so a re-import of it is never transcoded again. */
  noteOutput(job: Job) {
    if (!job.outputPath || state.seen[job.outputPath]) return;
    state.seen[job.outputPath] = { at: new Date().toISOString(), reason: 'output', jobId: job.id };
    save();
  },

  /** Forget everything (next scan takes a new baseline unless "include existing" is on). */
  reset() {
    state = { seen: {} };
    save();
    appEvents.add('warning', 'Auto transcode', 'History cleared');
  },

  status(): AutoStatus {
    const counts = { queued: 0, baseline: 0, output: 0, existing: 0 };
    for (const v of Object.values(state.seen)) {
      if (v.reason === 'queued') counts.queued++;
      else if (v.reason === 'baseline') counts.baseline++;
      else if (v.reason === 'output') counts.output++;
      else counts.existing++;
    }
    return { enabled: store.settings.auto.enabled, scanning: Boolean(scanning), baselineAt: state.baselineAt, seen: Object.keys(state.seen).length, counts, lastScan: state.lastScan };
  },
};
