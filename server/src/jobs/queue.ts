import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Job, JobSource, JobStatus, Profile } from '../../../shared/types.js';
import { LOG_LINES_KEPT } from '../config.js';
import { store } from '../store.js';
import { bus } from '../events.js';
import { arr } from '../arr/index.js';
import { toLocalPath } from '../paths.js';
import { probe } from '../ffmpeg/probe.js';
import { buildFfmpegArgs, outputPathFor, type BuildOptions } from '../ffmpeg/args.js';
import { initialProgress, runFfmpeg, type RunHandle } from '../ffmpeg/runner.js';

export interface CreateJobInput {
  title: string;
  subtitle?: string;
  poster?: string;
  profileId: string;
  source: JobSource;
  /** Start as "waiting" (release grabbed, file not yet imported) instead of "queued". */
  waiting?: boolean;
}

function quote(a: string) {
  return /[\s"'$`\\]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a;
}

class JobQueue {
  private running = new Map<string, RunHandle>();
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
      source: { ...input.source },
      progress: initialProgress(),
      log: [],
      createdAt: new Date().toISOString(),
    };
    if (job.source.arrPath && !job.source.localPath) job.source.localPath = toLocalPath(job.source.arrPath);
    if (job.status === 'queued' && !job.source.localPath) throw new Error('A file path is required to queue an encode');
    store.jobs.unshift(job);
    store.saveJobs();
    this.log(job, input.waiting ? `Waiting for ${job.source.arr} to download and import the release` : `Queued with profile "${profile.name}"`);
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
      }
      const active = [...this.running.keys()].length;
      const slots = Math.max(1, settings.concurrency) - active;
      if (slots > 0) {
        // Oldest queued first (jobs are stored newest-first).
        const queued = [...store.jobs].reverse().filter((j) => j.status === 'queued' && !this.running.has(j.id)).slice(0, slots);
        for (const j of queued) void this.run(j);
      }
    } catch (err) {
      console.error('[queue] tick failed', err);
    } finally {
      this.ticking = false;
    }
  }

  /** Check whether the *arr app has imported a file for each waiting job. */
  private async pollWaiting() {
    const waiting = store.jobs.filter((j) => j.status === 'waiting');
    if (!waiting.length) return;
    const { radarr, sonarr } = arr();
    const remuxOnly = store.settings.remuxOnly;
    for (const job of waiting) {
      try {
        if (job.source.arr === 'radarr' && job.source.arrId) {
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

  private async run(job: Job) {
    const settings = store.settings;
    const profile: Profile | undefined = store.getProfile(job.profileId);
    const input = job.source.localPath!;
    let tmpOutput = '';
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
      tmpOutput = `${output}.rexarr-part`;
      fs.mkdirSync(path.dirname(output), { recursive: true });
      job.outputPath = output;

      // Run ffmpeg; retry once in bitrate mode if the encoder rejects quality mode (VideoToolbox on Intel).
      let attempt = 0;
      let buildOpts: BuildOptions = {};
      for (;;) {
        const built = buildFfmpegArgs(profile, info, input, tmpOutput, buildOpts);
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
        const { code } = await handle.done;
        this.running.delete(job.id);

        if ((job.status as JobStatus) === 'cancelled') {
          this.safeUnlink(tmpOutput);
          return;
        }
        if (code === 0) break;
        if (qualityModeRejected && attempt === 0 && buildOpts.forceBitrate === undefined) {
          attempt++;
          buildOpts = { forceBitrate: profile.video.bitrate };
          this.log(job, 'Encoder rejected quality mode; retrying in bitrate mode');
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

      let finalPath = output;
      if (profile.output.replaceOriginal) {
        this.log(job, `Replacing original ${path.basename(input)}`);
        fs.unlinkSync(input);
        if (!profile.output.suffix) {
          finalPath = path.join(path.dirname(output), `${path.basename(input, path.extname(input))}.${path.extname(output).slice(1)}`);
        }
      }
      fs.renameSync(tmpOutput, finalPath);
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
      store.saveJobs();
      this.emit(job);
      void this.tick();
    }
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
