import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DiscDrive, DiscRip, Job, RipMedia, RipOptions, RipStatus, ServerEvent, TitleRole } from '../../../shared/types.js';
import { PATHS, LOG_LINES_KEPT } from '../config.js';
import { store } from '../store.js';
import { bus } from '../events.js';
import { arr } from '../arr/index.js';
import { queue } from '../jobs/queue.js';
import { toArrPath } from '../paths.js';
import { anidb } from '../anidb.js';
import { canonicalDevice, probePhysicalDrive } from './devices.js';
import { execFile } from 'node:child_process';
import { discId, downloadCover, getRelease, lookupDisc, readCdToc, tocString } from '../music/musicbrainz.js';
import { freacInfo, ripCdTrack } from '../music/freac.js';
import { detectMqa } from '../audio/mqa.js';
import { proxiedImage } from '../routes/images.js';
import { appEvents } from '../system.js';
import { ejectDrive, labelToTitle, listDrives, listVirtualDrives, readDisc, resolveMakemkv, ripTitle, unmountForDirectAccess, virtualDriveForPath, type RipHandle } from './makemkv.js';
import { audioSelectionFor, describeTracks } from './audio.js';
import { extraFileName, extraLabel, guessExtraRoles } from './extras.js';
import { toLocalPath } from '../paths.js';
import { folderIsSettled, importIntoSonarr, type ImportOutcome, type KnownEpisode } from './sonarrImport.js';
import { matchLibrary, nameScore, splitSequel, type LibraryCandidate } from './identify.js';
import { keepAudioTracks } from './remux.js';

/** Pre-filled details for a rip that did not come from a physical drive (e.g. a grabbed full-disc release). */
export interface RipPreset {
  media?: Partial<RipMedia>;
  profileId?: string;
  origin?: DiscRip['origin'];
  jobId?: string;
  arrQueue?: DiscRip['arrQueue'];
  autoStart?: boolean;
  options?: RipOptions;
}

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
export class DiscManager {
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private running = new Map<string, RipHandle>();
  /** Scans in progress, so cancelling or removing a disc stops MakeMKV instead of leaving it holding the drive. */
  private scans = new Map<string, AbortController>();
  private refreshing: Promise<DiscDrive[]> | null = null;
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
    return store.settings.disc.ripDirectory?.trim() || PATHS.rips;
  }

  /** One drive check at a time: callers during a check share its result instead of starting another MakeMKV. */
  async refreshDrives(): Promise<DiscDrive[]> {
    if (!this.refreshing) this.refreshing = this.readDrives().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async readDrives(): Promise<DiscDrive[]> {
    let real: DiscDrive[] = [];
    // Listing drives makes MakeMKV query every drive, which slows down (or upsets) a scan or rip that is using one.
    // While MakeMKV is busy with a disc, keep the drives we already know about.
    const busy = this.scans.size > 0 || [...this.running.keys()].some((id) => !this.get(id)?.virtual);
    // MakeMKV drives have small indexes; linked virtual drives start at 3000 and probed manual drives at 4000
    const known = this.drives.filter((d) => !d.virtual && d.index < 3000);
    if (busy && known.length) real = known;
    else {
      try {
        real = await listDrives(this.makemkv());
        this.lastDriveError = '';
      } catch (err) {
        this.lastDriveError = (err as Error).message;
      }
    }
    let virtual: DiscDrive[] = [];
    try {
      virtual = listVirtualDrives(store.settings.disc.virtualDriveDirectory?.trim() ?? '');
    } catch (err) {
      this.lastDriveError = `virtual drives: ${(err as Error).message}`;
    }
    const linked: DiscDrive[] = [];
    for (const [i, v] of (store.settings.disc.virtualDrives ?? []).entries()) {
      const d = virtualDriveForPath(v.path, 3000 + i, v.label, v.id);
      if (d) linked.push(d);
    }
    // Real drives added by device path: use MakeMKV's entry when it lists the same device, otherwise probe it.
    const manual: DiscDrive[] = [];
    for (const [i, p] of (store.settings.disc.physicalDrives ?? []).entries()) {
      const want = canonicalDevice(p.path);
      const match = real.find((r) => r.path && canonicalDevice(r.path) === want);
      if (match) {
        match.manualId = p.id;
        match.detected = true;
        if (p.label) match.name = p.label;
      } else manual.push(await probePhysicalDrive(p, 4000 + i));
    }
    this.drives = [...real, ...manual, ...virtual, ...linked];
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
        // A drive holds one disc. Right after it is (re)connected the label can read blank for a moment – that is the
        // same disc, not a new one – and a disc that is still being scanned or ripped must not get a second entry.
        const busy = store.rips.find((r) => r.drivePath === d.path && ['inserted', 'scanning', 'ripping'].includes(r.status));
        if (busy || !label) continue;
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

  createRip(drive: DiscDrive, preset?: RipPreset): DiscRip {
    const s = store.settings.disc;
    const guess = labelToTitle(drive.discLabel ?? '');
    const profile = preset?.profileId ? store.getProfile(preset.profileId) : undefined;
    const rip: DiscRip = {
      id: randomUUID(),
      driveIndex: drive.index,
      source: drive.source ?? `disc:${drive.index}`,
      virtual: drive.virtual,
      drivePath: drive.path,
      driveName: drive.name,
      label: drive.discLabel ?? '',
      volumeName: '',
      discType: 'unknown',
      status: 'inserted',
      media: { kind: guess.season ? 'series' : 'unknown', title: guess.title, year: guess.year, seasonNumber: guess.season, episodeStart: 1, discNumber: guess.disc, ...preset?.media },
      origin: preset?.origin ?? (drive.virtual ? 'image' : 'drive'),
      jobId: preset?.jobId,
      arrQueue: preset?.arrQueue,
      autoStart: preset?.autoStart,
      profileId: profile?.id,
      profileName: profile?.name,
      titles: [],
      selectedTitleIds: [],
      options: preset?.options ?? { transcode: s.autoTranscode, deliver: s.autoDeliver, eject: s.autoEject, keepRaw: s.keepRaw },
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
    this.emit(rip);
    // Audio CDs never reach MakeMKV: read the table of contents first.
    if (await this.scanCd(rip).catch((err: Error) => (this.log(rip, `Audio CD check failed: ${err.message}`), false))) return;
    if (!rip.virtual && rip.drivePath) {
      const unmounted = await unmountForDirectAccess(rip.drivePath).catch(() => null);
      if (unmounted) this.log(rip, unmounted);
    }
    this.log(rip, 'Reading disc structure with MakeMKV…');
    this.emit(rip);
    try {
      const d = store.settings.disc;
      // MakeMKV numbers titles after this filter, so the rip must use the same minimum as the scan
      rip.scanMinSeconds = d.includeExtras ? Math.min(d.extraMinSeconds ?? 30, d.minTitleSeconds) : d.minTitleSeconds;
      const abort = new AbortController();
      this.scans.set(rip.id, abort);
      const info = await readDisc(this.makemkv(), rip.source ?? `disc:${rip.driveIndex}`, rip.scanMinSeconds, abort.signal).finally(() => this.scans.delete(rip.id));
      if ((rip.status as RipStatus) === 'cancelled') return;
      for (const t of info.titles) if (t.durationSeconds < d.minTitleSeconds) t.short = true;
      rip.discType = info.type;
      rip.volumeName = info.volumeName;
      rip.titles = info.titles;
      if (!rip.label && info.name) rip.label = info.name;
      const shorts = info.titles.filter((t) => t.short).length;
      this.log(rip, `${info.type} disc, ${info.titles.length - shorts} title(s) of at least ${d.minTitleSeconds}s${shorts ? ` and ${shorts} shorter extra(s)` : ''}`);
      if (!rip.media.title) {
        const g = labelToTitle(info.name || info.volumeName);
        rip.media = { ...rip.media, title: g.title, year: g.year, seasonNumber: g.season ?? rip.media.seasonNumber, kind: g.season ? 'series' : rip.media.kind, discNumber: g.disc ?? rip.media.discNumber };
      }
      await this.identify(rip);
      this.applyDefaultSelection(rip);
      rip.status = 'ready';
    } catch (err) {
      if ((rip.status as RipStatus) === 'cancelled') return;
      rip.status = 'failed';
      rip.error = (err as Error).message;
      this.log(rip, `Scan failed: ${rip.error}`);
    }
    store.saveRips();
    this.emit(rip);
  }

  // ------------------------------------------------------------------ audio CDs (fre:ac + MusicBrainz)

  /** Is there an audio CD in the drive? Fills in the tracks and MusicBrainz matches. */
  private async scanCd(rip: DiscRip, force = false): Promise<boolean> {
    const cd = store.settings.disc.cd;
    if ((!cd.enabled && !force) || rip.virtual) return false;
    const toc = await readCdToc(rip.drivePath, cd.ripperPath);
    if (!toc) return false;
    rip.discType = 'cd';
    rip.titles = toc.tracks.map((t) => ({ id: t.number, name: `Track ${t.number}`, durationSeconds: Math.round(t.sectors / 75), sizeBytes: t.sectors * 2352, chapters: 0, fileName: '', audio: ['PCM 16-bit / 44.1 kHz stereo'], subtitles: [] }));
    rip.selectedTitleIds = rip.titles.map((t) => t.id);
    rip.cd = { discId: discId(toc), toc: tocString(toc), tracks: toc.tracks, releases: [], selected: 0 };
    rip.options = { ...rip.options, transcode: false, keepRaw: false };
    this.log(rip, `Audio CD: ${toc.tracks.length} track(s), MusicBrainz disc id ${rip.cd.discId}`);
    if (store.settings.musicbrainz.enabled && cd.musicbrainz) {
      try {
        const found = await lookupDisc(toc);
        rip.cd.releases = found.releases;
        this.log(rip, found.releases.length ? `MusicBrainz: ${found.releases.length} matching release(s)` : 'MusicBrainz: no release for this disc id yet – search by title on the Discs page');
      } catch (err) {
        this.log(rip, `MusicBrainz lookup failed: ${(err as Error).message}`);
      }
    }
    this.applyCdRelease(rip, 0);
    const profile = store.getProfile(store.settings.defaultProfiles.music);
    if (profile && profile.audio.encoder !== 'copy') {
      rip.profileId = profile.id;
      rip.profileName = profile.name;
    }
    rip.status = 'ready';
    store.saveRips();
    this.emit(rip);
    if (store.settings.disc.autoRip && rip.cd.releases.length) void this.startRip(rip.id, {}).catch((err: Error) => this.log(rip, `Could not start: ${err.message}`));
    return true;
  }

  /** Use one of the MusicBrainz matches for titles and naming. */
  private applyCdRelease(rip: DiscRip, index: number) {
    const rel = rip.cd?.releases[index];
    if (!rip.cd) return;
    rip.cd.selected = rel ? index : 0;
    if (!rel) {
      rip.media = { ...rip.media, kind: 'album', title: rip.media.title || rip.label || 'Unknown Album', artist: rip.media.artist ?? 'Unknown Artist' };
      return;
    }
    rip.media = { ...rip.media, kind: 'album', title: rel.title, artist: rel.artist, year: rel.date ? Number(rel.date.slice(0, 4)) || undefined : undefined, discNumber: rel.discCount > 1 ? rel.discNumber : undefined, poster: rel.coverUrl ? proxiedImage('lidarr', { remoteUrl: rel.coverUrl.replace('front-500', 'front-500.jpg') }, 'poster') : undefined };
    for (const t of rip.titles) {
      const mt = rel.tracks.find((x) => x.number === t.id);
      if (mt) t.name = mt.title;
    }
  }

  /** Pick a MusicBrainz match by index, or add one by release id (from a title search). */
  async setCdRelease(id: string, choice: { index?: number; releaseId?: string }) {
    const rip = this.get(id);
    if (!rip?.cd) throw new Error('not an audio CD');
    if (choice.releaseId) {
      const rel = await getRelease(choice.releaseId);
      rip.cd.releases = [rel, ...rip.cd.releases.filter((r) => r.releaseId !== rel.releaseId)];
      this.applyCdRelease(rip, 0);
    } else this.applyCdRelease(rip, choice.index ?? 0);
    store.saveRips();
    this.emit(rip);
    return rip;
  }

  /** Read an audio CD from a drive on demand (drives that MakeMKV lists as empty for audio discs). */
  async readCd(driveIndex: number) {
    const d = this.drives.find((x) => x.index === driveIndex) ?? (await this.refreshDrives()).find((x) => x.index === driveIndex);
    if (!d || d.virtual) throw new Error('drive not found');
    const existing = store.rips.find((r) => r.drivePath === d.path && ACTIVE.includes(r.status));
    if (existing) return existing;
    const rip = this.createRip(d);
    rip.status = 'scanning';
    if (!(await this.scanCd(rip, true))) {
      this.fail(rip, 'No audio CD found in this drive (no table of contents)');
      throw new Error('No audio CD found in this drive');
    }
    return rip;
  }

  private startCdRip(rip: DiscRip) {
    const rel = rip.cd?.releases[rip.cd.selected];
    const artist = safeName(rip.media.artist || rel?.artist || 'Unknown Artist');
    const album = `${safeName(rip.media.title || 'Unknown Album')}${rip.media.year ? ` (${rip.media.year})` : ''}${rip.media.discNumber ? ` (Disc ${rip.media.discNumber})` : ''}`;
    rip.outputDir = path.join(this.ripRoot(), artist, album);
    fs.mkdirSync(rip.outputDir, { recursive: true });
    rip.status = 'ripping';
    rip.error = undefined;
    rip.files = [];
    rip.startedAt = new Date().toISOString();
    rip.finishedAt = undefined;
    const titles = rip.titles.filter((t) => rip.selectedTitleIds.includes(t.id)).sort((a, b) => a.id - b.id);
    rip.progress = { percent: 0, step: '', titleIndex: 0, titleCount: titles.length, startedAt: new Date().toISOString() };
    this.log(rip, `Ripping ${titles.length} track(s) with fre:ac to ${rip.outputDir}`);
    store.saveRips();
    this.emit(rip);
    void this.runCdRip(rip, titles);
    return rip;
  }

  private async runCdRip(rip: DiscRip, titles: DiscRip['titles']) {
    const settings = store.settings;
    const cd = settings.disc.cd;
    const work = path.join(rip.outputDir!, `.rexarr-rip-${rip.id.slice(0, 8)}`);
    const signal: { cancelled: boolean; kill?: () => void } = { cancelled: false };
    this.running.set(rip.id, { cancel: () => ((signal.cancelled = true), signal.kill?.()) } as unknown as RipHandle);
    try {
      const fa = await freacInfo(settings.freacPath);
      if (!fa.available) throw new Error(`fre:ac is required to rip CDs: ${fa.error ?? 'freaccmd not found'}`);
      fs.rmSync(work, { recursive: true, force: true });
      fs.mkdirSync(work, { recursive: true });
      const rel = rip.cd?.releases[rip.cd.selected];
      let cover: string | undefined;
      if (rel?.coverUrl && settings.musicbrainz.enabled) {
        const file = path.join(work, 'cover.jpg');
        if (await downloadCover(rel.coverUrl, file)) {
          cover = file;
          this.log(rip, 'Cover art from the Cover Art Archive');
        }
      }
      // fre:ac numbers CD drives itself; with one drive it is 0, otherwise follow the order of real drives.
      const realDrives = this.drives.filter((d) => !d.virtual).map((d) => d.path).sort();
      const freacDrive = Math.max(0, realDrives.indexOf(rip.drivePath));
      for (let i = 0; i < titles.length; i++) {
        const t = titles[i];
        rip.progress = { ...rip.progress, titleIndex: i + 1, percent: 0, step: `Track ${t.id}` };
        this.emit(rip);
        const raw = path.join(work, `${String(t.id).padStart(2, '0')}.flac`);
        let lastEmit = 0;
        await ripCdTrack({
          freac: fa.path,
          driveIndex: freacDrive,
          track: t.id,
          output: raw,
          compressionLevel: cd.compressionLevel,
          expectedBytes: t.sizeBytes * 0.6,
          hooks: {
            signal,
            onLog: (l) => this.log(rip, l),
            onProgress: (pct, step) => {
              rip.progress.percent = pct;
              rip.progress.step = step;
              if (Date.now() - lastEmit > 1000) {
                lastEmit = Date.now();
                this.emit(rip);
              }
            },
          },
        });
        if (signal.cancelled) return;
        // MQA-CD: the rip is bit-perfect FLAC, so an MQA stream survives; scan the first track
        if (i === 0 && cd.detectMqa && rip.cd) {
          rip.cd.mqa = await detectMqa(settings.ffmpegPath, raw, { sampleRate: 44100, channels: 2 }).catch(() => undefined);
          if (rip.cd.mqa?.detected) this.log(rip, `MQA-CD detected${rip.cd.mqa.originalSampleRate ? ` (original ${rip.cd.mqa.originalSampleRate / 1000} kHz)` : ''}: files are kept bit-perfect and tagged MQA`);
        }
        const mt = rel?.tracks.find((x) => x.number === t.id);
        const name = `${String(t.id).padStart(2, '0')} - ${safeName(mt?.title ?? t.name)}.flac`;
        const dest = path.join(rip.outputDir!, name);
        await this.tagCdTrack(raw, dest, rip, t.id, titles.length, cover);
        const keep = audioSelectionFor(t, rip.audioMode ?? store.settings.disc.audioMode ?? 'best', rip.selectedAudio?.[String(t.id)]);
        if (keep.length && keep.length < (t.audioTracks?.length ?? 0)) {
          rip.progress.step = 'Removing unwanted audio tracks';
          this.emit(rip);
          try {
            await keepAudioTracks(store.settings.ffmpegPath, dest, keep);
            this.log(rip, `Kept ${keep.length} of ${t.audioTracks!.length} audio track(s): ${describeTracks(t, keep)}`);
          } catch (err) {
            this.log(rip, `Could not drop the other audio tracks (all kept): ${(err as Error).message}`);
          }
        }
        const size = fs.statSync(dest).size;
        rip.files.push({ titleId: t.id, path: dest, sizeBytes: size });
        this.log(rip, `Ripped → ${name} (${(size / 1e6).toFixed(1)} MB)`);
        store.saveRips();
        this.emit(rip);
      }
      this.running.delete(rip.id);
      fs.rmSync(work, { recursive: true, force: true });
      rip.progress.percent = 100;
      const profile = rip.options.transcode && rip.profileId ? store.getProfile(rip.profileId) : undefined;
      if (profile && profile.audio.encoder !== 'copy') {
        rip.status = 'transcoding';
        this.log(rip, `Queuing ${rip.files.length} track(s) for "${profile.name}"`);
        for (const f of rip.files) {
          f.jobId = queue.create({ title: rip.media.artist ? `${rip.media.artist} – ${rip.media.title}` : rip.media.title, subtitle: `CD rip · ${path.basename(f.path)}`, poster: rip.media.poster, profileId: profile.id, trigger: 'disc', source: { kind: 'file', localPath: f.path } }).id;
        }
        store.saveRips();
        this.emit(rip);
      } else {
        for (const f of rip.files) f.finalPath = f.path;
        await this.deliver(rip);
      }
    } catch (err) {
      this.running.delete(rip.id);
      fs.rmSync(work, { recursive: true, force: true });
      if ((rip.status as RipStatus) === 'cancelled' || signal.cancelled) return;
      this.fail(rip, (err as Error).message);
    }
  }

  /** Write MusicBrainz tags, MQA markers and cover art (stream copy: the audio stays bit-perfect). */
  private async tagCdTrack(raw: string, dest: string, rip: DiscRip, track: number, trackTotal: number, cover?: string) {
    const rel = rip.cd?.releases[rip.cd.selected];
    const mt = rel?.tracks.find((x) => x.number === track);
    const tags: Record<string, string | number | undefined> = {
      TITLE: mt?.title ?? `Track ${track}`,
      ARTIST: mt?.artist ?? rel?.artist ?? rip.media.artist,
      ALBUMARTIST: rel?.artist ?? rip.media.artist,
      ALBUM: rel?.title ?? rip.media.title,
      TRACKNUMBER: track,
      TRACKTOTAL: rel?.tracks.length || trackTotal,
      DISCNUMBER: rel?.discNumber,
      DISCTOTAL: rel?.discCount,
      DATE: rel?.date,
      LABEL: rel?.label,
      BARCODE: rel?.barcode,
      RELEASECOUNTRY: rel?.country,
      MEDIA: 'CD',
      MUSICBRAINZ_ALBUMID: rel?.releaseId,
      MUSICBRAINZ_RELEASEGROUPID: rel?.releaseGroupId,
      MUSICBRAINZ_ALBUMARTISTID: rel?.artistId,
      MUSICBRAINZ_TRACKID: mt?.recordingId,
      MUSICBRAINZ_DISCID: rip.cd?.discId,
      MQA: rip.cd?.mqa?.detected ? 'MQA-CD' : undefined,
      ORIGINALSAMPLERATE: rip.cd?.mqa?.detected ? rip.cd.mqa.originalSampleRate : undefined,
    };
    const args = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-i', raw];
    if (cover) args.push('-i', cover, '-map', '0:a', '-map', '1:v', '-disposition:v', 'attached_pic', '-metadata:s:v', 'comment=Cover (front)');
    else args.push('-map', '0:a');
    args.push('-c', 'copy');
    for (const [k, v] of Object.entries(tags)) if (v !== undefined && v !== '') args.push('-metadata', `${k}=${v}`);
    args.push(dest);
    await new Promise<void>((resolve, reject) => {
      execFile(store.settings.ffmpegPath, args, { timeout: 120_000 }, (err, _o, stderr) => (err ? reject(new Error(`tagging failed: ${stderr || err.message}`)) : resolve()));
    });
  }

  /** Look the label up in Radarr (movies) and Sonarr (series); keep the best guess. */
  /** The season's own name from AniDB, shown next to "Season N" (series only). */
  private nameSeason(rip: DiscRip) {
    rip.media.seasonTitle = undefined;
    if (rip.media.kind !== 'series' || !rip.media.externalId || !rip.media.seasonNumber || !anidb.enabled) return;
    const seasons = anidb.seasonTitles(rip.media.externalId);
    // a season name only helps when the series has more than one season in AniDB
    if (seasons.length < 2) return;
    const s = seasons.find((x) => x.seasonNumber === rip.media.seasonNumber);
    if (s) rip.media.seasonTitle = s.english ?? s.titles[0];
  }

  private async identify(rip: DiscRip) {
    await this.identifyMedia(rip);
    try {
      this.nameSeason(rip);
      if (rip.media.seasonTitle) this.log(rip, `Season ${rip.media.seasonNumber} is "${rip.media.seasonTitle}"`);
    } catch {
      /* season names are cosmetic */
    }
  }

  private async identifyMedia(rip: DiscRip) {
    if (rip.media.externalId) return;
    const term = rip.media.title;
    if (!term) return;
    const { radarr, sonarr } = arr();
    // AniDB first: disc labels are often romaji / Japanese titles that TMDB / TVDB search does not find.
    if (anidb.enabled) {
      try {
        await anidb.ensure();
        const hit = anidb.search(term, 3).find((h) => h.score >= 60 && h.mapping && (h.mapping.tvdbId || h.mapping.tmdbId || h.mapping.imdbId));
        if (hit?.mapping) {
          const mp = hit.mapping;
          if (mp.isMovie && radarr.configured) {
            const r = (await radarr.lookup(mp.tmdbId ? `tmdb:${mp.tmdbId}` : `imdb:${mp.imdbId}`))[0];
            if (r) {
              rip.media = { ...rip.media, kind: 'movie', title: r.title, year: r.year, externalId: r.externalId, arrId: r.arrId, poster: r.poster, seriesType: 'anime' };
              this.log(rip, `Identified via AniDB (${hit.entry.main}, aid ${mp.aid}) as anime movie: ${r.title} (${r.year})`);
              return;
            }
          } else if (mp.tvdbId && sonarr.configured) {
            const r = (await sonarr.lookup(`tvdb:${mp.tvdbId}`))[0];
            if (r) {
              rip.media = { ...rip.media, kind: 'series', title: r.title, year: r.year, externalId: r.externalId, arrId: r.arrId, poster: r.poster, seriesType: 'anime', seasonNumber: rip.media.seasonNumber ?? mp.defaultSeason ?? 1, episodeStart: rip.media.episodeStart ?? 1, absoluteNumbering: true };
              this.log(rip, `Identified via AniDB (${hit.entry.main}, aid ${mp.aid}) as anime series: ${r.title} (${r.year})${mp.episodeOffset ? `, TVDB episode offset ${mp.episodeOffset}` : ''}`);
              return;
            }
          }
        }
      } catch (err) {
        this.log(rip, `AniDB lookup failed: ${(err as Error).message}`);
      }
    }
    const preferSeries = rip.media.kind === 'series';

    // Your own library first: a disc is usually for something you already have, and its label is often a nickname
    // ("SNAFU 2") that a TVDB / TMDB search gets wrong.
    try {
      const candidates: LibraryCandidate[] = [];
      if (sonarr.configured) {
        const anidbReady = anidb.enabled && (await anidb.ensure().then(() => true, () => false));
        for (const s of await sonarr.series()) {
          const fromAnidb = anidbReady ? anidb.seasonTitles(s.tvdbId).flatMap((x) => x.titles.map((title) => ({ title, seasonNumber: x.seasonNumber }))) : [];
          candidates.push({ kind: 'series', id: s.id, externalId: s.tvdbId, title: s.title, year: s.year, alternateTitles: s.alternateTitles, seasonTitles: [...(s.seasonTitles ?? []), ...fromAnidb], seasons: s.seasons.map((x) => x.seasonNumber) });
        }
      }
      if (radarr.configured) {
        for (const m of await radarr.movies()) candidates.push({ kind: 'movie', id: m.id, externalId: m.tmdbId, title: m.title, year: m.year, alternateTitles: m.alternateTitles });
      }
      const lib = matchLibrary(term, candidates, { preferSeries });
      if (lib) {
        const r = (lib.item.kind === 'series' ? await sonarr.lookup(`tvdb:${lib.item.externalId}`) : await radarr.lookup(`tmdb:${lib.item.externalId}`))[0];
        if (r) {
          rip.media =
            lib.item.kind === 'series'
              ? { ...rip.media, kind: 'series', title: r.title, year: r.year, externalId: r.externalId, arrId: r.arrId, poster: r.poster, seriesType: r.seriesType as RipMedia['seriesType'], seasonNumber: lib.season ?? rip.media.seasonNumber ?? 1, episodeStart: rip.media.episodeStart ?? 1 }
              : { ...rip.media, kind: 'movie', title: r.title, year: r.year, externalId: r.externalId, arrId: r.arrId, poster: r.poster };
          this.log(rip, `Identified from your library as ${lib.item.kind}: ${r.title} (${r.year ?? '?'})${lib.season ? `, season ${lib.season}` : ''} – matched "${lib.via}"`);
          return;
        }
      }
    } catch (err) {
      this.log(rip, `Library match failed: ${(err as Error).message}`);
    }

    // Search results are scored against the disc title; the first hit is not trusted blindly.
    const sequel = splitSequel(term);
    const bestOf = <T extends { title: string; alternateTitles?: string[] }>(list: T[], q: string) =>
      list
        .map((r) => ({ r, score: Math.max(nameScore(q, r.title), ...(r.alternateTitles ?? []).map((a) => nameScore(q, a))) }))
        .sort((a, b) => b.score - a.score)[0];
    const tryMovie = async (): Promise<RipMedia | null> => {
      if (!radarr.configured) return null;
      const hit = bestOf(await radarr.lookup(term), term);
      return hit && hit.score >= 0.6 ? { kind: 'movie', title: hit.r.title, year: hit.r.year, externalId: hit.r.externalId, arrId: hit.r.arrId, poster: hit.r.poster } : null;
    };
    const trySeries = async (): Promise<RipMedia | null> => {
      if (!sonarr.configured) return null;
      let hit = bestOf(await sonarr.lookup(term), term);
      let season = rip.media.seasonNumber;
      if ((!hit || hit.score < 0.6) && sequel) {
        const base = bestOf(await sonarr.lookup(sequel.base), sequel.base);
        if (base && base.score >= 0.6) {
          hit = base;
          season = sequel.season;
        }
      }
      return hit && hit.score >= 0.6 ? { kind: 'series', title: hit.r.title, year: hit.r.year, externalId: hit.r.externalId, arrId: hit.r.arrId, poster: hit.r.poster, seriesType: hit.r.seriesType as RipMedia['seriesType'], seasonNumber: season ?? 1, episodeStart: 1 } : null;
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

  /** Forget the current match and identify the disc again from its label (after a wrong automatic match). */
  async reidentify(id: string) {
    const rip = this.get(id);
    if (!rip) throw new Error('rip not found');
    const g = labelToTitle(rip.label || rip.volumeName);
    rip.media = { kind: g.season ? 'series' : rip.media.kind === 'series' ? 'series' : 'unknown', title: g.title, year: g.year, seasonNumber: g.season, episodeStart: 1, discNumber: g.disc ?? rip.media.discNumber };
    this.log(rip, `Matching "${g.title}" again`);
    await this.identify(rip);
    if (rip.titles.length) this.applyDefaultSelection(rip);
    store.saveRips();
    this.emit(rip);
    return rip;
  }

  /** Titles whose duration is roughly the sum of the other titles are "play all" compilations. */
  static playAllTitles(titles: DiscRip['titles']): number[] {
    if (titles.length < 3) return [];
    const out: number[] = [];
    for (const t of titles) {
      const others = titles.filter((o) => o.id !== t.id).reduce((a, o) => a + o.durationSeconds, 0);
      if (t.durationSeconds > 0 && Math.abs(t.durationSeconds - others) / Math.max(1, others) < 0.06) out.push(t.id);
      else {
        // Or it equals the sum of any 2+ shorter titles (extras present as well).
        const shorter = titles.filter((o) => o.id !== t.id && o.durationSeconds < t.durationSeconds).sort((a, b) => b.durationSeconds - a.durationSeconds);
        let sum = 0;
        let n = 0;
        for (const o of shorter) {
          sum += o.durationSeconds;
          n++;
          if (n >= 2 && Math.abs(t.durationSeconds - sum) / t.durationSeconds < 0.03) {
            out.push(t.id);
            break;
          }
        }
      }
    }
    return out;
  }

  private applyDefaultSelection(rip: DiscRip) {
    if (!rip.titles.length) {
      rip.selectedTitleIds = [];
      return;
    }
    rip.playAllTitleIds = DiscManager.playAllTitles(rip.titles);
    // Short titles (only listed when extras are included) start out as extras: creditless OP / ED, bonus clips.
    rip.titleRoles = guessExtraRoles(rip.titles);
    const extraIds = rip.titles.filter((t) => t.short).map((t) => t.id);
    if (rip.media.kind === 'series') {
      // Episodes: every full-length title except play-all compilations, in disc order.
      const episodes = rip.titles.filter((t) => !t.short && !rip.playAllTitleIds!.includes(t.id)).map((t) => t.id);
      // Multi-disc sets: disc N most likely starts after (N-1) × episodes-per-disc.
      if (rip.media.discNumber && rip.media.discNumber > 1 && (rip.media.episodeStart ?? 1) === 1) rip.media.episodeStart = (rip.media.discNumber - 1) * episodes.length + 1;
      rip.episodeMap = {};
      episodes.forEach((id, i) => (rip.episodeMap![id] = (rip.media.episodeStart ?? 1) + i));
      rip.selectedTitleIds = [...episodes, ...extraIds];
    } else {
      const longest = [...rip.titles].filter((t) => !t.short).sort((a, b) => b.durationSeconds - a.durationSeconds)[0] ?? rip.titles[0];
      rip.selectedTitleIds = [longest.id, ...extraIds.filter((id) => id !== longest.id)];
    }
    const mt = rip.media.kind === 'series' ? (rip.media.seriesType === 'anime' ? 'anime' : 'tv') : 'movie';
    // A profile picked when the release was grabbed wins over the defaults.
    const p = (rip.profileId && store.getProfile(rip.profileId)) || store.getProfile(store.settings.defaultProfiles[mt]);
    if (p) {
      rip.profileId = p.id;
      rip.profileName = p.name;
    }
  }

  /** User overrides from the UI. */
  update(id: string, patch: { media?: Partial<RipMedia>; selectedTitleIds?: number[]; episodeMap?: Record<number, number>; profileId?: string; options?: Partial<RipOptions>; audioMode?: 'best' | 'all' | 'custom'; selectedAudio?: Record<string, number[]>; titleRoles?: Record<string, TitleRole> }) {
    const rip = this.get(id);
    if (!rip) throw new Error('rip not found');
    if (patch.media) {
      const kindChanged = patch.media.kind && patch.media.kind !== rip.media.kind;
      const seasonChanged = patch.media.seasonNumber !== undefined || patch.media.externalId !== undefined;
      rip.media = { ...rip.media, ...patch.media };
      if (kindChanged) this.applyDefaultSelection(rip);
      if (seasonChanged) {
        try {
          this.nameSeason(rip);
        } catch {
          /* cosmetic */
        }
      }
    }
    if (patch.selectedTitleIds) rip.selectedTitleIds = patch.selectedTitleIds.filter((t) => rip.titles.some((x) => x.id === t));
    if (patch.episodeMap) rip.episodeMap = Object.fromEntries(Object.entries(patch.episodeMap).map(([k, v]) => [Number(k), Number(v)]));
    else if (rip.media.kind === 'series' && (patch.media?.episodeStart !== undefined || patch.selectedTitleIds || patch.media?.kind)) {
      // No explicit mapping: number the selected titles sequentially from the (possibly new) first episode.
      const start = rip.media.episodeStart ?? 1;
      rip.episodeMap = Object.fromEntries(rip.selectedTitleIds.map((id, i) => [id, start + i]));
    }
    if (patch.audioMode) rip.audioMode = patch.audioMode;
    if (patch.titleRoles) {
      rip.titleRoles = Object.fromEntries(Object.entries(patch.titleRoles).filter(([k, r]) => r.kind !== 'episode' && rip.titles.some((t) => String(t.id) === k)));
      // an episode number only belongs to titles that are episodes
      if (rip.episodeMap) for (const k of Object.keys(rip.titleRoles)) delete rip.episodeMap[Number(k)];
    }
    if (patch.selectedAudio) {
      rip.selectedAudio = { ...rip.selectedAudio, ...patch.selectedAudio };
      rip.audioMode = 'custom';
    }
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
    if (rip.discType === 'cd') return this.startCdRip(rip);
    if (rip.options.transcode && !rip.profileId) throw new Error('Pick an encoding profile or disable transcoding');
    rip.status = 'ripping';
    rip.error = undefined;
    rip.files = [];
    rip.startedAt = new Date().toISOString();
    rip.finishedAt = undefined;
    const base = rip.media.title ? `${safeName(rip.media.title)}${rip.media.year ? ` (${rip.media.year})` : ''}` : safeName(rip.label || `disc-${rip.id.slice(0, 8)}`);
    // Multi-disc sets get a folder per disc, so one disc's import never picks up another disc's half-finished files.
    const folder = rip.media.discNumber ? `${base} - Disc ${rip.media.discNumber}` : base;
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
      // macOS may have remounted the disc since the scan
      if (!rip.virtual && rip.drivePath) {
        const unmounted = await unmountForDirectAccess(rip.drivePath).catch(() => null);
        if (unmounted) this.log(rip, unmounted);
      }
      for (let i = 0; i < titles.length; i++) {
        const t = titles[i];
        rip.progress.titleIndex = i + 1;
        rip.progress.percent = 0;
        this.log(rip, `Title ${t.id}: ${t.name} (${Math.round(t.durationSeconds / 60)} min, ${(t.sizeBytes / 1e9).toFixed(1)} GB)`);
        // MakeMKV names files itself; rip into a private folder so concurrent rips cannot mix up each other's output.
        const work = path.join(rip.outputDir!, `.rexarr-rip-${rip.id.slice(0, 8)}`);
        fs.rmSync(work, { recursive: true, force: true });
        fs.mkdirSync(work, { recursive: true });
        let lastEmit = 0;
        const handle = ripTitle(
          this.makemkv(),
          rip.source ?? `disc:${rip.driveIndex}`,
          t.id,
          work,
          rip.scanMinSeconds ?? store.settings.disc.minTitleSeconds,
          (pct, step) => {
            rip.progress.percent = pct;
            rip.progress.step = step;
            rip.progress.etaSeconds = ripEta(rip, i, pct);
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
        const written = fs.readdirSync(work).filter((f) => f.toLowerCase().endsWith('.mkv'));
        const src = written.length ? path.join(work, written[0]) : path.join(work, t.fileName);
        if (!fs.existsSync(src)) throw new Error(`MakeMKV finished but no output file was found for title ${t.id}`);
        const dest = path.join(rip.outputDir!, this.fileNameFor(rip, t, i));
        fs.renameSync(src, dest);
        fs.rmSync(work, { recursive: true, force: true });
        const size = fs.statSync(dest).size;
        rip.files.push({ titleId: t.id, path: dest, sizeBytes: size });
        this.log(rip, `Ripped → ${path.basename(dest)} (${(size / 1e9).toFixed(2)} GB)`);
        store.saveRips();
        this.emit(rip);
      }
      rip.progress.percent = 100;
      rip.progress.etaSeconds = 0;
      if (rip.progress.startedAt) rip.ripSeconds = Math.round((Date.now() - new Date(rip.progress.startedAt).getTime()) / 1000);
      if (rip.options.transcode) {
        rip.status = 'transcoding';
        this.log(rip, `Queuing ${rip.files.length} file(s) for transcoding with "${rip.profileName}"`);
        for (const f of rip.files) {
          const job = queue.create({
            title: rip.media.title || rip.label,
            subtitle: rip.media.kind === 'series' ? `${path.basename(f.path, '.mkv').split(' - ')[1]} · disc rip` : `Disc rip · ${path.basename(f.path)}`,
            poster: rip.media.poster,
            profileId: rip.profileId!,
            trigger: 'disc',
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
    const role = rip.titleRoles?.[String(t.id)];
    if (role?.kind === 'special' && rip.media.kind === 'series') {
      return `${safeName(rip.media.title || rip.label)} - S00E${String(role.episode).padStart(2, '0')} - ${isDvd ? 'DVD' : `Bluray-${res} Remux`}.mkv`;
    }
    if (role?.kind === 'extra') {
      const label = extraLabel(role, t);
      const same = rip.titles.filter((x) => rip.selectedTitleIds.includes(x.id)).filter((x) => {
        const r = rip.titleRoles?.[String(x.id)];
        return r?.kind === 'extra' && extraLabel(r, x) === label;
      });
      const show = rip.media.kind === 'series' ? safeName(rip.media.title || rip.label) : `${safeName(rip.media.title || rip.label)}${rip.media.year ? ` (${rip.media.year})` : ''}`;
      return extraFileName(show, rip.media.kind === 'series' ? rip.media.seasonNumber : undefined, label, same.findIndex((x) => x.id === t.id) + 1, same.length);
    }
    if (rip.media.kind === 'series') {
      const ep = rip.episodeMap?.[t.id] ?? (rip.media.episodeStart ?? 1) + seq;
      const q = isDvd ? 'DVD' : `Bluray-${res} Remux`;
      const show = safeName(rip.media.title || rip.label);
      if (rip.media.absoluteNumbering) return `${show} - ${String(ep).padStart(3, '0')} - ${q}.mkv`;
      const s = String(rip.media.seasonNumber ?? 1).padStart(2, '0');
      return `${show} - S${s}E${String(ep).padStart(2, '0')} - ${q}.mkv`;
    }
    const base = `${safeName(rip.media.title || rip.label)}${rip.media.year ? ` (${rip.media.year})` : ''}`;
    const mains = rip.selectedTitleIds.filter((id) => rip.titleRoles?.[String(id)]?.kind !== 'extra');
    const extra = mains.length > 1 ? ` - Title ${t.id}` : '';
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

  /** The episodes Rexarr assigned to each ripped file, by file name, for Sonarr's Manual Import. */
  private knownEpisodes(rip: DiscRip): Map<string, KnownEpisode> {
    const out = new Map<string, KnownEpisode>();
    for (const f of rip.files) {
      const name = path.basename(f.finalPath ?? f.path);
      const role = rip.titleRoles?.[String(f.titleId)];
      if (role?.kind === 'extra') continue;
      if (role?.kind === 'special') out.set(name, { season: 0, episodes: [role.episode] });
      else {
        const ep = rip.episodeMap?.[f.titleId];
        if (ep) out.set(name, { season: rip.media.seasonNumber ?? 1, episodes: [ep], absolute: rip.media.absoluteNumbering });
      }
    }
    return out;
  }

  private reportImport(rip: DiscRip, outcomes: ImportOutcome[]) {
    const ok = outcomes.filter((o) => o.imported);
    const failed = outcomes.filter((o) => !o.imported);
    if (!outcomes.length) this.log(rip, 'Sonarr found nothing to import in the rip folder');
    if (ok.length) this.log(rip, `Sonarr imported ${ok.length} file(s)`);
    for (const f of failed) this.log(rip, `Not imported: ${f.file} – ${f.detail}`);
    if (failed.length) appEvents.add('warning', 'Disc ripping', `${failed.length} ripped file(s) of ${rip.media.title || rip.label} were not imported by Sonarr`, failed.map((f) => `${f.file}: ${f.detail}`).join('\n'));
  }

  /**
   * Import what is left in the rip folder: episodes whose import failed or was never asked for, files copied there by
   * hand. Folders that are still being ripped or encoded are skipped. Runs as a scheduled task and from Settings.
   */
  async importRipFolder(): Promise<{ folder: string; outcomes: ImportOutcome[] }[]> {
    const { sonarr } = arr();
    if (!sonarr.configured) throw new Error('Sonarr is not connected');
    const root = this.ripRoot();
    if (!fs.existsSync(root)) return [];
    const busy = new Set(store.rips.filter((r) => ['ripping', 'transcoding', 'delivering'].includes(r.status) && r.outputDir).map((r) => path.resolve(r.outputDir!)));
    const results: { folder: string; outcomes: ImportOutcome[] }[] = [];
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const dir = path.join(root, e.name);
      if (busy.has(path.resolve(dir)) || !folderIsSettled(dir)) continue;
      // the rip that made this folder knows the series and episodes; without one, Sonarr matches each file itself
      const rip = store.rips.find((r) => r.outputDir && path.resolve(r.outputDir) === path.resolve(dir) && r.media.kind === 'series' && r.media.arrId);
      try {
        const outcomes = await importIntoSonarr(sonarr, dir, rip ? { seriesId: rip.media.arrId, known: this.knownEpisodes(rip), dvd: rip.discType === 'dvd' } : {});
        if (!outcomes.length) {
          this.tidyRipFolder(dir);
          continue;
        }
        results.push({ folder: e.name, outcomes });
        if (rip) this.reportImport(rip, outcomes);
        this.tidyRipFolder(dir);
      } catch (err) {
        results.push({ folder: e.name, outcomes: [{ file: e.name, imported: false, detail: (err as Error).message }] });
      }
    }
    return results;
  }

  /** Remove a rip folder once only Rexarr's own leftovers remain (empty work folders, .DS_Store). */
  private tidyRipFolder(dir: string) {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory() && e.name.startsWith('.rexarr-rip-') && !fs.readdirSync(p).length) fs.rmdirSync(p);
        else if (e.name === '.DS_Store') fs.rmSync(p, { force: true });
      }
      if (!fs.readdirSync(dir).length) fs.rmdirSync(dir);
    } catch {
      /* leave it */
    }
  }

  /**
   * Extras are not episodes or movies, so Sonarr / Radarr would reject them: move them into an "Extras" folder next
   * to the show or movie (Plex, Jellyfin and Emby pick them up there) before the import. Files that cannot be moved
   * stay in the rip folder's Extras sub-folder.
   */
  private async deliverExtras(rip: DiscRip) {
    const extras = rip.files.filter((f) => rip.titleRoles?.[String(f.titleId)]?.kind === 'extra');
    if (!extras.length) return;
    const { radarr, sonarr } = arr();
    let target: string | null = null;
    try {
      if (rip.media.kind === 'series' && rip.media.arrId && sonarr.configured) {
        const s = await sonarr.seriesById(rip.media.arrId);
        target = path.join(toLocalPath(s.path, 'sonarr'), 'Extras');
      } else if (rip.media.kind === 'movie' && rip.media.arrId && radarr.configured) {
        const m = await radarr.movie(rip.media.arrId);
        target = path.join(toLocalPath(m.path, 'radarr'), 'Extras');
      }
    } catch (err) {
      this.log(rip, `Could not find the library folder for extras: ${(err as Error).message}`);
    }
    // the library folder must already exist here; otherwise keep extras out of the import in the rip folder
    if (!target || !fs.existsSync(path.dirname(target))) target = path.join(rip.outputDir!, 'Extras');
    fs.mkdirSync(target, { recursive: true });
    for (const f of extras) {
      const from = f.finalPath ?? f.path;
      if (!fs.existsSync(from)) continue;
      const to = path.join(target, path.basename(from).replace(/\.rexarr(?=\.\w+$)/, ''));
      try {
        try {
          fs.renameSync(from, to);
        } catch {
          // another volume (local rip folder → NAS library): copy, then remove
          fs.copyFileSync(from, to);
          fs.unlinkSync(from);
        }
        f.finalPath = to;
        this.log(rip, `Extra → ${to}`);
      } catch (err) {
        this.log(rip, `Could not move extra ${path.basename(from)}: ${(err as Error).message}`);
      }
    }
    // Sonarr / Radarr scan the rip folder recursively but leave folders named "Extras" alone.
    store.saveRips();
  }

  /** Hand the folder to Radarr / Sonarr for import (DownloadedMoviesScan / DownloadedEpisodesScan), then eject. */
  private async deliver(rip: DiscRip) {
    rip.status = 'delivering';
    this.emit(rip);
    try {
      if (rip.options.deliver && rip.media.kind === 'album') {
        const { lidarr } = arr();
        if (store.settings.disc.cd.deliverToLidarr && lidarr.configured) {
          await lidarr.importFolder(toArrPath(rip.outputDir!, 'lidarr'));
          this.log(rip, `Asked Lidarr to import ${toArrPath(rip.outputDir!, 'lidarr')}`);
        } else this.log(rip, `Album left in ${rip.outputDir}${lidarr.configured ? '' : ' (Lidarr is not connected)'}`);
      } else if (rip.options.deliver && rip.media.kind !== 'unknown' && rip.media.externalId) {
        const { radarr, sonarr } = arr();
        const dir = rip.outputDir!;
        await this.deliverExtras(rip);
        if (rip.media.kind === 'movie' && radarr.configured) {
          if (!rip.media.arrId) {
            const m = await radarr.add(rip.media.externalId);
            rip.media.arrId = m.id;
            this.log(rip, `Added ${m.title} to Radarr`);
          }
          await radarr.http.post('/command', { name: 'DownloadedMoviesScan', path: toArrPath(dir, 'radarr'), importMode: 'Move' });
          this.log(rip, `Asked Radarr to import ${toArrPath(dir, 'radarr')}`);
        } else if (rip.media.kind === 'series' && sonarr.configured) {
          if (!rip.media.arrId) {
            const s = await sonarr.add(rip.media.externalId, rip.media.seriesType ?? 'standard');
            rip.media.arrId = s.id;
            this.log(rip, `Added ${s.title} to Sonarr`);
          }
          // explicit series and episodes: a folder scan would guess the series from "Show (Year) - Disc 1" and skip it
          const outcomes = await importIntoSonarr(sonarr, dir, { seriesId: rip.media.arrId, known: this.knownEpisodes(rip), dvd: rip.discType === 'dvd', log: (l) => this.log(rip, l) });
          this.reportImport(rip, outcomes);
        } else this.log(rip, 'No matching *arr app configured; files left in the rip folder');
      } else this.log(rip, `Files left in ${rip.outputDir}`);
      if (rip.arrQueue && rip.options.deliver) {
        // Clear the stuck "no files eligible for import" download from the *arr queue; the download client keeps it.
        const others = store.rips.some((r) => r.id !== rip.id && r.arrQueue?.id === rip.arrQueue!.id && r.arrQueue.arr === rip.arrQueue!.arr && r.status !== 'done' && r.status !== 'failed' && r.status !== 'cancelled');
        if (!others) {
          try {
            const { radarr, sonarr } = arr();
            await (rip.arrQueue.arr === 'radarr' ? radarr : sonarr).removeFromQueue(rip.arrQueue.id);
            this.log(rip, `Removed "${rip.arrQueue.title}" from the ${rip.arrQueue.arr === 'radarr' ? 'Radarr' : 'Sonarr'} queue (download kept in the client)`);
          } catch (err) {
            this.log(rip, `Could not clear the download from the queue: ${(err as Error).message}`);
          }
        }
      }
      if (rip.options.eject && rip.virtual) {
        const linked = (store.settings.disc.virtualDrives ?? []).find((v) => v.path === rip.drivePath);
        if (linked) {
          this.removeVirtualDrive(linked.id);
          this.log(rip, `Virtual drive "${linked.label ?? rip.label}" ejected (link removed)`);
        } else this.log(rip, 'Virtual disc: nothing to eject');
      }
      else if (rip.options.eject) {
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
    this.scans.get(id)?.abort();
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
    if (this.running.has(id) || this.scans.has(id)) this.cancel(id);
    store.setRips(store.rips.filter((r) => r.id !== id));
    bus.publish({ type: 'rip-removed', id });
  }

  async eject(driveIndex: number) {
    const d = this.drives.find((x) => x.index === driveIndex) ?? (await this.refreshDrives()).find((x) => x.index === driveIndex);
    if (d?.virtual) {
      // Ejecting a linked virtual drive removes the link; folder-scanned ones just stay.
      if (d.virtualId) this.removeVirtualDrive(d.virtualId);
      return;
    }
    await ejectDrive(d?.path ?? '');
    setTimeout(() => void this.refreshDrives(), 3000).unref();
  }

  /** Add a real optical drive by device path (/dev/sr0, /dev/disk4). */
  async addPhysicalDrive(p: string, label?: string) {
    const clean = p.trim();
    if (!clean) throw new Error('Device path required');
    if (process.platform !== 'win32' && !clean.startsWith('/dev/')) throw new Error('Use the device path, e.g. /dev/sr0 (Linux) or /dev/disk4 (macOS)');
    const s = store.settings;
    const list = s.disc.physicalDrives ?? [];
    const existing = list.find((d) => canonicalDevice(d.path) === canonicalDevice(clean));
    if (existing) return existing;
    const drive = { id: randomUUID(), path: clean, label: label?.trim() || undefined, addedAt: new Date().toISOString() };
    store.saveSettings({ ...s, disc: { ...s.disc, physicalDrives: [...list, drive] } });
    appEvents.add('info', 'Disc', `Drive added: ${clean}${fs.existsSync(clean) ? '' : ' (device not present yet)'}`);
    await this.refreshDrives();
    if (s.disc.enabled) void this.poll();
    return drive;
  }

  removePhysicalDrive(id: string) {
    const s = store.settings;
    const list = s.disc.physicalDrives ?? [];
    const drive = list.find((d) => d.id === id);
    if (!drive) return false;
    store.saveSettings({ ...s, disc: { ...s.disc, physicalDrives: list.filter((d) => d.id !== id) } });
    this.drives = this.drives.filter((d) => d.manualId !== id || d.detected);
    for (const d of this.drives) if (d.manualId === id) delete d.manualId;
    bus.publish({ type: 'drives', drives: this.drives });
    return true;
  }

  /** Link an image / disc folder as a persistent virtual drive. */
  async addVirtualDrive(p: string, label?: string) {
    const clean = p.trim().replace(/[\\/]+$/, '');
    const probe = virtualDriveForPath(clean, 0);
    if (!probe) throw new Error('Not a disc image (.iso / .img) or a DVD / Blu-ray folder (VIDEO_TS / BDMV)');
    const s = store.settings;
    const list = s.disc.virtualDrives ?? [];
    const existing = list.find((v) => v.path === probe.path);
    if (existing) return existing;
    const vd = { id: randomUUID(), path: probe.path, label: label?.trim() || undefined, addedAt: new Date().toISOString() };
    store.saveSettings({ ...s, disc: { ...s.disc, virtualDrives: [...list, vd] } });
    await this.refreshDrives();
    if (s.disc.enabled) void this.poll();
    return vd;
  }

  removeVirtualDrive(id: string) {
    const s = store.settings;
    const list = s.disc.virtualDrives ?? [];
    if (!list.some((v) => v.id === id)) return false;
    store.saveSettings({ ...s, disc: { ...s.disc, virtualDrives: list.filter((v) => v.id !== id) } });
    this.drives = this.drives.filter((d) => d.virtualId !== id);
    bus.publish({ type: 'drives', drives: this.drives });
    return true;
  }

  /** Open an ISO / IMG file or a DVD / Blu-ray folder from anywhere on disk as a one-off virtual disc. */
  async openImage(p: string, preset?: RipPreset): Promise<DiscRip> {
    const drive = virtualDriveForPath(p.trim(), 2000 + store.rips.length);
    if (!drive) throw new Error('Not a disc image (.iso / .img) or a DVD / Blu-ray folder (VIDEO_TS / BDMV)');
    const existing = store.rips.find((r) => r.drivePath === drive.path && ACTIVE.includes(r.status));
    if (existing) return existing;
    const rip = this.createRip(drive, preset);
    void this.scan(rip.id).then(async () => {
      const r = this.get(rip.id);
      if (!r || r.status !== 'ready' || !r.autoStart) return;
      try {
        await this.startRip(r.id, {});
      } catch (err) {
        this.log(r, `Could not start automatically: ${(err as Error).message}`);
        store.saveRips();
        this.emit(r);
      }
    });
    return rip;
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

/** Seconds left for the whole rip, from how long the finished titles took plus progress on the current one. */
function ripEta(rip: DiscRip, titleIndex: number, percent: number): number | undefined {
  const started = rip.progress.startedAt ? new Date(rip.progress.startedAt).getTime() : 0;
  if (!started) return undefined;
  const elapsed = (Date.now() - started) / 1000;
  const done = titleIndex + Math.min(100, Math.max(0, percent)) / 100;
  if (done < 0.02 || elapsed < 5) return undefined;
  const perTitle = elapsed / done;
  return Math.max(0, Math.round(perTitle * (rip.progress.titleCount - done)));
}
