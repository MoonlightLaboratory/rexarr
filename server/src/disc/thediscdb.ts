/**
 * TheDiscDB as the source of which title is which episode.
 *
 * Its data repo holds, for every disc someone has scanned, a summary that says what each title on that disc is:
 *
 *     Source file name: 00800.mpls
 *     Segment map: 1065
 *     Type: Episode
 *     Season: 1
 *     Episode: 1
 *
 * which is exactly the question Rexarr otherwise answers by assuming the titles are in episode order. It is
 * keyed by playlist, and so is Rexarr's own title key, so the two line up without translation.
 *
 * The disc in the drive is matched to one of theirs by its shape - the playlists it holds and how long each one
 * runs - rather than by its label, because a label is a marketing string and the same disc carries different
 * ones in different regions. A disc whose shape does not match is not a disc we know about, and saying nothing
 * is the right answer: a mapping from the wrong disc numbers the episodes wrongly, which is worse than a guess
 * the user was told was a guess.
 *
 * Nothing is sent anywhere. This reads public files from the data repo and caches them.
 */
import { THEDISCDB_SITE } from '../../../shared/types.js';
import type { DiscTitle } from '../../../shared/types.js';
import { titleKey } from './rexdb.js';

const RAW = 'https://raw.githubusercontent.com/TheDiscDb/data/main';
const API = 'https://api.github.com/repos/TheDiscDb/data';

/** One title, as TheDiscDB's disc summary describes it. */
export interface SummaryTitle {
  name: string;
  /** The playlist or VOB the title comes from: "00800.mpls". This is what it is matched on. */
  sourceFile: string;
  segmentMap?: string;
  durationSeconds: number;
  /** "Episode", "Extra", "MainMovie", "Trailer"… */
  type: string;
  season?: number;
  episode?: number;
}

/** "1:06:55" and "0:43:31" – hours are not padded. */
export function parseDuration(text: string): number {
  const parts = text.trim().split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((total, n) => total * 60 + n, 0);
}

/**
 * A disc summary, which is blocks of `Key: value` separated by blank lines.
 *
 * Anything without a source file is skipped: without one there is nothing to match a title to, and a summary
 * that has drifted from its disc is better ignored than guessed at.
 */
export function parseSummary(text: string): SummaryTitle[] {
  const out: SummaryTitle[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const field = (name: string): string | undefined => new RegExp(`^${name}:\\s*(.+)$`, 'im').exec(block)?.[1]?.trim();
    const sourceFile = field('Source file name');
    if (!sourceFile) continue;
    const season = field('Season');
    const episode = field('Episode');
    out.push({
      name: field('Name') ?? '',
      sourceFile,
      segmentMap: field('Segment map'),
      durationSeconds: parseDuration(field('Duration') ?? ''),
      type: field('Type') ?? '',
      season: season !== undefined && /^\d+$/.test(season) ? Number(season) : undefined,
      episode: episode !== undefined && /^\d+$/.test(episode) ? Number(episode) : undefined,
    });
  }
  return out;
}

/**
 * Is the disc in the drive the disc this summary describes?
 *
 * Playlists alone are not enough - two discs of one season are pressed from the same template and reuse the
 * numbers - so the duration has to agree too. A few seconds of slack covers MakeMKV rounding and the odd
 * re-authoring; anything looser starts matching disc 2 to disc 3.
 */
export function discMatches(ours: DiscTitle[], theirs: SummaryTitle[], toleranceSeconds = 5): boolean {
  const mine = new Map(ours.filter((t) => !t.short).map((t) => [titleKey(t), Math.trunc(t.durationSeconds)]));
  const named = theirs.filter((t) => t.durationSeconds > 0);
  if (mine.size < 2 || named.length < 2) return false;
  let hit = 0;
  for (const t of named) {
    const seconds = mine.get(t.sourceFile.toLowerCase());
    if (seconds !== undefined && Math.abs(seconds - t.durationSeconds) <= toleranceSeconds) hit++;
  }
  // most of what they describe has to be here, and most of what is here has to be described
  return hit / named.length >= 0.8 && hit / mine.size >= 0.8;
}

/**
 * The summary as the title map Rexarr already knows how to apply, so TheDiscDB and RexDB end up in one code
 * path rather than two that drift apart.
 */
export function summaryToTitles(summary: SummaryTitle[]): Record<string, string> {
  const titles: Record<string, string> = {};
  for (const t of summary) {
    const key = t.sourceFile.toLowerCase();
    if (/episode/i.test(t.type) && t.season !== undefined && t.episode !== undefined) {
      titles[key] = `S${String(t.season).padStart(2, '0')}E${String(t.episode).padStart(2, '0')}`;
    } else if (/trailer/i.test(t.type)) titles[key] = 'extra:trailer';
    else if (/featurette|behind/i.test(t.type)) titles[key] = 'extra:featurette';
    else if (/interview/i.test(t.type)) titles[key] = 'extra:interview';
    else if (/extra|bonus|deleted|promo/i.test(t.type)) titles[key] = 'extra';
  }
  return titles;
}

/** The folder a series lives in: "Breaking Bad (2008)". */
export function seriesFolder(title: string, year?: number): string {
  return year ? `${title} (${year})` : title;
}

// ---- reading the repo ----------------------------------------------------------------------------

const cache = new Map<string, { at: number; value: unknown }>();
const TTL = 6 * 3600_000;

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 300) cache.delete(cache.keys().next().value as string);
  return value;
}

async function json<T>(url: string): Promise<T | null> {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
  return res?.ok ? ((await res.json().catch(() => null)) as T | null) : null;
}

async function text(url: string): Promise<string | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
  return res?.ok ? await res.text().catch(() => null) : null;
}

/** The releases TheDiscDB has for a series, as folder names. */
export async function releasesFor(folder: string): Promise<string[]> {
  return cached(`releases:${folder}`, async () => {
    const body = await json<{ name: string; type: string }[]>(`${API}/contents/${encodeURI(`data/series/${folder}`)}`);
    return Array.isArray(body) ? body.filter((e) => e.type === 'dir').map((e) => e.name) : [];
  });
}

/** Every disc summary in a release, in disc order. */
export async function discSummaries(folder: string, release: string): Promise<{ disc: string; titles: SummaryTitle[] }[]> {
  return cached(`discs:${folder}/${release}`, async () => {
    const body = await json<{ name: string; type: string }[]>(`${API}/contents/${encodeURI(`data/series/${folder}/${release}`)}`);
    const names = (Array.isArray(body) ? body : []).filter((e) => e.type === 'file' && /-summary\.txt$/i.test(e.name)).map((e) => e.name).sort();
    const out: { disc: string; titles: SummaryTitle[] }[] = [];
    for (const name of names) {
      const body2 = await text(`${RAW}/${encodeURI(`data/series/${folder}/${release}/${name}`)}`);
      if (body2) out.push({ disc: name.replace(/-summary\.txt$/i, ''), titles: parseSummary(body2) });
    }
    return out;
  });
}

export interface DiscDbDiscMatch {
  folder: string;
  release: string;
  disc: string;
  titles: Record<string, string>;
  summary: SummaryTitle[];
  url: string;
}

/**
 * The disc in the drive, found in TheDiscDB by its shape.
 *
 * Every release of the series is looked through, because the same season comes as a season set, a complete
 * series box and a steelbook, and which of those is in the drive is not something the label reliably says.
 */
export async function lookupDisc(series: { title: string; year?: number }, ours: DiscTitle[]): Promise<DiscDbDiscMatch | null> {
  if (!series.title.trim() || ours.length < 2) return null;
  const folder = seriesFolder(series.title.trim(), series.year);
  const releases = await releasesFor(folder);
  for (const release of releases) {
    for (const disc of await discSummaries(folder, release)) {
      if (!discMatches(ours, disc.titles)) continue;
      const titles = summaryToTitles(disc.titles);
      if (!Object.keys(titles).length) continue;
      return { folder, release, disc: disc.disc, titles, summary: disc.titles, url: `${THEDISCDB_SITE}/series/${slugify(folder)}` };
    }
  }
  return null;
}

/** "Breaking Bad (2008)" → "breaking-bad-2008", the shape the site's own URLs use. */
export function slugify(folder: string): string {
  return folder
    .toLowerCase()
    .replace(/[()]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
