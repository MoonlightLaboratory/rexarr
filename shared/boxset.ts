/**
 * Box sets: the discs of one season gathered under a parent item, so a four-disc set reads as one thing in the
 * queue instead of four unrelated discs that happen to share a name.
 *
 * A set is only ever its discs. There is no list of sets kept anywhere - every member carries the set's id and
 * name - so a set appears with its second disc, goes when its discs go, and leaves nothing empty behind.
 */
import type { DiscRip, RipMedia } from './types.js';

/** A disc's state as a box set reports it, which is coarser than the rip's own. */
export type DiscPhase = 'waiting' | 'ripping' | 'remuxing' | 'done' | 'failed' | 'cancelled';

export function discPhase(status: DiscRip['status']): DiscPhase {
  switch (status) {
    case 'ripping':
      return 'ripping';
    case 'transcoding':
    case 'delivering':
      return 'remuxing';
    case 'done':
      return 'done';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      // inserted, scanning, ready: nothing is being written yet
      return 'waiting';
  }
}

/** Titles, loosely compared: a title read off a label and one from the library differ in punctuation before words. */
function key(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Are these two discs the same season of the same series?
 *
 * The library id settles it when both discs have one. Before identification there is only the title read off the
 * label, which is worth comparing but not worth trusting over the ids: two discs Sonarr knows to be different
 * series are different series whatever their labels say.
 */
export function sameSet(a: RipMedia, b: RipMedia): boolean {
  if (a.kind !== 'series' || b.kind !== 'series') return false;
  if ((a.seasonNumber ?? 1) !== (b.seasonNumber ?? 1)) return false;
  if (a.arrId !== undefined && b.arrId !== undefined) return a.arrId === b.arrId;
  const ka = key(a.title);
  return Boolean(ka) && ka === key(b.title);
}

/** What a set of these discs is called. */
export function boxSetName(media: RipMedia): string {
  const season = media.seasonNumber;
  if (season === undefined) return `${media.title} box set`;
  if (season === 0) return `${media.title} - Specials box set`;
  return `${media.title} - Season ${season} box set`;
}

/** The episode numbers this disc holds, in order. */
export function episodeNumbers(rip: DiscRip): number[] {
  const map = rip.episodeMap ?? {};
  const ids = Object.keys(map).map(Number);
  // a title since unselected is not part of the disc's running order any more
  const selected = rip.selectedTitleIds?.length ? ids.filter((id) => rip.selectedTitleIds.includes(id)) : ids;
  return [...new Set(selected.map((id) => map[id]).filter((n) => Number.isFinite(n)))].sort((x, y) => x - y);
}

/** The first and last episode on the disc, or nothing while its episodes are still unknown. */
export function episodeRange(rip: DiscRip): { from: number; to: number } | null {
  const eps = episodeNumbers(rip);
  if (!eps.length) return null;
  return { from: eps[0], to: eps[eps.length - 1] };
}

/**
 * How far through its own titles a disc is.
 *
 * A disc's raw percent is per title, so a five-title disc reads 100% when the first one is written and drops back
 * to nothing when the second starts. The title it is on is what turns that into a figure for the disc.
 */
function discPercent(p: DiscRip['progress'] | undefined): number {
  if (!p) return 0;
  const pct = Number.isFinite(p.percent) ? p.percent : 0;
  if (!p.titleCount || p.titleCount <= 1 || p.titleIndex < 1) return pct;
  return Math.min(100, ((p.titleIndex - 1 + pct / 100) / p.titleCount) * 100);
}

/** How far through a whole set is, counting every disc equally. */
export function batchProgress(rips: DiscRip[]): { percent: number; done: number; total: number } {
  const total = rips.length;
  if (!total) return { percent: 0, done: 0, total: 0 };
  const done = rips.filter((r) => discPhase(r.status) === 'done').length;
  const each = rips.map((r) => {
    const phase = discPhase(r.status);
    if (phase === 'done') return 100;
    // a disc that has not started, or that stopped without finishing, has written nothing towards the set
    if (phase === 'waiting' || phase === 'cancelled' || phase === 'failed') return 0;
    return Math.max(0, Math.min(100, discPercent(r.progress)));
  });
  return { percent: Math.round(each.reduce((a, b) => a + b, 0) / total), done, total };
}

/** The discs of a set in disc order, with any that have no number last so none of them is hidden. */
export function sortDiscs(rips: DiscRip[]): DiscRip[] {
  return [...rips].sort((a, b) => {
    const da = a.media.discNumber ?? Number.MAX_SAFE_INTEGER;
    const db = b.media.discNumber ?? Number.MAX_SAFE_INTEGER;
    if (da !== db) return da - db;
    return (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
  });
}

/**
 * Is this disc's copy finished, so the disc itself can come out?
 *
 * The rip is the only part that needs the disc. Remuxing reads the copy on disk, so holding the tray shut until
 * the encode finishes would keep a drive idle for the length of a transcode for no reason at all.
 */
export function discFreed(rip: DiscRip): boolean {
  return rip.status === 'transcoding' || rip.status === 'delivering' || rip.status === 'done';
}

/** Is the drive still reading, so nothing should be taken out of it? */
export function driveBusy(rip: DiscRip | undefined): boolean {
  return Boolean(rip) && ['inserted', 'scanning', 'ripping'].includes(rip!.status);
}

/**
 * How many discs a set holds, when nothing has said outright.
 *
 * A disc does not know how many came with it, so this is arithmetic on what is known: the season's episode count
 * divided by what a disc of this set actually holds. It is a guess, shown as one, and a pinned count beats it.
 */
export function expectedDiscCount(rips: DiscRip[], seasonEpisodes: number): number | undefined {
  const pinned = rips.find((r) => r.batch?.discsPinned && r.batch.expectedDiscs);
  if (pinned) return pinned.batch!.expectedDiscs;
  const highest = Math.max(0, ...rips.map((r) => r.media.discNumber ?? 0));
  const counts = rips.map((r) => episodeNumbers(r).length).filter((n) => n > 0);
  if (!seasonEpisodes || !counts.length) return highest || undefined;
  const perDisc = counts.reduce((a, b) => a + b, 0) / counts.length;
  if (perDisc <= 0) return highest || undefined;
  // never fewer than the discs already here, and not a number so large it is obviously the wrong season
  return Math.min(60, Math.max(highest, Math.ceil(seasonEpisodes / perDisc)));
}

/** The disc numbers of a set that have not turned up yet. */
export function missingDiscs(rips: DiscRip[], expected: number | undefined): number[] {
  if (!expected || expected < 1) return [];
  const have = new Set(rips.map((r) => r.media.discNumber).filter((n): n is number => typeof n === 'number'));
  const out: number[] = [];
  for (let n = 1; n <= expected; n++) if (!have.has(n)) out.push(n);
  return out;
}

/** The next disc of the set to ask for, ignoring any a drive is already waiting for. */
export function nextWantedDisc(rips: DiscRip[], expected: number | undefined, claimed: number[] = []): number | undefined {
  const missing = missingDiscs(rips, expected).filter((n) => !claimed.includes(n));
  if (missing.length) return missing[0];
  // past the end of what was expected, the next disc is simply the one after the highest here or claimed
  const highest = Math.max(0, ...rips.map((r) => r.media.discNumber ?? 0), ...claimed);
  return highest > 0 ? highest + 1 : undefined;
}
