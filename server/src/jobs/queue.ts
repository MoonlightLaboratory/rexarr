import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Job, JobSource, JobStatus, MqaInfo, Profile, RipMedia } from '../../../shared/types.js';
import { CONTAINER_INFO } from '../../../shared/presets.js';
import { encodeMusic, freacEncoderArgs, freacInfo, probeAudio } from '../music/freac.js';
import { estimateSize } from '../ffmpeg/estimate.js';
import { scanMqa } from '../audio/mqaCache.js';
import { splitSoulseekPath } from '../arr/slskd.js';
import { findCueImages } from '../music/cue.js';
import { checkLidarrCueImages, cueSplitForAlbum, splitFolderImages } from '../music/cueImports.js';
import { LOG_LINES_KEPT, PATHS } from '../config.js';
import { appEvents } from '../system.js';
import { store } from '../store.js';
import { bus } from '../events.js';
import { arr } from '../arr/index.js';
import { toArrPath, toLocalPath } from '../paths.js';
import { findDiscImages, makemkvInfo } from '../disc/makemkv.js';
import { probe } from '../ffmpeg/probe.js';
import { buildFfmpegArgs, outputPathFor, type BuildOptions } from '../ffmpeg/args.js';
import { ffmpegCapabilities } from '../ffmpeg/capabilities.js';
import { initialProgress, runFfmpeg, type RunHandle } from '../ffmpeg/runner.js';

export interface CreateJobInput {
  title: string;
  subtitle?: string;
  poster?: string;
  profileId: string;
  source: JobSource;
  /** Start as "waiting" (release grabbed, file not yet imported) instead of "queued". */
  waiting?: boolean;
  trigger?: Job['trigger'];
}

function quote(a: string) {
  return /[\s"'$`\\]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a;
}

/** Rename, or copy + delete when source and destination are on different devices. */
async function moveFile(from: string, to: string) {
  try {
    await fs.promises.rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await fs.promises.copyFile(from, to);
    await fs.promises.unlink(from);
  }
}

const QUEUE_STATE_FILE = path.join(PATHS.programData, 'queue.json');

/** Free bytes on the filesystem holding `p` (0 when unknown). */
function freeBytes(p: string): number {
  try {
    let dir = p;
    while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
    const st = fs.statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return 0;
  }
}

class JobQueue {
  private running = new Map<string, RunHandle>();
  /** Jobs started by the queue that have not finished yet, including their probing phase. */
  private launched = new Set<string>();
  private pausedState = (() => {
    try {
      return Boolean((JSON.parse(fs.readFileSync(QUEUE_STATE_FILE, 'utf8')) as { paused?: boolean }).paused);
    } catch {
      return false;
    }
  })();
  /** Soulseek jobs whose album image is being split right now. */
  private splitting = new Set<string>();
  /** jobId -> file ffmpeg is writing right now (for the encoded-frame preview) */
  private partials = new Map<string, { path: string; container: string }>();
  private ticking = false;
  private lastPoll = 0;
  private timer: NodeJS.Timeout | null = null;

  start() {
    // Anything that was mid-flight when the server stopped goes back to the queue.
    for (const j of store.jobs) {
      if (['probing', 'encoding', 'finalizing'].includes(j.status)) {
        j.status = 'queued';
        j.progress = initialProgress();
        this.log(j, 'Server restarted; job re-queued');
      }
    }
    store.saveJobs();
    this.timer = setInterval(() => void this.tick(), 2000);
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    for (const h of this.running.values()) h.cancel();
  }

  list(): Job[] {
    return store.jobs;
  }

  get(id: string) {
    return store.jobs.find((j) => j.id === id);
  }

  create(input: CreateJobInput): Job {
    const profile = store.getProfile(input.profileId);
    if (!profile) throw new Error(`Profile ${input.profileId} not found`);
    const job: Job = {
      id: randomUUID(),
      title: input.title,
      subtitle: input.subtitle,
      poster: input.poster,
      status: input.waiting ? 'waiting' : 'queued',
      profileId: profile.id,
      profileName: profile.name,
      trigger: input.trigger ?? (input.waiting ? 'grab' : 'manual'),
      source: { ...input.source },
      progress: initialProgress(),
      log: [],
      createdAt: new Date().toISOString(),
    };
    if (job.source.arrPath && !job.source.localPath) job.source.localPath = toLocalPath(job.source.arrPath, job.source.arr);
    if (job.status === 'queued' && !job.source.localPath) throw new Error('A file path is required to queue an encode');
    store.jobs.unshift(job);
    store.saveJobs();
    this.log(job, input.waiting ? `Waiting for ${job.source.arr} to download and import the release` : `Queued with profile "${profile.name}"${input.trigger === 'auto' ? ' (auto transcode)' : ''}`);
    this.emit(job);
    void this.tick();
    return job;
  }

  cancel(id: string) {
    const job = this.get(id);
    if (!job) return;
    const handle = this.running.get(id);
    if (handle) handle.cancel();
    if (!['done', 'failed'].includes(job.status)) {
      job.status = 'cancelled';
      job.finishedAt = new Date().toISOString();
      this.log(job, 'Cancelled by user');
      store.saveJobs();
      this.emit(job);
    }
  }

  /** Pause: running encodes finish, nothing new starts. Kept across restarts. */
  get paused() {
    return this.pausedState;
  }
  setPaused(paused: boolean) {
    this.pausedState = paused;
    try {
      fs.writeFileSync(QUEUE_STATE_FILE, JSON.stringify({ paused }));
    } catch {
      /* best effort */
    }
    bus.publish({ type: 'queue', paused });
    appEvents.add('info', 'Queue', paused ? 'Queue paused' : 'Queue resumed');
    if (!paused) void this.tick();
  }

  /** Retry every failed job; returns how many were requeued. */
  retryFailed(): number {
    const failed = store.jobs.filter((j) => j.status === 'failed');
    for (const j of failed) this.retry(j.id);
    return failed.length;
  }

  retry(id: string) {
    const job = this.get(id);
    if (!job) return;
    if (!['failed', 'cancelled'].includes(job.status)) return;
    job.status = job.source.localPath ? 'queued' : 'waiting';
    job.error = undefined;
    job.progress = initialProgress();
    job.finishedAt = undefined;
    job.startedAt = undefined;
    this.log(job, 'Retrying');
    store.saveJobs();
    this.emit(job);
    void this.tick();
  }

  remove(id: string) {
    const job = this.get(id);
    if (!job) return;
    if (this.running.has(id)) this.cancel(id);
    store.setJobs(store.jobs.filter((j) => j.id !== id));
    bus.publish({ type: 'job-removed', id });
  }

  clearFinished() {
    const keep = store.jobs.filter((j) => !['done', 'failed', 'cancelled'].includes(j.status));
    const removed = store.jobs.filter((j) => ['done', 'failed', 'cancelled'].includes(j.status));
    store.setJobs(keep);
    for (const j of removed) bus.publish({ type: 'job-removed', id: j.id });
    if (removed.length) appEvents.add('info', 'Queue', `Cleared ${removed.length} finished job(s) from Activity`);
  }

  /** Move a queued job to the front / back of the queue. */
  reorder(id: string, direction: 'top' | 'bottom') {
    const jobs = store.jobs;
    const idx = jobs.findIndex((j) => j.id === id);
    if (idx < 0) return;
    const [job] = jobs.splice(idx, 1);
    if (direction === 'top') jobs.unshift(job);
    else jobs.push(job);
    store.saveJobs();
    bus.publish({ type: 'jobs', jobs });
  }

  // ---------------------------------------------------------------------------

  private log(job: Job, line: string) {
    const stamped = `[${new Date().toISOString().slice(11, 19)}] ${line}`;
    job.log.push(stamped);
    if (job.log.length > LOG_LINES_KEPT) job.log.splice(0, job.log.length - LOG_LINES_KEPT);
    bus.publish({ type: 'log', jobId: job.id, line: stamped });
  }

  private emit(job: Job) {
    bus.publish({ type: 'job', job });
  }

  private async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const settings = store.settings;
      if (Date.now() - this.lastPoll > settings.pollIntervalSeconds * 1000) {
        this.lastPoll = Date.now();
        await this.pollWaiting();
        // finished "image + cue" downloads Lidarr cannot import (also grabs made in Lidarr itself)
        await checkLidarrCueImages().catch((err: Error) => console.error('[cue] Lidarr queue check failed:', err.message));
      }
      // A job counts from the moment it is launched: it spends its first seconds probing the file and checking disk
      // space before ffmpeg (and this.running) starts, and must not let another job into its slot meanwhile.
      const active = new Set([...this.running.keys(), ...this.launched]).size;
      const slots = Math.max(1, settings.concurrency) - active;
      if (slots > 0 && !this.pausedState) {
        // Oldest queued first (jobs are stored newest-first).
        const queued = [...store.jobs].reverse().filter((j) => j.status === 'queued' && !this.running.has(j.id) && !this.launched.has(j.id)).slice(0, slots);
        for (const j of queued) {
          this.launched.add(j.id);
          void this.run(j).finally(() => {
            this.launched.delete(j.id);
            void this.tick();
          });
        }
      }
    } catch (err) {
      console.error('[queue] tick failed', err);
    } finally {
      this.ticking = false;
    }
  }

  /** Run the import check immediately (System → Tasks). */
  async pollNow() {
    this.lastPoll = Date.now();
    await this.pollWaiting();
  }

  /** Check whether the *arr app has imported a file for each waiting job. */
  private async pollWaiting() {
    const waiting = store.jobs.filter((j) => j.status === 'waiting');
    if (!waiting.length) return;
    const { radarr, sonarr } = arr();
    const remuxOnly = store.settings.remuxOnly;
    for (const job of waiting) {
      try {
        if (job.source.arr === 'lidarr') {
          await this.pollMusic(job);
        } else if (job.source.disc) {
          await this.pollDiscDownload(job);
        } else if (job.source.arr === 'radarr' && job.source.arrId) {
          const movie = await radarr.movie(job.source.arrId);
          const f = movie.file;
          if (f && (!remuxOnly || f.isRemux) && fs.existsSync(f.localPath)) {
            job.source.fileId = f.id;
            job.source.arrPath = f.path;
            job.source.localPath = f.localPath;
            job.status = 'queued';
            this.log(job, `Radarr imported ${path.basename(f.path)} (${f.quality}); queued for encoding`);
            store.saveJobs();
            this.emit(job);
          }
        } else if (job.source.arr === 'sonarr' && job.source.arrId) {
          const eps = await sonarr.episodes(job.source.arrId, job.source.seasonNumber);
          const wanted = new Set(job.source.episodeIds ?? eps.map((e) => e.id));
          const ready = eps.filter((e) => wanted.has(e.id) && e.file && (!remuxOnly || e.file.isRemux) && fs.existsSync(e.file.localPath));
          if (!ready.length) continue;
          for (const e of ready) {
            const f = e.file!;
            const child = this.create({
              title: job.title,
              subtitle: `S${String(e.seasonNumber).padStart(2, '0')}E${String(e.episodeNumber).padStart(2, '0')} · ${e.title}`,
              poster: job.poster,
              profileId: job.profileId,
              source: { kind: 'episode', arr: 'sonarr', arrId: job.source.arrId, episodeIds: [e.id], seasonNumber: e.seasonNumber, fileId: f.id, arrPath: f.path, localPath: f.localPath },
            });
            this.log(job, `Sonarr imported ${path.basename(f.path)} → job ${child.id.slice(0, 8)}`);
            wanted.delete(e.id);
          }
          job.source.episodeIds = [...wanted];
          if (!wanted.size) {
            job.status = 'done';
            job.finishedAt = new Date().toISOString();
            this.log(job, 'All episodes imported and queued');
          }
          store.saveJobs();
          this.emit(job);
        }
      } catch (err) {
        this.log(job, `Poll failed: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Grabbed full-disc release (ISO / BDMV / VIDEO_TS): the *arr app cannot import it, so wait for the download to
   * finish in its queue, find the disc image(s) in the download folder and hand them to the disc ripper, which rips
   * with MakeMKV, transcodes with the job's profile and imports the result.
   */
  private async pollDiscDownload(job: Job) {
    const { radarr, sonarr } = arr();
    const app = job.source.arr === 'radarr' ? 'radarr' : 'sonarr';
    const client = app === 'radarr' ? radarr : sonarr;
    const label = app === 'radarr' ? 'Radarr' : 'Sonarr';
    const disc = job.source.disc!;
    const note = (msg: string) => {
      if (disc.status === msg) return;
      disc.status = msg;
      this.log(job, msg);
      store.saveJobs();
      this.emit(job);
    };

    // Radarr / Sonarr sometimes import an .iso as if it were a video file: rip that instead.
    let imported: { path: string; localPath: string } | undefined;
    if (app === 'radarr' && job.source.arrId) {
      const f = (await radarr.movie(job.source.arrId)).file;
      if (f && /\.(iso|img)$/i.test(f.path) && fs.existsSync(f.localPath)) imported = f;
    }

    const records = (await client.queue()).records.filter((r) => (app === 'radarr' ? r.movieId : r.seriesId) === job.source.arrId);
    const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const want = norm(job.source.releaseTitle ?? '');
    const rec = records.find((r) => want && norm(r.title) === want) ?? records.find((r) => want && (norm(r.title).includes(want) || want.includes(norm(r.title)))) ?? (records.length === 1 ? records[0] : undefined);

    let found: string[] = [];
    if (imported) found = [imported.localPath];
    else {
      if (!rec) {
        note(`Waiting for ${label} to start the download…`);
        return;
      }
      const finished = rec.status === 'completed' || rec.sizeleft === 0 || /importPending|importBlocked|importing|failedPending/i.test(rec.trackedDownloadState ?? '');
      if (!finished) {
        const pct = rec.size ? Math.round((1 - rec.sizeleft / rec.size) * 100) : 0;
        job.message = `Downloading full disc · ${pct}%`;
        note(`Downloading in ${rec.downloadClient ?? 'the download client'}…`);
        this.emit(job);
        return;
      }
      if (!rec.outputPath) {
        note(`Download finished but ${label} does not report its folder yet`);
        return;
      }
      const local = toLocalPath(rec.outputPath, app);
      if (!fs.existsSync(local)) {
        note(`Download finished at ${rec.outputPath}, but Rexarr cannot see ${local}. Add a path mapping for the download folder (Settings → General → Path mappings).`);
        bus.notice('warn', `${job.title}: cannot reach the downloaded disc at ${local} – add a path mapping`);
        return;
      }
      found = findDiscImages(local);
      if (!found.length) {
        job.status = 'failed';
        job.error = `No disc image (.iso / .img) or BDMV / VIDEO_TS folder found in ${local}`;
        job.finishedAt = new Date().toISOString();
        this.log(job, job.error);
        store.saveJobs();
        this.emit(job);
        return;
      }
    }

    const { discs } = await import('../disc/manager.js');
    const mk = await makemkvInfo(store.settings.disc.makemkvPath);
    if (!mk.available) {
      note(`Downloaded ${found.length} disc(s), but MakeMKV was not found. Install it (Settings → Disc ripping); Rexarr retries automatically.`);
      return;
    }

    // Everything the ripper would otherwise have to guess.
    let media: Partial<RipMedia>;
    if (app === 'radarr') {
      const m = await radarr.movie(job.source.arrId!);
      media = { kind: 'movie', title: m.title, year: m.year, externalId: m.tmdbId, arrId: m.id, poster: job.poster ?? m.poster };
    } else {
      const s = await sonarr.seriesById(job.source.arrId!);
      media = { kind: 'series', title: s.title, year: s.year, externalId: s.tvdbId, arrId: s.id, poster: job.poster ?? s.poster, seriesType: s.seriesType, seasonNumber: job.source.seasonNumber ?? 1, absoluteNumbering: s.seriesType === 'anime' };
      // A single episode grab: the first title is that episode.
      if (job.source.episodeIds?.length === 1) {
        const ep = (await sonarr.episodes(s.id, job.source.seasonNumber)).find((e) => e.id === job.source.episodeIds![0]);
        if (ep) media = { ...media, seasonNumber: ep.seasonNumber, episodeStart: ep.episodeNumber };
      }
    }

    const ripIds: string[] = [];
    for (const [i, img] of found.entries()) {
      const rip = await discs.openImage(img, {
        media: { ...media, discNumber: found.length > 1 ? i + 1 : undefined },
        profileId: job.profileId,
        origin: 'download',
        jobId: job.id,
        arrQueue: rec ? { arr: app, id: rec.id, title: rec.title } : undefined,
        // Movies start straight away; series wait on the Discs page so the episode order can be checked.
        autoStart: app === 'radarr',
        options: { transcode: job.profileId !== '', deliver: true, eject: false, keepRaw: false },
      });
      ripIds.push(rip.id);
    }
    disc.ripIds = ripIds;
    job.status = 'done';
    job.finishedAt = new Date().toISOString();
    job.message = `Handed ${found.length} disc${found.length === 1 ? '' : 's'} to the disc ripper`;
    this.log(job, `${job.message}: ${found.map((f) => path.basename(f)).join(', ')}${app === 'sonarr' ? ' – confirm the episode order on the Discs page to start ripping' : ''}`);
    bus.notice('info', `${job.title}: full disc downloaded, ${app === 'radarr' ? 'ripping now' : 'check the episode order on the Discs page'}`);
    store.saveJobs();
    this.emit(job);
  }

  /**
   * Music grabs: a Soulseek download is followed in slskd and handed to Lidarr when complete; then (for Soulseek and
   * Lidarr indexer grabs alike) the album's track files are queued with the music profile once Lidarr imported them.
   */
  private async pollMusic(job: Job) {
    const { lidarr, slskd } = arr();
    const note = (msg: string) => {
      if (job.message === msg) return;
      job.message = msg;
      this.log(job, msg);
      store.saveJobs();
      this.emit(job);
    };
    const sk = job.source.soulseek;
    if (sk && sk.status !== 'imported') {
      const transfers = await slskd.transfers(sk.username);
      const wanted = new Map(sk.files.map((f) => [f.filename, f.size]));
      const mine = transfers.filter((t) => wanted.has(t.filename));
      const failed = mine.filter((t) => /Errored|Rejected|Cancelled|TimedOut|Failed|Aborted/i.test(t.state));
      const done = mine.filter((t) => /Succeeded/i.test(t.state));
      const total = sk.files.reduce((n, f) => n + f.size, 0);
      const bytes = mine.reduce((n, t) => n + (/Succeeded/i.test(t.state) ? t.size : (t.bytesTransferred ?? 0)), 0);
      job.progress.percent = total ? Math.round((bytes / total) * 100) : 0;
      if (failed.length && failed.length + done.length >= sk.files.length) {
        job.status = 'failed';
        job.error = `Soulseek: ${failed.length} of ${sk.files.length} file(s) failed (${[...new Set(failed.map((f) => f.state.replace('Completed, ', '')))].join(', ')}) – try another peer`;
        job.finishedAt = new Date().toISOString();
        this.log(job, job.error);
        store.saveJobs();
        this.emit(job);
        return;
      }
      if (done.length < sk.files.length) {
        note(mine.length ? `Soulseek: ${done.length}/${sk.files.length} files from ${sk.username} · ${job.progress.percent}%` : `Soulseek: queued with ${sk.username}, waiting for an upload slot`);
        return;
      }
      const reported = await slskd.downloadsDirectory();
      const base = store.settings.slskd.downloadsPath.trim() || (reported ? toLocalPath(reported, 'slskd') : '');
      const folder = path.join(base, splitSoulseekPath(sk.files[0].filename).folder);
      if (!base || !fs.existsSync(folder)) {
        note(`Soulseek download finished, but Rexarr cannot see ${folder || 'slskd\'s download folder'}. Set Settings → Soulseek → Downloads path (or a path mapping for slskd).`);
        return;
      }
      if (!lidarr.configured) {
        job.status = 'done';
        job.finishedAt = new Date().toISOString();
        job.outputPath = folder;
        this.log(job, `Downloaded to ${folder} (Lidarr is not connected, so nothing was imported)`);
        store.saveJobs();
        this.emit(job);
        return;
      }
      if (sk.status === 'splitting' && this.splitting.has(job.id)) return;
      const images = findCueImages(folder);
      let importPath = folder;
      if (images.length) {
        if (sk.status !== 'split') {
          sk.status = 'splitting';
          this.splitting.add(job.id);
          note(`Soulseek download is an album image: splitting ${images.reduce((n, i) => n + i.trackCount, 0)} tracks from the cue sheet`);
          void splitFolderImages(folder, images, (l) => this.log(job, l), (pct) => {
            job.progress.percent = Math.round(pct);
            this.emit(job);
          }).then(
            () => {
              sk.status = 'split';
              this.splitting.delete(job.id);
              store.saveJobs();
            },
            (err: Error) => {
              job.status = 'failed';
              job.error = `Cue split failed: ${err.message}`;
              this.splitting.delete(job.id);
              job.finishedAt = new Date().toISOString();
              sk.status = undefined;
              this.log(job, job.error);
              store.saveJobs();
              this.emit(job);
            },
          );
          return;
        }
        importPath = path.join(folder, 'rexarr-split');
        const dirs = fs.existsSync(importPath) ? fs.readdirSync(importPath) : [];
        if (dirs.length === 1) importPath = path.join(importPath, dirs[0]);
      }
      await lidarr.importFolder(toArrPath(importPath, 'lidarr'));
      sk.status = 'imported';
      job.message = undefined;
      this.log(job, `Soulseek download complete (${sk.files.length} files in ${folder}); asked Lidarr to import it`);
      store.saveJobs();
      this.emit(job);
      return;
    }

    if (!job.source.albumId || !lidarr.configured) {
      note('Waiting: no Lidarr album to follow');
      return;
    }
    const [album, files, queueRecords] = await Promise.all([lidarr.album(job.source.albumId), lidarr.trackFiles(job.source.albumId), lidarr.queue().then((q) => q.records).catch(() => [])]);
    const downloading = queueRecords.some((r) => r.albumId === job.source.albumId);
    const expected = album.statistics.trackCount;
    const cue = cueSplitForAlbum(job.source.albumId);
    if (cue && (cue.status === 'splitting' || cue.status === 'failed') && files.length < expected) {
      note(cue.message);
      return;
    }
    if (!files.length || (downloading && files.length < expected)) {
      note(files.length ? `Lidarr imported ${files.length}/${expected} tracks` : downloading ? 'Lidarr is downloading the release' : 'Waiting for Lidarr to import the album');
      return;
    }
    const profile = store.getProfile(job.profileId);
    job.message = undefined;
    if (!profile || profile.audio.encoder === 'copy') {
      job.status = 'done';
      job.finishedAt = new Date().toISOString();
      this.log(job, `Lidarr imported ${files.length} track(s) of ${album.title}; no encode (${profile?.name ?? 'profile missing'})`);
    } else {
      const queued = new Set(store.jobs.filter((j) => j.source.kind === 'track' && !['failed', 'cancelled'].includes(j.status)).map((j) => j.source.localPath));
      let n = 0;
      for (const f of files) {
        if (queued.has(f.localPath)) continue;
        this.create({
          title: job.title,
          subtitle: `${album.title} · ${path.basename(f.path)}`,
          poster: job.poster ?? album.cover,
          profileId: job.profileId,
          trigger: job.trigger,
          source: { kind: 'track', arr: 'lidarr', arrId: album.artistId, albumId: album.id, fileId: f.id, arrPath: f.path, localPath: f.localPath },
        });
        n++;
      }
      job.status = 'done';
      job.finishedAt = new Date().toISOString();
      this.log(job, `Lidarr imported ${files.length} track(s); queued ${n} for "${profile.name}"`);
    }
    store.saveJobs();
    this.emit(job);
  }

  /** Music profile: fre:ac encode with MQA protection and ReplayGain, then the usual swap into place. */
  private async runMusic(job: Job, profile: Profile) {
    const settings = store.settings;
    const input = job.source.localPath!;
    let tmpOutput = '';
    const signal: { cancelled: boolean; kill?: () => void } = { cancelled: false };
    try {
      if (!fs.existsSync(input)) throw new Error(`Input file not found: ${input}${job.source.arrPath && job.source.arrPath !== input ? ' (check path mappings in Settings)' : ''}`);
      job.status = 'probing';
      job.startedAt = new Date().toISOString();
      job.progress = initialProgress();
      this.emit(job);
      const info = await probeAudio(settings.ffprobePath, input);
      job.inputSizeBytes = fs.statSync(input).size;
      job.durationSeconds = info.durationSeconds;
      this.log(job, `Source: ${info.codec} ${info.bitDepth || '?'} bit / ${info.sampleRate / 1000} kHz, ${info.channels} ch, ${Math.round(info.durationSeconds)} s${info.hasCover ? ', cover art' : ''}`);

      if (profile.audio.encoder === 'copy') {
        job.status = 'done';
        job.finishedAt = new Date().toISOString();
        this.log(job, 'Profile keeps files as they are: nothing to encode');
        return;
      }
      const fa = await freacInfo(settings.freacPath);
      if (!fa.available) throw new Error(`fre:ac is required for music profiles: ${fa.error ?? 'freaccmd not found'} (Settings → fre:ac)`);

      let mqa: MqaInfo | undefined;
      if (info.lossless && info.channels === 2 && (profile.audio.preserveMqa || settings.disc.cd.detectMqa)) {
        mqa = await scanMqa(input).catch(() => undefined);
        if (mqa?.detected) this.log(job, `MQA stream detected${mqa.originalSampleRate ? ` (original ${mqa.originalSampleRate / 1000} kHz)` : ''}`);
      }
      const lossyTarget = !['flac', 'wavpack', 'ape'].includes(profile.audio.encoder);
      if (mqa?.detected && profile.audio.preserveMqa && lossyTarget) {
        job.status = 'done';
        job.finishedAt = new Date().toISOString();
        job.message = 'Skipped: MQA source kept (this profile would lose the MQA stream)';
        this.log(job, job.message);
        return;
      }

      const output = outputPathFor(profile, input, undefined, { replacingInput: profile.output.replaceOriginal });
      tmpOutput = path.join(PATHS.transcodes, `${job.id}__${path.basename(output)}`);
      fs.mkdirSync(PATHS.transcodes, { recursive: true });
      fs.mkdirSync(path.dirname(output), { recursive: true });
      job.outputPath = output;
      job.status = 'encoding';
      job.command = `${fa.path} -e ${freacEncoderArgs(profile).encoder} -o ${quote(tmpOutput)} -- ${freacEncoderArgs(profile).options.join(' ')} ${quote(input)}`;
      this.emit(job);
      const started = Date.now();
      const done = encodeMusic({
        freac: fa.path,
        ffmpeg: settings.ffmpegPath,
        ffprobe: settings.ffprobePath,
        profile,
        input,
        output: tmpOutput,
        info,
        preserveBitPerfect: Boolean(mqa?.detected && profile.audio.preserveMqa),
        hooks: {
          signal,
          onLog: (line) => this.log(job, line),
          onProgress: (percent, step) => {
            job.progress.percent = Math.round(percent);
            job.progress.speed = step;
            const elapsed = (Date.now() - started) / 1000;
            job.progress.etaSeconds = percent > 3 ? Math.round((elapsed / percent) * (100 - percent)) : null;
            this.emit(job);
          },
        },
      });
      this.running.set(job.id, {
        process: undefined as never,
        done: done.then(() => ({ code: 0, signal: null }), () => ({ code: 1, signal: null })),
        cancel: () => {
          signal.cancelled = true;
          signal.kill?.();
        },
      });
      const result = await done;
      this.running.delete(job.id);
      for (const st of result.steps) this.log(job, st);
      if ((job.status as JobStatus) === 'cancelled') return this.safeUnlink(tmpOutput);

      job.status = 'finalizing';
      this.emit(job);
      const stat = fs.statSync(tmpOutput);
      job.outputSizeBytes = stat.size;
      const staged = `${output}.rexarr-part`;
      await moveFile(tmpOutput, staged);
      tmpOutput = staged;
      if (profile.output.replaceOriginal && path.resolve(input) !== path.resolve(output)) {
        this.log(job, `Replacing original ${path.basename(input)}`);
        fs.unlinkSync(input);
      }
      fs.renameSync(staged, output);
      tmpOutput = '';
      this.log(job, `Finished: ${output} (${(stat.size / 1e6).toFixed(1)} MB, ${job.inputSizeBytes ? ((stat.size / job.inputSizeBytes) * 100).toFixed(0) : '?'}% of source)`);
      if (profile.output.notifyArr && job.source.arr === 'lidarr' && job.source.arrId) {
        await arr().lidarr.refreshArtist(job.source.arrId).then(
          () => this.log(job, 'Asked Lidarr to rescan the artist'),
          (err: Error) => this.log(job, `Lidarr rescan failed: ${err.message}`),
        );
      }
      job.status = 'done';
      job.progress.percent = 100;
      job.progress.etaSeconds = 0;
      job.finishedAt = new Date().toISOString();
    } catch (err) {
      this.running.delete(job.id);
      if ((job.status as JobStatus) === 'cancelled' || signal.cancelled) {
        if (tmpOutput) this.safeUnlink(tmpOutput);
        return;
      }
      job.status = 'failed';
      job.error = (err as Error).message;
      job.finishedAt = new Date().toISOString();
      this.log(job, `Failed: ${job.error}`);
      if (tmpOutput) this.safeUnlink(tmpOutput);
      bus.notice('error', `Encode failed for ${job.title}: ${job.error}`);
    } finally {
      store.saveJobs();
      this.emit(job);
      void this.tick();
    }
  }

  private async run(job: Job) {
    const settings = store.settings;
    const profile: Profile | undefined = store.getProfile(job.profileId);
    const input = job.source.localPath!;
    let tmpOutput = '';
    if (profile && (profile.mediaType === 'music' || CONTAINER_INFO[profile.container]?.music)) return this.runMusic(job, profile);
    try {
      if (!profile) throw new Error(`Profile "${job.profileName}" no longer exists`);
      if (!fs.existsSync(input)) throw new Error(`Input file not found: ${input}${job.source.arrPath && job.source.arrPath !== input ? ' (check path mappings in Settings)' : ''}`);
      job.status = 'probing';
      job.startedAt = new Date().toISOString();
      job.progress = initialProgress();
      this.log(job, `Probing ${input}`);
      this.emit(job);

      const info = await probe(settings.ffprobePath, input);
      job.inputSizeBytes = info.sizeBytes;
      job.durationSeconds = info.durationSeconds;
      this.log(job, `Source: ${info.video?.codec_name ?? '?'} ${info.video?.width}x${info.video?.height}${info.isHdr ? ' HDR' : ''}${info.isDolbyVision ? '+DV' : ''}, ${info.audio.length} audio, ${info.subtitles.length} subtitle, ${info.attachments.length} attachment stream(s), ${Math.round(info.durationSeconds / 60)} min`);

      const output = outputPathFor(profile, input);

      // Enough room? The estimate's upper end must fit where ffmpeg writes and where the file ends up.
      const caps0 = await ffmpegCapabilities(settings.ffmpegPath).catch(() => undefined);
      try {
        const est = estimateSize(profile, info, { anime: profile.mediaType === 'anime', hardware: settings.transcoding, availableEncoders: caps0?.available ? caps0.videoEncoders : undefined });
        job.estimatedBytes = est.bytes;
        this.log(job, `Estimated output: ${(est.bytes / 1e9).toFixed(2)} GB (likely ${(est.low / 1e9).toFixed(2)}–${(est.high / 1e9).toFixed(2)} GB)`);
        const tempDir = settings.transcodeTemp === 'output' ? path.dirname(output) : PATHS.transcodes;
        for (const dir of [...new Set([tempDir, path.dirname(output)])]) {
          const free = freeBytes(dir);
          if (free > 0 && free < est.high * 1.02) throw new Error(`Not enough free space in ${dir}: ${(free / 1e9).toFixed(1)} GB free, the encode may need up to ${(est.high / 1e9).toFixed(1)} GB`);
        }
      } catch (err) {
        if (/Not enough free space/.test((err as Error).message)) throw err;
      }

      // In-progress file: the Transcodes folder by default (partial files from a crash are cleaned up centrally),
      // or next to the output. The name starts with the job id so the clean-up task can tell whose it is.
      tmpOutput = settings.transcodeTemp === 'output' ? `${output}.rexarr-part` : path.join(PATHS.transcodes, `${job.id}__${path.basename(output)}.rexarr-part`);
      fs.mkdirSync(path.dirname(tmpOutput), { recursive: true });
      fs.mkdirSync(path.dirname(output), { recursive: true });
      job.outputPath = output;

      // Run ffmpeg; retry once in bitrate mode if the encoder rejects quality mode (VideoToolbox on Intel).
      // Hardware acceleration comes from Settings → Transcoding; a failed hardware encode can be retried on the CPU.
      let attempt = 0;
      const caps = await ffmpegCapabilities(settings.ffmpegPath).catch(() => undefined);
      const previewPath = this.previewPath(job.id);
      // "Frieren - S01E05 - Phantoms of the Dead" / "Blade Runner 2049 (2017)" for the file's title tag
      const metadata = { title: job.subtitle && /^S\d+E\d+/i.test(job.subtitle) ? `${job.title} - ${job.subtitle.replace(/\s+·\s+/, ' - ')}` : job.title };
      let buildOpts: BuildOptions = { hardware: settings.transcoding, availableEncoders: caps?.available ? caps.videoEncoders : undefined, previewPath, metadata };
      let lastBuilt: ReturnType<typeof buildFfmpegArgs> | undefined;
      this.partials.set(job.id, { path: tmpOutput, container: profile.container });
      job.preview = profile.video.encoder !== 'copy';
      let triedSoftware = false;
      for (;;) {
        const built = buildFfmpegArgs(profile, info, input, tmpOutput, buildOpts);
        lastBuilt = built;
        for (const w of built.warnings) this.log(job, `Warning: ${w}`);
        for (const s of built.summary) this.log(job, s);
        job.command = [settings.ffmpegPath, ...built.args].map(quote).join(' ');
        job.status = 'encoding';
        job.progress = initialProgress();
        this.log(job, `Running: ${job.command}`);
        this.emit(job);

        let lastEmit = 0;
        let qualityModeRejected = false;
        const handle = runFfmpeg(
          settings.ffmpegPath,
          built.args,
          info.durationSeconds,
          (p) => {
            job.progress = p;
            const now = Date.now();
            if (now - lastEmit > 1000) {
              lastEmit = now;
              this.emit(job);
            }
          },
          (line) => {
            if (/qscale not available|not available for encoder/i.test(line)) qualityModeRejected = true;
            this.log(job, line);
          },
        );
        this.running.set(job.id, handle);
        // Watchdog: a read that never returns (stalled network share) leaves ffmpeg waiting forever
        const stallMs = (settings.stallTimeoutMinutes ?? 10) * 60_000;
        let lastMark = '';
        let lastChange = Date.now();
        let stalled = false;
        const watchdog = stallMs
          ? setInterval(() => {
              const mark = `${job.progress.frame}|${job.progress.outTimeSeconds}|${job.progress.sizeBytes}`;
              if (mark !== lastMark) {
                lastMark = mark;
                lastChange = Date.now();
              } else if (Date.now() - lastChange > stallMs) {
                stalled = true;
                this.log(job, `No progress for ${settings.stallTimeoutMinutes ?? 10} minutes – stopping ffmpeg`);
                handle.process.kill('SIGKILL');
              }
            }, 15_000)
          : null;
        const { code } = await handle.done.finally(() => watchdog && clearInterval(watchdog));
        this.running.delete(job.id);
        if (stalled) throw new Error(`Encode stalled: no progress for ${settings.stallTimeoutMinutes ?? 10} minutes. The source may be on a network share that stopped responding (System → Status), or the disk is full.`);

        if ((job.status as JobStatus) === 'cancelled') {
          this.safeUnlink(tmpOutput);
          return;
        }
        if (code === 0) break;
        if (qualityModeRejected && attempt === 0 && buildOpts.forceBitrate === undefined) {
          attempt++;
          buildOpts = { ...buildOpts, forceBitrate: profile.video.bitrate };
          this.log(job, 'Encoder rejected quality mode; retrying in bitrate mode');
          this.safeUnlink(tmpOutput);
          continue;
        }
        if (built.hardware && !triedSoftware && settings.transcoding.fallbackToSoftware) {
          triedSoftware = true;
          buildOpts = { forceSoftware: true, previewPath, metadata };
          this.log(job, `Hardware encode (${built.hardware}, ${built.videoEncoder}) failed with code ${code}; retrying on the CPU`);
          appEvents.add('warning', 'Transcoding', `Hardware encode failed for ${job.title}; retried in software. Check Settings → Transcoding → Test.`);
          this.safeUnlink(tmpOutput);
          continue;
        }
        throw new Error(`ffmpeg exited with code ${code}`);
      }

      job.status = 'finalizing';
      this.emit(job);
      const stat = fs.statSync(tmpOutput);
      if (!stat.size) throw new Error('ffmpeg produced an empty file');
      job.outputSizeBytes = stat.size;

      // Name the file after what it now is: "… Remux-2160p" → "… Bluray-2160p", "AVC.DTS-HD.MA" → "x265.Opus" (Settings in the profile).
      const finalPath = outputPathFor(profile, input, lastBuilt?.description, { replacingInput: profile.output.replaceOriginal });
      if (path.basename(finalPath) !== path.basename(input)) this.log(job, `Output name: ${path.basename(finalPath)}`);
      // 1. bring the encode next to its destination first (may be a cross-device copy) while the source still exists
      const staged = `${finalPath}.rexarr-part`;
      if (tmpOutput !== staged) {
        if (path.dirname(tmpOutput) !== path.dirname(staged)) this.log(job, `Moving encode from the transcode folder to ${path.dirname(finalPath)}`);
        await moveFile(tmpOutput, staged);
        tmpOutput = staged;
      }
      // 2. only now remove the original, then 3. atomically rename into place
      if (profile.output.replaceOriginal) {
        this.log(job, `Replacing original ${path.basename(input)}`);
        fs.unlinkSync(input);
      }
      fs.renameSync(staged, finalPath);
      job.outputPath = finalPath;
      const ratio = job.inputSizeBytes ? ((stat.size / job.inputSizeBytes) * 100).toFixed(1) : '?';
      this.log(job, `Finished: ${finalPath} (${(stat.size / 1e9).toFixed(2)} GB, ${ratio}% of source)`);

      if (profile.output.notifyArr && job.source.arr && job.source.arrId) {
        try {
          const { radarr, sonarr } = arr();
          if (job.source.arr === 'radarr') await radarr.rescan(job.source.arrId);
          else await sonarr.rescan(job.source.arrId);
          this.log(job, `Asked ${job.source.arr} to rescan`);
        } catch (err) {
          this.log(job, `Rescan request failed: ${(err as Error).message}`);
        }
      }
      job.status = 'done';
      job.progress.percent = 100;
      job.progress.etaSeconds = 0;
      job.finishedAt = new Date().toISOString();
      bus.notice('info', `Finished encoding ${job.title}${job.subtitle ? ` – ${job.subtitle}` : ''}`);
    } catch (err) {
      this.running.delete(job.id);
      if ((job.status as JobStatus) === 'cancelled') return;
      job.status = 'failed';
      job.error = (err as Error).message;
      job.finishedAt = new Date().toISOString();
      this.log(job, `Failed: ${job.error}`);
      if (tmpOutput) this.safeUnlink(tmpOutput);
      bus.notice('error', `Encode failed for ${job.title}: ${job.error}`);
    } finally {
      this.partials.delete(job.id);
      job.preview = false;
      this.safeUnlink(this.previewPath(job.id));
      store.saveJobs();
      this.emit(job);
      void this.tick();
    }
  }

  /** Where the live preview JPEG for a job is written. */
  previewPath(id: string) {
    return path.join(PATHS.transcodes, `${id}__preview.jpg`);
  }

  /** The partially written output of an encoding job, if readable. */
  partial(id: string) {
    const p = this.partials.get(id);
    return p && fs.existsSync(p.path) ? p : undefined;
  }

  private safeUnlink(p: string) {
    try {
      if (p && fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}

export const queue = new JobQueue();
