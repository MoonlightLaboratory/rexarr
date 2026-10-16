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
import { autoDetectedDrives, canonicalDevice, driveSources, listDriveCandidates, probePhysicalDrive } from './devices.js';
import { execFile } from 'node:child_process';
import { discId, downloadCover, getRelease, lookupDisc, readCdToc, tocString } from '../music/musicbrainz.js';
import { freacInfo, ripCdTrack } from '../music/freac.js';
import { cddbDiscId, cddbLookup } from '../music/cddb.js';
import { cdTrackTags } from '../music/tags.js';
import { detectMqa } from '../audio/mqa.js';
import { proxiedImage } from '../routes/images.js';
import { appEvents } from '../system.js';
import { ejectDrive, emptyScanNote, isOpenFailure, openFailureReason, labelToTitle, listDrives, listVirtualDrives, readDisc, readScanOutput, resolveMakemkv, ripArgs, ripTitle, scanArgs, unmountForDirectAccess, virtualDriveForPath, type RipHandle } from './makemkv.js';
import { isOnline, listAgents } from '../agents/registry.js';
import { readOnAgent, runOnAgent } from '../agents/remote.js';
import { applyEntry, buildEntry, fingerprintOf, lookupDisc as lookupInRexDb, rexdbSettings, submitEntry } from './rexdb.js';
import { boxSetName, discFreed, driveBusy, driveKey, expectedDiscCount, nextWantedDisc, sameSet, sortDiscs } from '../../../shared/boxset.js';
import { byTitle, omdbConfigured } from '../omdb.js';
import { audioSelectionFor, describeTracks } from './audio.js';
import { ensureRipFolder } from './ripFolder.js';
import { extraFileName, extraLabel, guessExtraRoles } from './extras.js';
import { toLocalPath } from '../paths.js';
import { canSeeFolder, deliveryProblem, folderIsSettled, importIntoRadarr, importIntoSonarr, type ImportOutcome, type KnownEpisode } from './arrImport.js';
import { pickAddTarget } from './addTarget.js';
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
  /**
   * Drives emptied for the next disc of a set, by device node. Not saved: a drive that is waiting is waiting for
   * someone standing in front of it, and an expectation outliving a restart would be stale by the time it mattered.
   */
  private awaiting = new Map<string, { batchId: string; batchName: string; discNumber: number }>();


  drives: DiscDrive[] = [];
  private lastDriveError = '';

  start() {
    for (const r of store.rips) {
      if (['scanning', 'ripping', 'delivering'].includes(r.status)) {
        r.status = 'failed';
        r.error = 'Server restarted mid-rip';
        // and it is finished with, or the disc still in the drive is detected as new on the next poll
        r.finishedAt = new Date().toISOString();
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

  /** What the drives are busy with right now ("ripping Naruto_D2"), or nothing. */
  get activity(): string[] {
    return store.rips.filter((r) => r.status === 'ripping' || r.status === 'scanning').map((r) => `${r.status} ${r.label || r.media.title || 'a disc'}`);
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
    // MakeMKV drives have small indexes; auto-detected ones start at 2000, linked virtual drives at 3000,
    // probed manual drives at 4000 and an agent's at 5000
    const known = this.drives.filter((d) => !d.virtual && d.index < 2000);
    if (busy && known.length) real = await this.noticeAwaitedDiscs(known);
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
    // Drives the machine has that MakeMKV did not list - a USB drive it calls "Unsupported", one passed into
    // Docker without its /dev/sg node, or MakeMKV simply not being installed yet. Saying "no optical drive"
    // when there is one in the machine is the wrong answer, so they are added, marked as found rather than listed.
    let auto: DiscDrive[] = [];
    if (!busy) {
      try {
        auto = await autoDetectedDrives(
          [...real.map((d) => d.path), ...manual.map((d) => d.path), ...(store.settings.disc.physicalDrives ?? []).map((p) => p.path)],
          2000,
          // an empty drive has no device on either side, so MakeMKV's model names are what stops it being listed twice
          [...real.map((d) => d.name), ...manual.map((d) => d.name)],
        );
      } catch (err) {
        this.lastDriveError = `drive detection: ${(err as Error).message}`;
      }
    } else auto = this.drives.filter((d) => d.auto);

    // Rip farm: the drives on the agents, as they last reported them. They keep their own source string -
    // the agent runs makemkvcon on its own machine, where disc:0 means that machine's first drive.
    const farm: DiscDrive[] = [];
    if (store.settings.agents?.enabled) {
      for (const [ai, a] of listAgents().filter((x) => x.enabled && x.capabilities.rip && isOnline(x)).entries()) {
        for (const [di, d] of (a.drives ?? []).entries()) {
          farm.push({ ...d, index: 5000 + ai * 100 + di, agentId: a.id, agentName: a.name, name: `${d.name || 'Drive'} · ${a.name}` });
        }
      }
    }
    this.drives = [...real, ...auto, ...manual, ...virtual, ...linked, ...farm];
    // what each drive is waiting for, so the page can say which disc to put in it
    for (const d of this.drives) d.awaiting = this.awaiting.get(driveKey(d));
    bus.publish({ type: 'drives', drives: this.drives });
    return this.drives;
  }
  /**
   * Where disc N of a set probably starts.
   *
   * Nothing on the disc says it, and Sonarr cannot help once a season is complete — every episode has a file
   * either way. What Rexarr does know is the discs of the same set it has ripped before, so the episode after
   * the highest one of those is the best answer available. Failing that, it assumes every disc held as many as
   * this one, which is right for a set of equal discs and wrong for the common case where the first two hold
   * more. Either way the caller marks it as a guess, because it is one.
   */
  private guessEpisodeStart(rip: DiscRip, episodeCount: number): number {
    const sameSet = this.list().filter(
      (r) =>
        r.id !== rip.id &&
        r.media.kind === 'series' &&
        r.media.arrId !== undefined &&
        r.media.arrId === rip.media.arrId &&
        (r.media.seasonNumber ?? 1) === (rip.media.seasonNumber ?? 1) &&
        (r.media.discNumber ?? 1) < (rip.media.discNumber ?? 1),
    );
    const highest = Math.max(0, ...sameSet.flatMap((r) => Object.values(r.episodeMap ?? {})));
    if (highest > 0) return highest + 1;
    return ((rip.media.discNumber ?? 1) - 1) * episodeCount + 1;
  }

  /**
   * Does this disc belong with one already in the queue?
   *
   * Nothing is created here. A set that does not exist yet is only named and offered, because a disc that turns
   * out to be a one-off should not leave a set behind it. Accepting is what makes the set - see joinBatch.
   */
  private offerBatch(rip: DiscRip, force = false) {
    if (!store.settings.disc.groupBoxSets && !force) return;
    // a disc taken out of a set is not offered it again on its own, but asking for it is a different thing
    if (rip.batch || rip.media.kind !== 'series' || (rip.batchDeclined && !force)) return;
    // the nearest other disc of the same season: one already in a set decides which set, so it is preferred
    const siblings = this.list().filter((r) => r.id !== rip.id && !r.virtual && sameSet(r.media, rip.media));
    const inSet = siblings.find((r) => r.batch);
    const match = inSet ?? sortDiscs(siblings)[0];
    if (!match) {
      rip.batchSuggestion = undefined;
      return;
    }
    const why = rip.media.arrId !== undefined && match.media.arrId === rip.media.arrId ? `same series and season as ${match.label || 'the other disc'}` : `its label reads as the same series and season as ${match.label || 'another disc'}`;
    rip.batchSuggestion = { id: match.batch?.id, name: match.batch?.name ?? boxSetName(rip.media), ripId: match.id, why };
  }

  /**
   * A drive emptied for the next disc of a set has to notice that disc arriving even while another drive is
   * ripping - that is the whole point of swapping, and waiting for every rip to finish first would undo it.
   *
   * MakeMKV is not asked: listing its drives makes it query every one of them, which is exactly what disturbs the
   * rip in flight. The machine can say what is in a tray on its own, and that is all that is needed here. The
   * device node is read fresh too, because a tray that has been opened may come back as a different one.
   */
  private async noticeAwaitedDiscs(known: DiscDrive[]): Promise<DiscDrive[]> {
    if (!known.some((d) => this.awaiting.has(driveKey(d)))) return known;
    const candidates = await listDriveCandidates().catch(() => []);
    if (!candidates.length) return known;
    const model = (n: string) => n.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const out: DiscDrive[] = [];
    for (const d of known) {
      if (!this.awaiting.has(driveKey(d))) {
        out.push(d);
        continue;
      }
      const mine = model(d.name);
      // the two sources decorate a model differently, so one name contains the other rather than equalling it
      const c = candidates.find((x) => {
        const theirs = model(x.name);
        return Boolean(theirs) && Boolean(mine) && (mine.includes(theirs) || theirs.includes(mine));
      });
      if (!c?.path) {
        out.push(d);
        continue;
      }
      // the candidate has the device; what is in it takes a probe, which reads the volume rather than the drive
      const probed = await probePhysicalDrive({ id: `await:${c.path}`, path: c.path, label: '', addedAt: '' }, d.index).catch(() => null);
      if (!probed || probed.state !== 'loaded' || !probed.discLabel || probed.discLabel === d.discLabel) {
        out.push(d);
        continue;
      }
      out.push({ ...d, path: c.path, state: 'loaded', discLabel: probed.discLabel });
    }
    return out;
  }


  /** The rip whose disc is in this drive now, if any. */
  private ripInDrive(d: DiscDrive): DiscRip | undefined {
    if (!d.path) return undefined;
    const want = canonicalDevice(d.path);
    return this.list().find((r) => r.drivePath && canonicalDevice(r.drivePath) === want && !['cancelled'].includes(r.status));
  }

  /** How many discs a set holds, as far as anything here knows. */
  private expectedFor(batchId: string): number | undefined {
    const members = this.list().filter((r) => r.batch?.id === batchId);
    const pinned = members.find((r) => r.batch?.discsPinned && r.batch.expectedDiscs)?.batch?.expectedDiscs;
    if (pinned) return pinned;
    const stored = members.find((r) => r.batch?.expectedDiscs)?.batch?.expectedDiscs;
    return stored ?? expectedDiscCount(members, 0);
  }

  /**
   * Empty a drive and have it wait for the next disc of the set its disc belonged to.
   *
   * The disc comes out as soon as the copy is made - remuxing reads from disk, so holding the tray shut for the
   * length of an encode would idle the drive for nothing.
   */
  async swapDrive(index: number, claimed: number[] = []): Promise<{ drive: number; waitingFor?: number; batch?: string }> {
    const d = this.drives.find((x) => x.index === index);
    if (!d) throw new Error('drive not found');
    const rip = this.ripInDrive(d);
    if (driveBusy(rip)) throw new Error(`${d.name || 'That drive'} is still reading its disc`);
    // Swapping says "done with this disc, give me the next of the set", which a disc that has not been copied is
    // not. Ejecting a disc nobody asked to rip is what the eject button is for.
    if (rip && !discFreed(rip)) throw new Error(`${rip.label || 'That disc'} has not been copied yet – eject it instead if you do not want it`);
    const batch = rip?.batch;
    if (batch) {
      const members = this.list().filter((r) => r.batch?.id === batch.id);
      const taken = [...claimed, ...[...this.awaiting.values()].filter((a) => a.batchId === batch.id).map((a) => a.discNumber)];
      const next = nextWantedDisc(members, this.expectedFor(batch.id), taken);
      if (next !== undefined) {
        this.awaiting.set(driveKey(d), { batchId: batch.id, batchName: batch.name, discNumber: next });
        d.awaiting = { batchId: batch.id, batchName: batch.name, discNumber: next };
      }
      await this.eject(index);
      bus.publish({ type: 'drives', drives: this.drives });
      return { drive: index, waitingFor: next, batch: batch.name };
    }
    await this.eject(index);
    return { drive: index };
  }

  /** Empty every drive whose disc has been copied, so a whole stack can be swapped in one pass. */
  async swapAllFinished(): Promise<{ drive: number; waitingFor?: number; batch?: string }[]> {
    const out: { drive: number; waitingFor?: number; batch?: string }[] = [];
    // each drive claims its own disc number, or two emptied together would both ask for the same one
    const claimed: number[] = [];
    for (const d of this.drives.filter((x) => !x.virtual && x.state === 'loaded')) {
      const rip = this.ripInDrive(d);
      if (!rip || !discFreed(rip)) continue;
      try {
        const r = await this.swapDrive(d.index, claimed);
        if (r.waitingFor !== undefined) claimed.push(r.waitingFor);
        out.push(r);
      } catch {
        // a drive that will not give its disc up is not a reason to leave the rest of the stack shut
      }
    }
    return out;
  }

  /**
   * A disc has turned up in a drive that was waiting for a particular one. Put it where it belongs, or say why it
   * cannot go there - nothing is filed by force, because a disc in the wrong slot is numbered from the wrong place.
   */
  private placeInAwaitedSlot(rip: DiscRip, want: { batchId: string; batchName: string; discNumber: number }): boolean {
    const members = this.list().filter((r) => r.batch?.id === want.batchId && r.id !== rip.id);
    const anchor = members[0];
    if (!anchor) return false;
    if (!sameSet(anchor.media, rip.media)) {
      // not this set at all: an unidentified disc is simply not placed, an identified one is queried
      if (rip.media.kind !== 'series' || !rip.media.title) return false;
      rip.slotWarning = {
        batchId: want.batchId,
        batchName: want.batchName,
        expectedDisc: want.discNumber,
        kind: 'wrong-series',
        message: `This reads as ${rip.media.title}${rip.media.seasonNumber ? ` season ${rip.media.seasonNumber}` : ''}, not ${want.batchName}.`,
      };
      return true;
    }
    // the right series: the label's own disc number wins, since the disc knows better than the drive did
    const disc = rip.media.discNumber ?? want.discNumber;
    const clash = members.find((r) => r.media.discNumber === disc);
    if (clash) {
      rip.slotWarning = { batchId: want.batchId, batchName: want.batchName, expectedDisc: want.discNumber, kind: 'duplicate', message: `Disc ${disc} of ${want.batchName} is already here.` };
      return true;
    }
    if (rip.media.discNumber !== undefined && rip.media.discNumber !== want.discNumber) {
      rip.slotWarning = { batchId: want.batchId, batchName: want.batchName, expectedDisc: want.discNumber, kind: 'unexpected-disc', message: `The drive was waiting for disc ${want.discNumber} and this reads as disc ${disc}.` };
      return true;
    }
    rip.media.discNumber = disc;
    rip.batch = { id: want.batchId, name: want.batchName };
    rip.batchSuggestion = undefined;
    this.log(rip, `Put into "${want.batchName}" as disc ${disc} – the drive was waiting for it`);
    return true;
  }

  /** Answer a slot warning: file it at a disc number, or leave it out of the set. */
  resolveSlot(id: string, opts: { disc?: number; reject?: boolean }): DiscRip | undefined {
    const rip = this.get(id);
    const w = rip?.slotWarning;
    if (!rip || !w) return rip;
    if (opts.reject) {
      rip.slotWarning = undefined;
      rip.batchDeclined = true;
      this.log(rip, `Left out of "${w.batchName}"`);
    } else {
      const disc = opts.disc ?? rip.media.discNumber ?? w.expectedDisc;
      rip.media.discNumber = disc;
      rip.batch = { id: w.batchId, name: w.batchName };
      rip.slotWarning = undefined;
      rip.batchSuggestion = undefined;
      this.log(rip, `Put into "${w.batchName}" as disc ${disc}`);
    }
    store.saveRips();
    this.emit(rip);
    return rip;
  }

  /** Accept a suggested set: the one it names, or a new one holding both discs. */
  joinBatch(id: string, force = false): DiscRip | undefined {
    const rip = this.get(id);
    if (!rip) return undefined;
    // asked for by hand: work out the set now rather than waiting for the disc to be read again
    if (force && !rip.batchSuggestion) this.offerBatch(rip, true);
    const s = rip.batchSuggestion;
    if (!s) return rip;
    const batch = s.id ? { id: s.id, name: s.name } : { id: randomUUID(), name: s.name };
    rip.batch = batch;
    rip.batchSuggestion = undefined;
    rip.batchDeclined = undefined;
    // a set that did not exist until now takes in the disc that matched, or it would be a set of one
    const match = this.get(s.ripId);
    if (!s.id && match && !match.batch) {
      match.batch = batch;
      match.batchSuggestion = undefined;
      // it is in the set too, so its own log should say so rather than leaving it to be inferred
      this.log(match, `Added to the box set "${batch.name}" with ${rip.label || 'the disc just read'}`);
      this.emit(match);
    }
    this.log(rip, `Added to the box set "${batch.name}"`);
    store.saveRips();
    this.emit(rip);
    return rip;
  }

  /** Decline it, and do not ask about this disc again. */
  declineBatch(id: string): DiscRip | undefined {
    const rip = this.get(id);
    if (!rip) return undefined;
    rip.batchSuggestion = undefined;
    rip.batchDeclined = true;
    store.saveRips();
    this.emit(rip);
    return rip;
  }

  /** Take a disc out of its set. The set is its discs, so the last one out dissolves it. */
  leaveBatch(id: string): DiscRip | undefined {
    const rip = this.get(id);
    if (!rip?.batch) return rip;
    const was = rip.batch;
    rip.batch = undefined;
    rip.batchDeclined = true;
    // The set used to dissolve when one disc was left, which took that disc out of a set nobody had asked to
    // break up - the other half of the set simply vanished. A set of one is kept: more discs are usually coming.
    const left = this.list().filter((r) => r.batch?.id === was.id);
    for (const r of left) this.emit(r);
    this.log(rip, `Taken out of the box set "${was.name}"`);
    store.saveRips();
    this.emit(rip);
    return rip;
  }

  /** Change a set - its name, or how many discs it holds - on every disc that is in it. */
  updateBatch(batchId: string, patch: { name?: string; expectedDiscs?: number }): number {
    const members = this.list().filter((r) => r.batch?.id === batchId);
    for (const r of members) {
      const was = r.batch!;
      r.batch = {
        id: batchId,
        name: patch.name ?? was.name,
        expectedDiscs: patch.expectedDiscs ?? was.expectedDiscs,
        // a count given by hand is not recalculated afterwards
        discsPinned: patch.expectedDiscs !== undefined ? true : was.discsPinned,
      };
      this.emit(r);
    }
    if (members.length) store.saveRips();
    return members.length;
  }

  /** The agent whose drive this rip is in, when it is not one of ours. */
  private agentFor(rip: DiscRip): { id: string; name: string } | undefined {
    const d = this.drives.find((x) => x.index === rip.driveIndex);
    return d?.agentId && d.agentName ? { id: d.agentId, name: d.agentName } : undefined;
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
        // One drive can reach the list under two names – MakeMKV reports /dev/rdisk5 where Rexarr's own detection
        // finds /dev/disk5 – and the entries for a disc must be found whichever of the two it was created under.
        const sameDrive = (r: DiscRip) => r.drivePath === d.path || (!!r.drivePath && !!d.path && canonicalDevice(r.drivePath) === canonicalDevice(d.path));
        const active = store.rips.find((r) => sameDrive(r) && r.label === label && ACTIVE.includes(r.status));
        if (active) continue;
        // A drive holds one disc. Right after it is (re)connected the label can read blank for a moment – that is the
        // same disc, not a new one – and a disc that is still being scanned or ripped must not get a second entry.
        const busy = store.rips.find((r) => sameDrive(r) && ['inserted', 'scanning', 'ripping'].includes(r.status));
        if (busy || !label) continue;
        // A disc that already finished (or failed) and is still in the tray is not ripped again until it is swapped.
        const recent = store.rips.find((r) => sameDrive(r) && r.label === label && r.finishedAt && Date.now() - new Date(r.finishedAt).getTime() < 6 * 3600_000);
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
    const profile = preset?.profileId ? store.anyProfile(preset.profileId) : undefined;
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

  /**
   * The ways to address this disc's drive, best first. More than one because neither of MakeMKV's handles is
   * dependable on its own - see driveSources - and a scan works down the list when a disc will not open.
   */
  private sourcesFor(rip: DiscRip): string[] {
    const stored = rip.source ?? `disc:${rip.driveIndex}`;
    if (rip.virtual || !rip.drivePath) return [stored];
    const want = canonicalDevice(rip.drivePath);
    return driveSources(stored, this.drives.find((d) => d.path && !d.virtual && canonicalDevice(d.path) === want));
  }

  private sourceFor(rip: DiscRip): string {
    return this.sourcesFor(rip)[0] ?? `disc:${rip.driveIndex}`;
  }

  /** Read the title list and try to identify the disc. */
  async scan(id: string, attempt = 0): Promise<void> {
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
      const sources = this.sourcesFor(rip);
      const source = sources[Math.min(attempt, sources.length - 1)];
      this.log(rip, `makemkvcon info ${source}, minimum title length ${rip.scanMinSeconds}s`);
      const onAgent = this.agentFor(rip);
      if (onAgent) this.log(rip, `Reading it on agent "${onAgent.name}"`);
      const scan = (minSeconds: number) =>
        onAgent
          ? readOnAgent({ agentId: onAgent.id, ownerId: rip.id, label: `Scan ${rip.label || source}`, args: scanArgs(source, minSeconds), onLog: (l) => this.log(rip, l) }).done.then((r) => {
              if (r.code !== 0 && !r.stdout) throw new Error(`makemkvcon on ${onAgent.name} exited with code ${r.code}`);
              return readScanOutput(r.stdout, source);
            })
          : readDisc(this.makemkv(), source, minSeconds, abort.signal);
      const info = await scan(rip.scanMinSeconds).finally(() => this.scans.delete(rip.id));
      if ((rip.status as RipStatus) === 'cancelled') return;
      for (const t of info.titles) if (t.durationSeconds < d.minTitleSeconds) t.short = true;
      rip.discType = info.type;
      rip.volumeName = info.volumeName;
      rip.titles = info.titles;
      if (!rip.label && info.name) rip.label = info.name;
      const shorts = info.titles.filter((t) => t.short).length;
      this.log(rip, `${info.type} disc, ${info.titles.length - shorts} title(s) of at least ${d.minTitleSeconds}s${shorts ? ` and ${shorts} shorter extra(s)` : ''}`);
      rip.scanNote = undefined;
      if (!info.titles.length) {
        // Nothing came back: read it again with no minimum, so the note can say which of the two reasons it is.
        const plain = rip.scanMinSeconds > 0 ? await scan(0).catch(() => null) : info;
        rip.scanNote = emptyScanNote(
          source,
          rip.scanMinSeconds,
          plain ? { count: plain.titles.length, longestSeconds: Math.max(0, ...plain.titles.map((t) => t.durationSeconds)) } : null,
          [...(info.messages ?? []), ...(plain?.messages ?? [])],
        );
        this.log(rip, rip.scanNote);
      }
      if (!rip.media.title) {
        const g = labelToTitle(info.name || info.volumeName);
        rip.media = { ...rip.media, title: g.title, year: g.year, seasonNumber: g.season ?? rip.media.seasonNumber, kind: g.season ? 'series' : rip.media.kind, discNumber: g.disc ?? rip.media.discNumber };
      }
      await this.identify(rip);
      this.applyDefaultSelection(rip);
      await this.applyRexDb(rip);
      // now the series, season and episodes are known, which is what a set is matched on
      const key = driveKey({ name: rip.driveName, path: rip.drivePath });
      const want = this.awaiting.get(key);
      if (want && this.placeInAwaitedSlot(rip, want)) this.awaiting.delete(key);
      else this.offerBatch(rip);
      // the handle that actually opened the disc, so the rip that follows does not have to find it again
      rip.source = source;
      rip.status = 'ready';
    } catch (err) {
      if ((rip.status as RipStatus) === 'cancelled') return;
      const msg = (err as Error).message;
      // Two reasons a disc will not open on the first ask, both of which another attempt answers. The drive may not
      // be up to speed yet - a disc is noticed as soon as the drive reports a label, and reads fine seconds later -
      // or the handle used may be the one MakeMKV cannot resolve for this drive, where the other one can.
      const sources = this.sourcesFor(rip);
      const attempts = Math.max(2, sources.length);
      if (attempt + 1 < attempts && isOpenFailure(msg)) {
        const next = sources[Math.min(attempt + 1, sources.length - 1)];
        this.log(rip, `${msg} Giving the drive a moment and reading it again${next !== sources[Math.min(attempt, sources.length - 1)] ? ` as ${next}` : ''}…`);
        this.emit(rip);
        await new Promise((r) => setTimeout(r, 10_000));
        if ((rip.status as RipStatus) === 'cancelled') return;
        return this.scan(id, attempt + 1);
      }
      rip.status = 'failed';
      rip.error = msg;
      // A failed scan is finished with: without a time the poll below treats the disc as newly inserted on its next
      // pass and makes another entry for it, once every few seconds, for as long as the disc stays in the drive.
      rip.finishedAt = new Date().toISOString();
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
    let identified = false;
    if (store.settings.musicbrainz.enabled && cd.musicbrainz) {
      try {
        const found = await lookupDisc(toc);
        rip.cd.releases = found.releases;
        identified = found.exact && found.releases.length > 0;
        if (identified) this.log(rip, `MusicBrainz: ${found.releases.length} release(s) for this disc id`);
        else if (found.releases.length) this.log(rip, `MusicBrainz: no release has this disc id; ${found.releases.length} with similar track lengths, none of them confirmed`);
        else this.log(rip, 'MusicBrainz: no release for this disc id yet');
      } catch (err) {
        this.log(rip, `MusicBrainz lookup failed: ${(err as Error).message}`);
      }
    }
    // CDDB has track titles for plenty of discs MusicBrainz has never been told about. It is asked whenever the
    // disc id itself found nothing – a disc MusicBrainz only guessed at is still an unidentified disc.
    if (!identified && store.settings.cddb.enabled) {
      try {
        const found = await cddbLookup(toc);
        // a CDDB entry answers the disc id it was asked about, so it goes ahead of MusicBrainz's guesses
        rip.cd.releases = [...found, ...rip.cd.releases];
        identified = found.length > 0;
        this.log(rip, found.length ? `CDDB: ${found.length} matching entr${found.length === 1 ? 'y' : 'ies'} (${found[0].artist} – ${found[0].title})` : `CDDB: nothing for disc id ${cddbDiscId(toc)}`);
      } catch (err) {
        this.log(rip, `CDDB lookup failed: ${(err as Error).message}`);
      }
    }
    if (!identified) this.log(rip, `Nothing identifies this disc. Pick a release or search by title on the Discs page${rip.cd.releases.length ? ' – the suggestions are by track length only' : ''}, or rip with generic track names.`);
    // a guess is never applied on its own: with only fuzzy suggestions the disc stays unnamed until one is picked
    this.applyCdRelease(rip, rip.cd.releases.findIndex((r) => !r.fuzzy));
    const profile = store.getProfile(store.settings.defaultProfiles.music);
    if (profile && profile.audio.encoder !== 'copy') {
      rip.profileId = profile.id;
      rip.profileName = profile.name;
    }
    rip.status = 'ready';
    store.saveRips();
    this.emit(rip);
    if (store.settings.disc.autoRip && rip.cd.selected >= 0) void this.startRip(rip.id, {}).catch((err: Error) => this.log(rip, `Could not start: ${err.message}`));
    return true;
  }

  /** Use one of the MusicBrainz matches for titles and naming. */
  private applyCdRelease(rip: DiscRip, index: number) {
    const rel = index >= 0 ? rip.cd?.releases[index] : undefined;
    if (!rip.cd) return;
    rip.cd.selected = rel ? index : -1;
    if (!rel) {
      rip.media = { ...rip.media, kind: 'album', title: rip.media.title || rip.label || 'Unknown Album', artist: rip.media.artist ?? 'Unknown Artist' };
      return;
    }
    // the year of the album, not of this pressing: a 1994 remaster of a 1979 record still belongs to 1979
    const year = Number((rel.originalDate || rel.date || '').slice(0, 4)) || undefined;
    rip.media = { ...rip.media, kind: 'album', title: rel.title, artist: rel.artist, year, discNumber: rel.discCount > 1 ? rel.discNumber : undefined, poster: rel.coverUrl ? proxiedImage('lidarr', { remoteUrl: rel.coverUrl.replace('front-500', 'front-500.jpg') }, 'poster') : undefined };
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
      const rel = await getRelease(choice.releaseId, rip.cd.discId, rip.cd.tracks.length);
      rip.cd.releases = [rel, ...rip.cd.releases.filter((r) => r.releaseId !== rel.releaseId)];
      // chosen by hand from the title search, so it is applied whatever the disc id lookup thought
      this.applyCdRelease(rip, 0);
    } else this.applyCdRelease(rip, choice.index ?? -1);
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
    rip.outputDir = ensureRipFolder(path.join(this.ripRoot(), artist, album));
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
    const tags = cdTrackTags({ rel: rip.cd?.releases[rip.cd.selected], cd: rip.cd, media: rip.media, track, trackTotal });
    const args = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-i', raw];
    if (cover) args.push('-i', cover, '-map', '0:a', '-map', '1:v', '-disposition:v', 'attached_pic', '-metadata:s:v', 'comment=Cover (front)');
    else args.push('-map', '0:a');
    // Nothing of the ripped file's own tags is kept. FFmpeg reads TRACKNUMBER, DISCNUMBER and ALBUMARTIST under
    // its own names, so the ones written here land beside them rather than replacing them: a file that reached
    // this point already tagged came out with two TRACKNUMBERs, and players that read the first showed the
    // wrong track. MusicBrainz is the only source of what goes in.
    args.push('-map_metadata', '-1');
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
              // AniDB knowing it as anime does not mean Sonarr files it that way: a series Sonarr calls
              // "standard" is named S01E01 there, and naming the rip "Show - 033" would not match the library
              // or import. Sonarr's own series type is what decides it.
              const absolute = r.seriesType === 'anime';
              rip.media = { ...rip.media, kind: 'series', title: r.title, year: r.year, externalId: r.externalId, arrId: r.arrId, poster: r.poster, seriesType: (r.seriesType as RipMedia['seriesType']) ?? 'anime', seasonNumber: rip.media.seasonNumber ?? mp.defaultSeason ?? 1, episodeStart: rip.media.episodeStart ?? 1, absoluteNumbering: absolute };
              this.log(rip, `Identified via AniDB (${hit.entry.main}, aid ${mp.aid}) as anime series: ${r.title} (${r.year})${mp.episodeOffset ? `, TVDB episode offset ${mp.episodeOffset}` : ''} – Sonarr files it as ${r.seriesType ?? 'standard'}, so ${absolute ? 'absolute' : 'season'} numbering`);
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
    /**
     * OMDb, last. A TMDB or TVDB search wants something close to the catalogue title; OMDb is good at the other
     * end - a short, slightly wrong label - and what it hands back is the canonical title and an IMDb id. Those
     * go straight back to Radarr or Sonarr, which have the ids, the poster and the library status. When neither
     * is configured, or neither knows it, OMDb's own answer still names the disc, which beats not naming it.
     */
    const tryOmdb = async (): Promise<RipMedia | null> => {
      if (!omdbConfigured()) return null;
      // "Fate Zero Season 2" is a title plus a season; OMDb wants the title
      const base = sequel?.base ?? term;
      const season = sequel?.season ?? rip.media.seasonNumber;
      const hit = (await byTitle(base, { kind: preferSeries ? 'series' : undefined })) ?? (preferSeries ? await byTitle(base) : null);
      if (!hit) return null;
      const score = nameScore(base, hit.title);
      if (score < 0.6) {
        this.log(rip, `OMDb suggested "${hit.title}" for "${base}", which is too far off to use`);
        return null;
      }
      this.log(rip, `OMDb: "${base}" is ${hit.title} (${hit.year || '?'})${hit.imdbId ? `, ${hit.imdbId}` : ''}`);
      if (hit.kind === 'movie' && radarr.configured) {
        // an IMDb id is exact, which is the whole point of having asked
        const r = (await radarr.lookup(hit.imdbId ? `imdb:${hit.imdbId}` : hit.title))[0];
        if (r) return { kind: 'movie', title: r.title, year: r.year, externalId: r.externalId, arrId: r.arrId, poster: r.poster };
      }
      if (hit.kind === 'series' && sonarr.configured) {
        const r = bestOf(await sonarr.lookup(hit.title), hit.title);
        if (r && r.score >= 0.6) {
          return { kind: 'series', title: r.r.title, year: r.r.year, externalId: r.r.externalId, arrId: r.r.arrId, poster: r.r.poster, seriesType: r.r.seriesType as RipMedia['seriesType'], seasonNumber: season ?? 1, episodeStart: 1 };
        }
      }
      // no *arr app could place it: the name and year are still worth having on the rip
      return hit.kind === 'series'
        ? { kind: 'series', title: hit.title, year: hit.year || undefined, seasonNumber: season ?? 1, episodeStart: 1 }
        : { kind: 'movie', title: hit.title, year: hit.year || undefined };
    };

    try {
      const hit = (preferSeries ? (await trySeries()) ?? (await tryMovie()) : (await tryMovie()) ?? (await trySeries())) ?? (await tryOmdb());
      if (hit) {
        rip.media = { ...rip.media, ...hit };
        this.log(rip, `Identified as ${hit.kind}: ${hit.title} (${hit.year ?? '?'})${hit.arrId ? ' – already in library' : hit.externalId ? '' : ' – named by OMDb only, with no *arr match'}`);
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
    if (rip.titles.length) {
      this.applyDefaultSelection(rip);
      await this.applyRexDb(rip);
    }
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
      // Multi-disc sets: where this disc starts cannot be read off it, so it is worked out and flagged as a guess.
      if (rip.media.discNumber && rip.media.discNumber > 1 && (rip.media.episodeStart ?? 1) === 1) {
        rip.media.episodeStart = this.guessEpisodeStart(rip, episodes.length);
        rip.media.episodeStartGuessed = true;
      }
      rip.episodeMap = {};
      episodes.forEach((id, i) => (rip.episodeMap![id] = (rip.media.episodeStart ?? 1) + i));
      rip.selectedTitleIds = [...episodes, ...extraIds];
    } else {
      const longest = [...rip.titles].filter((t) => !t.short).sort((a, b) => b.durationSeconds - a.durationSeconds)[0] ?? rip.titles[0];
      rip.selectedTitleIds = [longest.id, ...extraIds.filter((id) => id !== longest.id)];
    }
    const mt = rip.media.kind === 'series' ? (rip.media.seriesType === 'anime' ? 'anime' : 'tv') : 'movie';
    // A profile picked when the release was grabbed wins over the defaults.
    const p = (rip.profileId && store.anyProfile(rip.profileId)) || store.anyProfile(store.settings.defaultProfiles[mt]);
    if (p) {
      rip.profileId = p.id;
      rip.profileName = p.name;
    }
  }

  /**
   * What RexDB already knows about this disc, which beats anything Rexarr can work out on its own.
   *
   * An exact fingerprint is the disc, and is applied. A structure that is only very close - a drive reporting a
   * duration a second out, or the label differently - is recorded as a suggestion and left for the person to
   * accept, because "very probably the same disc" is not the same as the disc. A disputed entry is never
   * applied however it matched: the point of disagreement is that somebody has to look.
   *
   * Nothing is sent anywhere by this. It reads one cached JSON file.
   */
  private async applyRexDb(rip: DiscRip) {
    if (rip.media.kind !== 'series' || !rip.titles.length) return;
    let match;
    try {
      match = await lookupInRexDb(rip);
    } catch (err) {
      this.log(rip, `RexDB could not be read: ${(err as Error).message}`);
      return;
    }
    if (!match) return;

    const { entry, how, confident } = match;
    const where = `${entry.disc_name}${entry.disc ? `, disc ${entry.disc}` : ''}`;
    const mapping = applyEntry(entry, rip.titles);
    if (!Object.keys(mapping.episodeMap).length && !Object.keys(mapping.titleRoles).length) return;

    if (how !== 'fingerprint' || entry.status === 'disputed') {
      rip.media.episodeSource = 'rexdb-suggested';
      rip.media.rexdb = { fingerprint: match.fingerprint, status: entry.status, confirmations: entry.confirmations, disc_name: entry.disc_name };
      this.log(
        rip,
        how === 'structure'
          ? `RexDB has a disc with the same titles and lengths ("${where}"): ${mapping.summary}. The label differs, so it is offered rather than applied.`
          : `RexDB's entry for "${where}" is disputed, so it is offered rather than applied: ${mapping.summary}.`,
      );
      return;
    }

    rip.episodeMap = { ...rip.episodeMap, ...mapping.episodeMap };
    rip.titleRoles = { ...rip.titleRoles, ...mapping.titleRoles };
    if (mapping.skip.length) rip.selectedTitleIds = rip.selectedTitleIds.filter((id) => !mapping.skip.includes(id));
    if (mapping.seasonNumber !== undefined) rip.media.seasonNumber = mapping.seasonNumber;
    if (mapping.episodeStart !== undefined) rip.media.episodeStart = mapping.episodeStart;
    rip.media.episodeStartGuessed = false;
    rip.media.episodeSource = 'rexdb';
    rip.media.rexdb = { fingerprint: match.fingerprint, status: entry.status, confirmations: entry.confirmations, disc_name: entry.disc_name };
    this.log(rip, `RexDB knows this disc ("${where}", ${entry.status}${entry.confirmations ? `, ${entry.confirmations} confirmations` : ''}): ${mapping.summary}`);
  }

  /**
   * Send this disc to RexDB, when it has been set to do that and there is something to send.
   *
   * Only a disc RexDB does not already agree about, and only when `contribute` is `auto` - on `ask` the Discs
   * page offers the same entry behind a button instead. Failing is not worth interrupting a rip over, so it is
   * logged and left.
   */
  private async contributeToRexDb(rip: DiscRip) {
    const settings = rexdbSettings();
    if (settings.contribute !== 'auto') return;
    // No submission service configured, so there is nowhere to post it. The Discs page offers the same disc
    // with a link to post it by hand, which is the whole answer - saying so again in the log every rip is not.
    if (!settings.submitUrl?.trim()) return;
    // Only a mapping somebody put right by hand. Rexarr's own arithmetic is what RexDB exists to replace, and
    // a database filling up with it would be worse than an empty one - CONTRIBUTING says as much to people.
    if (rip.media.episodeSource !== 'manual') return;
    const entry = buildEntry(rip);
    if (!entry) return;
    try {
      const known = await lookupInRexDb(rip);
      if (known?.how === 'fingerprint' && JSON.stringify(known.entry.titles ?? {}) === JSON.stringify((entry as { titles: unknown }).titles)) return;
      const sent = await submitEntry(entry);
      // The rip is unaffected either way, so a failure says so rather than reading like something broke.
      if (sent.ok) this.log(rip, `Sent this disc to RexDB${sent.url ? `: ${sent.url}` : ''}`);
      else this.log(rip, `This disc was not sent to RexDB (${sent.error}). The rip is unaffected; turn it off under Settings → Connections → RexDB if it is not wanted.`);
    } catch (err) {
      this.log(rip, `Could not send this disc to RexDB: ${(err as Error).message}`);
    }
    this.emit(rip);
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
    // Editing the episodes by hand is the correction RexDB exists to collect, so it is worth knowing it happened.
    if (patch.episodeMap || patch.titleRoles || patch.media?.episodeStart !== undefined) {
      rip.media.episodeSource = 'manual';
      rip.media.episodeStartGuessed = false;
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
      const p = store.anyProfile(patch.profileId);
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
    // Starting a rip is the moment the mapping is settled, so it is when a correction is worth sharing.
    void this.contributeToRexDb(rip);
    if (rip.discType === 'cd') return this.startCdRip(rip);
    if (rip.options.transcode && !rip.profileId) throw new Error('Pick an encoding profile or disable transcoding');
    // Not in Sonarr / Radarr yet: add it now, so it is there (with its episode list) by the time the rip is imported
    if (store.settings.disc.addMissing !== false && rip.options.deliver && !rip.media.arrId && rip.media.externalId && (rip.media.kind === 'series' || rip.media.kind === 'movie')) {
      try {
        await this.addToLibrary(rip);
      } catch (err) {
        this.log(rip, `Could not add ${rip.media.title} yet: ${(err as Error).message} – trying again at import`);
      }
    }
    rip.status = 'ripping';
    rip.error = undefined;
    rip.files = [];
    rip.startedAt = new Date().toISOString();
    rip.finishedAt = undefined;
    const base = rip.media.title ? `${safeName(rip.media.title)}${rip.media.year ? ` (${rip.media.year})` : ''}` : safeName(rip.label || `disc-${rip.id.slice(0, 8)}`);
    // Multi-disc sets get a folder per disc, so one disc's import never picks up another disc's half-finished files.
    const folder = rip.media.discNumber ? `${base} - Disc ${rip.media.discNumber}` : base;
    // Raw rips and encodes stay in the local cache, where Sonarr / Radarr cannot see them; only finished files are
    // moved to the rip folder they import from.
    rip.outputDir = path.join(PATHS.rips, folder);
    rip.deliveryDir = path.join(this.ripRoot(), folder);
    ensureRipFolder(rip.outputDir!);
    // the files are moved there at the end; finding out then that it cannot be written is an hour too late
    ensureRipFolder(this.ripRoot());
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
        const onProgress = (pct: number, step: string) => {
          rip.progress.percent = pct;
          rip.progress.step = step;
          rip.progress.etaSeconds = ripEta(rip, i, pct);
          if (Date.now() - lastEmit > 1000) {
            lastEmit = Date.now();
            this.emit(rip);
          }
        };
        const source = this.sourceFor(rip);
        const minSeconds = rip.scanMinSeconds ?? store.settings.disc.minTitleSeconds;
        const agent = this.agentFor(rip);
        // The agent writes into the same shared folder the server reads from, so only the command travels.
        const attempt = async (): Promise<{ code: number | null; said: string[] }> => {
          const said: string[] = [];
          const note = (line: string) => {
            said.push(line);
            this.log(rip, line);
          };
          const handle = agent
            ? (() => {
                this.log(rip, `Ripping title ${t.id} on agent "${agent.name}"`);
                const h = runOnAgent({
                  agentId: agent.id,
                  agentName: agent.name,
                  kind: 'rip',
                  ownerId: rip.id,
                  label: `${rip.label || source} title ${t.id}`,
                  program: 'makemkvcon',
                  args: ripArgs(source, t.id, work, minSeconds),
                  onProgress: (p) => onProgress(p.percent, rip.progress.step),
                  onLog: note,
                });
                return { process: undefined as never, done: h.done.then((r) => r.code), cancel: h.cancel };
              })()
            : ripTitle(this.makemkv(), source, t.id, work, minSeconds, onProgress, note);
          this.running.set(rip.id, handle);
          const code = await handle.done;
          this.running.delete(rip.id);
          return { code, said };
        };
        let { code, said } = await attempt();
        if ((rip.status as RipStatus) === 'cancelled') return;
        // macOS can remount a disc between the check above and MakeMKV opening it, which drops MakeMKV to OS
        // access mode and it then cannot open the disc at all. Unmounting again and asking once more is the
        // same answer the scan gives, and the disc is right there in the drive either way.
        if (code !== 0 && said.some((l) => /Failed to open disc/i.test(l)) && !rip.virtual && rip.drivePath) {
          const again = await unmountForDirectAccess(rip.drivePath).catch(() => null);
          this.log(rip, `${again ?? 'The disc would not open'} – reading title ${t.id} again`);
          await new Promise((r) => setTimeout(r, 5000));
          if ((rip.status as RipStatus) === 'cancelled') return;
          fs.rmSync(work, { recursive: true, force: true });
          fs.mkdirSync(work, { recursive: true });
          ({ code, said } = await attempt());
          if ((rip.status as RipStatus) === 'cancelled') return;
        }
        if (code !== 0) {
          // MakeMKV's own reason beats an exit code: "code 11" says nothing a user can act on
          const why = said.some((l) => /Failed to open disc/i.test(l)) ? ` – ${openFailureReason(said, source)}` : '';
          throw new Error(`makemkvcon exited with code ${code} on title ${t.id}${why}`);
        }
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
        for (const f of rip.files) {
          f.finalPath = f.path;
          await this.moveToDelivery(rip, f);
        }
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
    // no output path means nothing was encoded – a smart profile decided to keep the rip as it is
    file.finalPath = job.outputPath ?? file.path;
    this.log(rip, job.outputPath ? `Transcode finished: ${path.basename(file.finalPath)}` : `Kept as ripped: ${path.basename(file.finalPath)}`);
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
    try {
      await this.moveToDelivery(rip, file);
    } catch (err) {
      return this.fail(rip, `Could not move ${path.basename(file.finalPath)} to the rip folder: ${(err as Error).message}`);
    }
    store.saveRips();
    this.emit(rip);
    // every file encoded and in the rip folder (two encodes can finish together: only one of them delivers)
    if (rip.status === 'transcoding' && rip.files.every((f) => f.finalPath && (!rip.deliveryDir || path.dirname(f.finalPath) === rip.deliveryDir))) await this.deliver(rip);
  }

  /**
   * Put a finished file into the rip folder. Across volumes (local cache → NAS) it is copied under a hidden temporary
   * name and renamed when complete, so Sonarr / Radarr never see a half-copied file.
   */
  private async moveToDelivery(rip: DiscRip, file: DiscRip['files'][number]) {
    const from = file.finalPath ?? file.path;
    if (!rip.deliveryDir || path.dirname(from) === rip.deliveryDir || !fs.existsSync(from)) return;
    await fs.promises.mkdir(rip.deliveryDir, { recursive: true });
    const name = path.basename(from);
    const to = path.join(rip.deliveryDir, name);
    try {
      await fs.promises.rename(from, to);
    } catch {
      const part = path.join(rip.deliveryDir, `.${name}.part`);
      await fs.promises.copyFile(from, part);
      await fs.promises.rename(part, to);
      await fs.promises.unlink(from);
    }
    file.finalPath = to;
    this.log(rip, `Moved ${name} to ${rip.deliveryDir}`);
    // the work folder is done with once nothing is left in it
    try {
      if (rip.outputDir && rip.outputDir !== rip.deliveryDir && !rip.options.keepRaw && !(await fs.promises.readdir(rip.outputDir)).some((f) => !f.startsWith('.'))) await fs.promises.rm(rip.outputDir, { recursive: true, force: true });
    } catch {
      /* cleaned up later */
    }
  }

  /**
   * Add the disc's show or movie to Sonarr / Radarr: into the root folder and quality profile the library uses for that
   * kind of title (or the ones set in Settings), unmonitored unless Settings say otherwise, so adding a show to import
   * one disc never starts downloading the rest of it.
   */
  /**
   * Add a title to Sonarr / Radarr where the library already keeps that kind of thing, unmonitored unless asked.
   * Used by a rip that starts before its show exists, and by the barcode scanner.
   */
  async addMediaToLibrary(media: RipMedia, log: (line: string) => void): Promise<number | undefined> {
    if (media.arrId || !media.externalId) return media.arrId;
    const { radarr, sonarr } = arr();
    const d = store.settings.disc;
    // anime: AniDB knows nearly every anime by its TVDB / TMDB id, even when TVDB calls the show "standard"
    let anime = media.seriesType === 'anime';
    if (!anime && anidb.enabled) {
      await anidb.ensure().catch(() => undefined);
      anime = media.kind === 'series' ? anidb.forTvdb(media.externalId).length > 0 : Boolean(anidb.forTmdb(media.externalId));
    }
    const monitored = d.addMonitored === true;
    if (media.kind === 'series') {
      if (!sonarr.configured) throw new Error('Sonarr is not connected');
      const [roots, profiles, series] = await Promise.all([sonarr.rootFolders(), sonarr.qualityProfiles(), sonarr.http.get<{ path: string; seriesType: string; qualityProfileId: number }[]>('/series')]);
      const target = pickAddTarget({
        anime,
        roots: roots.map((r) => r.path),
        profiles,
        library: series.map((s) => ({ path: s.path, animeType: s.seriesType === 'anime', profileId: s.qualityProfileId })),
        exclude: [toArrPath(this.ripRoot(), 'sonarr')],
        ...d.addTargets?.[anime ? 'anime' : 'series'],
      });
      if (!target) throw new Error('Sonarr has no root folder or quality profile');
      const s = await sonarr.add(media.externalId, anime ? 'anime' : (media.seriesType ?? 'standard'), target.qualityProfileId, target.rootFolderPath, monitored);
      media.arrId = s.id;
      const profile = profiles.find((p) => p.id === target.qualityProfileId)?.name;
      log(`Added ${s.title} to Sonarr: ${target.rootFolderPath}, ${profile} (${target.why})${monitored ? '' : ', not monitored – nothing is downloaded'}`);
    } else if (media.kind === 'movie') {
      if (!radarr.configured) throw new Error('Radarr is not connected');
      const [roots, profiles, movies] = await Promise.all([radarr.rootFolders(), radarr.qualityProfiles(), radarr.http.get<{ path: string; qualityProfileId: number }[]>('/movie')]);
      const target = pickAddTarget({
        anime,
        roots: roots.map((r) => r.path),
        profiles,
        library: movies.map((m) => ({ path: m.path, profileId: m.qualityProfileId })),
        exclude: [toArrPath(this.ripRoot(), 'radarr')],
        ...d.addTargets?.[anime ? 'animeMovie' : 'movie'],
      });
      if (!target) throw new Error('Radarr has no root folder or quality profile');
      const m = await radarr.add(media.externalId, target.qualityProfileId, target.rootFolderPath, monitored);
      media.arrId = m.id;
      const profile = profiles.find((p) => p.id === target.qualityProfileId)?.name;
      log(`Added ${m.title} to Radarr: ${target.rootFolderPath}, ${profile} (${target.why})${monitored ? '' : ', not monitored – nothing is downloaded'}`);
    }
    return media.arrId;
  }
  async addToLibrary(rip: DiscRip): Promise<void> {
    await this.addMediaToLibrary(rip.media, (line) => this.log(rip, line));
    store.saveRips();
    this.emit(rip);
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
    const { radarr, sonarr } = arr();
    if (!sonarr.configured && !radarr.configured) throw new Error('Sonarr and Radarr are not connected');
    const root = this.ripRoot();
    if (!fs.existsSync(root)) return [];
    const busy = new Set(store.rips.filter((r) => ['ripping', 'transcoding', 'delivering'].includes(r.status)).flatMap((r) => [r.outputDir, r.deliveryDir].filter((d): d is string => Boolean(d)).map((d) => path.resolve(d))));
    const results: { folder: string; outcomes: ImportOutcome[] }[] = [];
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const dir = path.join(root, e.name);
      if (busy.has(path.resolve(dir)) || !folderIsSettled(dir)) continue;
      // the rip that made this folder knows the series and episodes; without one, Sonarr matches each file itself
      const rip = store.rips.find((r) => (r.deliveryDir ?? r.outputDir) && path.resolve((r.deliveryDir ?? r.outputDir)!) === path.resolve(dir) && r.media.arrId);
      try {
        const { radarr } = arr();
        const movie = rip?.media.kind === 'movie';
        if (movie && !radarr.configured) continue;
        const outcomes = movie
          ? await importIntoRadarr(radarr, dir, { movieId: rip!.media.arrId, dvd: rip!.discType === 'dvd' })
          : await importIntoSonarr(sonarr, dir, rip?.media.kind === 'series' ? { seriesId: rip.media.arrId, known: this.knownEpisodes(rip), dvd: rip.discType === 'dvd' } : {});
        if (!outcomes.length) {
          this.tidyRipFolder(dir);
          continue;
        }
        results.push({ folder: e.name, outcomes });
        if (rip) {
          this.reportImport(rip, outcomes);
          // a rip that failed because nothing could be imported is done once its files are in
          if (rip.status === 'failed' && outcomes.length && outcomes.every((o) => o.imported)) {
            rip.status = 'done';
            rip.error = undefined;
            rip.finishedAt = new Date().toISOString();
            this.log(rip, 'Imported after all; the rip is complete');
            store.saveRips();
            this.emit(rip);
          }
        }
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
    if (!target || !fs.existsSync(path.dirname(target))) target = path.join(rip.deliveryDir ?? rip.outputDir!, 'Extras');
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
        const dir = rip.deliveryDir ?? rip.outputDir!;
        await this.deliverExtras(rip);
        const movie = rip.media.kind === 'movie';
        const client = movie ? radarr : sonarr;
        if ((movie && radarr.configured) || (rip.media.kind === 'series' && sonarr.configured)) {
          if (!rip.media.arrId) await this.addToLibrary(rip);
          const app = movie ? 'Radarr' : 'Sonarr';
          const remote = toArrPath(dir, movie ? 'radarr' : 'sonarr');
          // A path mapping that points somewhere the app does not have makes every import do nothing, while the
          // app's scan command still reports success.
          if (!(await canSeeFolder(client, remote))) {
            return this.fail(rip, `${app} cannot see ${remote}${remote === dir ? '' : ` (this computer: ${dir})`} – fix the rip directory or its path mapping. The files are there and can be imported from Settings → Disc ripping.`);
          }
          // explicit series / movie: a folder scan would guess it from "Title (Year) - Disc 1" and skip it
          const outcomes = movie
            ? await importIntoRadarr(radarr, dir, { movieId: rip.media.arrId, dvd: rip.discType === 'dvd', log: (l) => this.log(rip, l) })
            : await importIntoSonarr(sonarr, dir, { seriesId: rip.media.arrId, known: this.knownEpisodes(rip), dvd: rip.discType === 'dvd', log: (l) => this.log(rip, l) });
          this.reportImport(rip, outcomes);
          const problem = deliveryProblem(app, dir, remote, outcomes);
          if (problem) return this.fail(rip, problem);
        } else this.log(rip, 'No matching *arr app configured; files left in the rip folder');
      } else this.log(rip, `Files left in ${rip.deliveryDir ?? rip.outputDir}`);
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
