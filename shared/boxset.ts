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
    return Math.max(0, Math.min(100, r.progress?.percent ?? 0));
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
