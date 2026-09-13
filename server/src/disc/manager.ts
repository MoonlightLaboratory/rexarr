import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DiscDrive, DiscRip, Job, RipMedia, RipOptions, RipStatus, ServerEvent } from '../../../shared/types.js';
import { DATA_DIR, LOG_LINES_KEPT } from '../config.js';
import { store } from '../store.js';
import { bus } from '../events.js';
import { arr } from '../arr/index.js';
import { queue } from '../jobs/queue.js';
import { toArrPath } from '../paths.js';
import { ejectDrive, labelToTitle, listDrives, readDisc, resolveMakemkv, ripTitle, type RipHandle } from './makemkv.js';

const ACTIVE: RipStatus[] = ['inserted', 'scanning', 'ready', 'ripping', 'transcoding', 'delivering'];

/** Strip characters that are illegal in file names on any platform. */
function safeName(s: string) {
  return (
    s
      .split('')
      .filter((c) => c.charCodeAt(0) >= 32 && !'<>:"/\\|?*'.includes(c))
      .join('')
      .replace(/\s+/g, ' ')
      .trim() || 'Untitled'
  );
}

function resolutionTag(res?: string, type?: string): string {
  const h = Number(res?.split('x')[1] ?? 0);
  if (h >= 2000) return '2160p';
  if (h >= 1000) return '1080p';
  if (h >= 700) return '720p';
  return type === 'dvd' ? 'DVD' : '576p';
}

/**
 * Watches optical drives and runs the ARM-style pipeline:
 * insert → scan titles → identify (Radarr/Sonarr lookup) → rip (MakeMKV) → transcode (profile) → deliver (*arr import) → eject.
 */
class DiscManager {
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private running = new Map<string, RipHandle>();
  drives: DiscDrive[] = [];
  private lastDriveError = '';

  start() {
    for (const r of store.rips) {
      if (['scanning', 'ripping', 'delivering'].includes(r.status)) {
        r.status = 'failed';
        r.error = 'Server restarted mid-rip';
        this.log(r, r.error);
      }
    }
    store.saveRips();
    bus.on('event', (ev: ServerEvent) => {
      if (ev.type === 'job') void this.onJob(ev.job);
    });
    this.schedule();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    for (const h of this.running.values()) h.cancel();
  }

  /** (Re)arm the drive poll timer from the current settings. */
  schedule() {
    if (this.timer) clearTimeout(this.timer);
    const s = store.settings.disc;
    this.timer = setTimeout(() => void this.poll().finally(() => this.schedule()), Math.max(5, s.pollIntervalSeconds) * 1000);
  }

  list(): DiscRip[] {
    return store.rips;
  }
  get(id: string) {
    return store.rips.find((r) => r.id === id);
  }

  private makemkv() {
    return resolveMakemkv(store.settings.disc.makemkvPath);
  }
  private ripRoot() {
    return store.settings.disc.ripDirectory?.trim() || path.join(DATA_DIR, 'rips');
  }

  async refreshDrives(): Promise<DiscDrive[]> {
    try {
      this.drives = await listDrives(this.makemkv());
      this.lastDriveError = '';
    } catch (err) {
      this.lastDriveError = (err as Error).message;
      this.drives = [];
    }
    bus.publish({ type: 'drives', drives: this.drives });
    return this.drives;
  }
  get driveError() {
    return this.lastDriveError;
  }

  /** Poll drives; create a rip entry for each newly inserted disc. */
  async poll() {
    if (this.polling || !store.settings.disc.enabled) return;
    this.polling = true;
    try {
      const drives = await this.refreshDrives();
      for (const d of drives) {
        if (d.state !== 'loaded') continue;
        const label = d.discLabel ?? '';
        const active = store.rips.find((r) => r.drivePath === d.path && r.label === label && ACTIVE.includes(r.status));
        if (active) continue;
        // A disc that already finished (or failed) and is still in the tray is not ripped again until it is swapped.
        const recent = store.rips.find((r) => r.drivePath === d.path && r.label === label && r.finishedAt && Date.now() - new Date(r.finishedAt).getTime() < 6 * 3600_000);
        if (recent) continue;
        const rip = this.createRip(d);
        void this.scan(rip.id).then(async () => {
          const r = this.get(rip.id);
          if (r && r.status === 'ready' && store.settings.disc.autoRip) await this.startRip(r.id, {});
        });
      }
    } finally {
      this.polling = false;
    }
  }

  createRip(drive: DiscDrive): DiscRip {
    const s = store.settings.disc;
    const guess = labelToTitle(drive.discLabel ?? '');
    const rip: DiscRip = {
      id: randomUUID(),
      driveIndex: drive.index,
      drivePath: drive.path,
      driveName: drive.name,
      label: drive.discLabel ?? '',
      volumeName: '',
      discType: 'unknown',
      status: 'inserted',
      media: { kind: guess.season ? 'series' : 'unknown', title: guess.title, year: guess.year, seasonNumber: guess.season, episodeStart: 1 },
      titles: [],
      selectedTitleIds: [],
      options: { transcode: s.autoTranscode, deliver: s.autoDeliver, eject: s.autoEject, keepRaw: s.keepRaw },
      files: [],
      progress: { percent: 0, step: '', titleIndex: 0, titleCount: 0 },
      log: [],
      createdAt: new Date().toISOString(),
    };
    store.rips.unshift(rip);
    store.saveRips();
    this.log(rip, `Disc "${rip.label}" detected in ${drive.name} (${drive.path})`);
    this.emit(rip);
    bus.notice('info', `Disc inserted: ${rip.label || drive.name}`);
    return rip;
  }

  /** Read the title list and try to identify the disc. */
  async scan(id: string) {
    const rip = this.get(id);
    if (!rip) return;
    rip.status = 'scanning';
    rip.error = undefined;
    this.log(rip, 'Reading disc structure with MakeMKV…');
    this.emit(rip);
    try {
      const info = await readDisc(this.makemkv(), rip.driveIndex, store.settings.disc.minTitleSeconds);
      rip.discType = info.type;
      rip.volumeName = info.volumeName;
      rip.titles = info.titles;
      if (!rip.label && info.name) rip.label = info.name;
      this.log(rip, `${info.type} disc, ${info.titles.length} title(s) of at least ${store.settings.disc.minTitleSeconds}s`);
      if (!rip.media.title) {
        const g = labelToTitle(info.name || info.volumeName);
        rip.media = { ...rip.media, title: g.title, year: g.year, seasonNumber: g.season ?? rip.media.seasonNumber, kind: g.season ? 'series' : rip.media.kind };
      }
      await this.identify(rip);
      this.applyDefaultSelection(rip);
      rip.status = 'ready';
    } catch (err) {
      rip.status = 'failed';
      rip.error = (err as Error).message;
      this.log(rip, `Scan failed: ${rip.error}`);
    }
    store.saveRips();
    this.emit(rip);
  }

  /** Look the label up in Radarr (movies) and Sonarr (series); keep the best guess. */
  private async identify(rip: DiscRip) {
    if (rip.media.externalId) return;
    const term = rip.media.title;
    if (!term) return;
    const { radarr, sonarr } = arr();
    const preferSeries = rip.media.kind === 'series';
    const tryMovie = async (): Promise<RipMedia | null> => {
      if (!radarr.configured) return null;
      const r = (await radarr.lookup(term))[0];
      return r ? { kind: 'movie', title: r.title, year: r.year, externalId: r.externalId, arrId: r.arrId, poster: r.poster } : null;
    };
    const trySeries = async (): Promise<RipMedia | null> => {
      if (!sonarr.configured) return null;
      const r = (await sonarr.lookup(term))[0];
      return r ? { kind: 'series', title: r.title, year: r.year, externalId: r.externalId, arrId: r.arrId, poster: r.poster, seriesType: r.seriesType as RipMedia['seriesType'], seasonNumber: rip.media.seasonNumber ?? 1, episodeStart: 1 } : null;
    };
    try {
      const hit = preferSeries ? (await trySeries()) ?? (await tryMovie()) : (await tryMovie()) ?? (await trySeries());
      if (hit) {
        rip.media = { ...rip.media, ...hit };
        this.log(rip, `Identified as ${hit.kind}: ${hit.title} (${hit.year ?? '?'})${hit.arrId ? ' – already in library' : ''}`);
      } else this.log(rip, `Could not identify "${term}" automatically; set it in the UI`);
    } catch (err) {
      this.log(rip, `Lookup failed: ${(err as Error).message}`);
    }
  }

  private applyDefaultSelection(rip: DiscRip) {
    if (!rip.titles.length) {
      rip.selectedTitleIds = [];
      return;
    }
    if (rip.media.kind === 'series') rip.selectedTitleIds = rip.titles.map((t) => t.id);
    else {
      const longest = [...rip.titles].sort((a, b) => b.durationSeconds - a.durationSeconds)[0];
      rip.selectedTitleIds = [longest.id];
    }
    const mt = rip.media.kind === 'series' ? (rip.media.seriesType === 'anime' ? 'anime' : 'tv') : 'movie';
    const p = store.getProfile(store.settings.defaultProfiles[mt]);
    if (p) {
      rip.profileId = p.id;
      rip.profileName = p.name;
    }
  }

  /** User overrides from the UI. */
  update(id: string, patch: { media?: Partial<RipMedia>; selectedTitleIds?: number[]; profileId?: string; options?: Partial<RipOptions> }) {
    const rip = this.get(id);
    if (!rip) throw new Error('rip not found');
    if (patch.media) {
      const kindChanged = patch.media.kind && patch.media.kind !== rip.media.kind;
      rip.media = { ...rip.media, ...patch.media };
      if (kindChanged) this.applyDefaultSelection(rip);
    }
    if (patch.selectedTitleIds) rip.selectedTitleIds = patch.selectedTitleIds.filter((t) => rip.titles.some((x) => x.id === t));
    if (patch.profileId) {
      const p = store.getProfile(patch.profileId);
      if (!p) throw new Error('profile not found');
      rip.profileId = p.id;
      rip.profileName = p.name;
    }
    if (patch.options) rip.options = { ...rip.options, ...patch.options };
    store.saveRips();
    this.emit(rip);
    return rip;
  }

  /** Rip the selected titles, one makemkvcon run per title so we control naming. */
  async startRip(id: string, patch: Parameters<DiscManager['update']>[1]) {
    let rip = this.get(id);
    if (!rip) throw new Error('rip not found');
    if (!['ready', 'failed', 'cancelled'].includes(rip.status)) throw new Error(`Cannot start a rip in state ${rip.status}`);
    rip = this.update(id, patch);
    if (!rip.selectedTitleIds.length) throw new Error('No titles selected');
    if (rip.options.transcode && !rip.profileId) throw new Error('Pick an encoding profile or disable transcoding');
    rip.status = 'ripping';
    rip.error = undefined;
    rip.files = [];
    rip.startedAt = new Date().toISOString();
    rip.finishedAt = undefined;
    const folder = rip.media.title ? `${safeName(rip.media.title)}${rip.media.year ? ` (${rip.media.year})` : ''}` : safeName(rip.label || `disc-${rip.id.slice(0, 8)}`);
    rip.outputDir = path.join(this.ripRoot(), folder);
    fs.mkdirSync(rip.outputDir, { recursive: true });
    const titles = rip.titles.filter((t) => rip.selectedTitleIds.includes(t.id)).sort((a, b) => a.id - b.id);
    rip.progress = { percent: 0, step: '', titleIndex: 0, titleCount: titles.length };
    this.log(rip, `Ripping ${titles.length} title(s) to ${rip.outputDir}`);
    store.saveRips();
    this.emit(rip);
    void this.runRip(rip, titles);
  }

  private async runRip(rip: DiscRip, titles: DiscRip['titles']) {
    try {
      for (let i = 0; i < titles.length; i++) {
        const t = titles[i];
        rip.progress.titleIndex = i + 1;
        rip.progress.percent = 0;
        this.log(rip, `Title ${t.id}: ${t.name} (${Math.round(t.durationSeconds / 60)} min, ${(t.sizeBytes / 1e9).toFixed(1)} GB)`);
        const before = new Set(fs.readdirSync(rip.outputDir!));
        let lastEmit = 0;
        const handle = ripTitle(
          this.makemkv(),
          rip.driveIndex,
          t.id,
          rip.outputDir!,
          store.settings.disc.minTitleSeconds,
          (pct, step) => {
            rip.progress.percent = pct;
            rip.progress.step = step;
            if (Date.now() - lastEmit > 1000) {
              lastEmit = Date.now();
              this.emit(rip);
            }
          },
          (line) => this.log(rip, line),
        );
        this.running.set(rip.id, handle);
        const code = await handle.done;
        this.running.delete(rip.id);
        if ((rip.status as RipStatus) === 'cancelled') return;
        if (code !== 0) throw new Error(`makemkvcon exited with code ${code} on title ${t.id}`);
        // Find the file MakeMKV wrote and rename it to something the *arr apps can parse.
        const written = fs.readdirSync(rip.outputDir!).filter((f) => !before.has(f) && f.toLowerCase().endsWith('.mkv'));
        const src = written.length ? path.join(rip.outputDir!, written[0]) : path.join(rip.outputDir!, t.fileName);
        if (!fs.existsSync(src)) throw new Error(`MakeMKV finished but no output file was found for title ${t.id}`);
        const dest = path.join(rip.outputDir!, this.fileNameFor(rip, t, i));
        if (src !== dest) fs.renameSync(src, dest);
        const size = fs.statSync(dest).size;
        rip.files.push({ titleId: t.id, path: dest, sizeBytes: size });
        this.log(rip, `Ripped → ${path.basename(dest)} (${(size / 1e9).toFixed(2)} GB)`);
        store.saveRips();
        this.emit(rip);
      }
      rip.progress.percent = 100;
      if (rip.options.transcode) {
        rip.status = 'transcoding';
        this.log(rip, `Queuing ${rip.files.length} file(s) for transcoding with "${rip.profileName}"`);
        for (const f of rip.files) {
          const job = queue.create({
            title: rip.media.title || rip.label,
            subtitle: rip.media.kind === 'series' ? path.basename(f.path, '.mkv').split(' - ')[1] : `Disc rip · ${path.basename(f.path)}`,
            poster: rip.media.poster,
            profileId: rip.profileId!,
            source: { kind: 'file', localPath: f.path },
          });
          f.jobId = job.id;
        }
        store.saveRips();
        this.emit(rip);
      } else {
        for (const f of rip.files) f.finalPath = f.path;
        await this.deliver(rip);
      }
    } catch (err) {
      this.running.delete(rip.id);
      if ((rip.status as RipStatus) === 'cancelled') return;
      this.fail(rip, (err as Error).message);
    }
  }

  private fileNameFor(rip: DiscRip, t: DiscRip['titles'][number], seq: number) {
    const res = resolutionTag(t.resolution, rip.discType);
    const isDvd = rip.discType === 'dvd' || res === 'DVD';
    if (rip.media.kind === 'series') {
      const s = String(rip.media.seasonNumber ?? 1).padStart(2, '0');
      const e = String((rip.media.episodeStart ?? 1) + seq).padStart(2, '0');
      const q = isDvd ? 'DVD' : `Bluray-${res} Remux`;
      return `${safeName(rip.media.title || rip.label)} - S${s}E${e} - ${q}.mkv`;
    }
    const base = `${safeName(rip.media.title || rip.label)}${rip.media.year ? ` (${rip.media.year})` : ''}`;
    const extra = rip.selectedTitleIds.length > 1 ? ` - Title ${t.id}` : '';
    return `${base}${extra} ${isDvd ? 'DVD' : `Remux-${res}`}.mkv`;
  }

  /** Transcode jobs report back through the event bus. */
  private async onJob(job: Job) {
    const rip = store.rips.find((r) => r.status === 'transcoding' && r.files.some((f) => f.jobId === job.id));
    if (!rip) return;
    const file = rip.files.find((f) => f.jobId === job.id)!;
    if (job.status === 'failed') return this.fail(rip, `Transcode failed: ${job.error ?? 'unknown error'}`);
    if (job.status === 'cancelled') return this.fail(rip, 'Transcode cancelled');
    if (job.status !== 'done' || file.finalPath) return;
    file.finalPath = job.outputPath ?? file.path;
    this.log(rip, `Transcode finished: ${path.basename(file.finalPath)}`);
    if (!rip.options.keepRaw && file.finalPath !== file.path && fs.existsSync(file.path)) {
      try {
        fs.unlinkSync(file.path);
        this.log(rip, `Removed raw rip ${path.basename(file.path)}`);
        // Give the encode the clean *arr-parsable name now that the raw file is gone.
        const clean = path.join(path.dirname(file.finalPath), path.basename(file.path, path.extname(file.path)) + path.extname(file.finalPath));
        if (clean !== file.finalPath && !fs.existsSync(clean)) {
          fs.renameSync(file.finalPath, clean);
          file.finalPath = clean;
          this.log(rip, `Renamed → ${path.basename(clean)}`);
        }
      } catch (err) {
        this.log(rip, `Could not remove raw rip: ${(err as Error).message}`);
      }
    }
    store.saveRips();
    this.emit(rip);
    if (rip.files.every((f) => f.finalPath)) await this.deliver(rip);
  }

  /** Hand the folder to Radarr / Sonarr for import (DownloadedMoviesScan / DownloadedEpisodesScan), then eject. */
  private async deliver(rip: DiscRip) {
    rip.status = 'delivering';
    this.emit(rip);
    try {
      if (rip.options.deliver && rip.media.kind !== 'unknown' && rip.media.externalId) {
        const { radarr, sonarr } = arr();
        const dir = rip.outputDir!;
        if (rip.media.kind === 'movie' && radarr.configured) {
          if (!rip.media.arrId) {
            const m = await radarr.add(rip.media.externalId);
            rip.media.arrId = m.id;
            this.log(rip, `Added ${m.title} to Radarr`);
          }
          await radarr.http.post('/command', { name: 'DownloadedMoviesScan', path: toArrPath(dir), importMode: 'Move' });
          this.log(rip, `Asked Radarr to import ${toArrPath(dir)}`);
        } else if (rip.media.kind === 'series' && sonarr.configured) {
          if (!rip.media.arrId) {
            const s = await sonarr.add(rip.media.externalId, rip.media.seriesType ?? 'standard');
            rip.media.arrId = s.id;
            this.log(rip, `Added ${s.title} to Sonarr`);
          }
          await sonarr.http.post('/command', { name: 'DownloadedEpisodesScan', path: toArrPath(dir), importMode: 'Move' });
          this.log(rip, `Asked Sonarr to import ${toArrPath(dir)}`);
        } else this.log(rip, 'No matching *arr app configured; files left in the rip folder');
      } else this.log(rip, `Files left in ${rip.outputDir}`);
      if (rip.options.eject) {
        try {
          await ejectDrive(rip.drivePath);
          this.log(rip, 'Disc ejected');
        } catch (err) {
          this.log(rip, `Eject failed: ${(err as Error).message}`);
        }
      }
      rip.status = 'done';
      rip.finishedAt = new Date().toISOString();
      bus.notice('info', `Disc rip finished: ${rip.media.title || rip.label}`);
    } catch (err) {
      this.fail(rip, (err as Error).message);
      return;
    }
    store.saveRips();
    this.emit(rip);
  }

  private fail(rip: DiscRip, msg: string) {
    rip.status = 'failed';
    rip.error = msg;
    rip.finishedAt = new Date().toISOString();
    this.log(rip, `Failed: ${msg}`);
    bus.notice('error', `Disc rip failed: ${rip.media.title || rip.label} – ${msg}`);
    store.saveRips();
    this.emit(rip);
  }

  cancel(id: string) {
    const rip = this.get(id);
    if (!rip) return;
    this.running.get(id)?.cancel();
    for (const f of rip.files) if (f.jobId) queue.cancel(f.jobId);
    if (ACTIVE.includes(rip.status)) {
      rip.status = 'cancelled';
      rip.finishedAt = new Date().toISOString();
      this.log(rip, 'Cancelled by user');
      store.saveRips();
      this.emit(rip);
    }
  }

  remove(id: string) {
    const rip = this.get(id);
    if (!rip) return;
    if (this.running.has(id)) this.cancel(id);
    store.setRips(store.rips.filter((r) => r.id !== id));
    bus.publish({ type: 'rip-removed', id });
  }

  async eject(driveIndex: number) {
    const d = this.drives.find((x) => x.index === driveIndex) ?? (await this.refreshDrives()).find((x) => x.index === driveIndex);
    await ejectDrive(d?.path ?? '');
    setTimeout(() => void this.refreshDrives(), 3000).unref();
  }

  /** Manually register whatever is in a drive right now (when auto-detect is off). */
  async detectNow(): Promise<DiscRip[]> {
    const drives = await this.refreshDrives();
    const created: DiscRip[] = [];
    for (const d of drives) {
      if (d.state !== 'loaded') continue;
      if (store.rips.some((r) => r.drivePath === d.path && ACTIVE.includes(r.status))) continue;
      const rip = this.createRip(d);
      created.push(rip);
      void this.scan(rip.id);
    }
    return created;
  }

  private log(rip: DiscRip, line: string) {
    const stamped = `[${new Date().toISOString().slice(11, 19)}] ${line}`;
    rip.log.push(stamped);
    if (rip.log.length > LOG_LINES_KEPT) rip.log.splice(0, rip.log.length - LOG_LINES_KEPT);
  }
  private emit(rip: DiscRip) {
    bus.publish({ type: 'rip', rip });
  }
}

export const discs = new DiscManager();
