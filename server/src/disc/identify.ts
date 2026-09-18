/**
 * Matching a disc label ("SNAFU_2_DISC_1" → "Snafu 2") to a movie or series. Labels are short and often use a
 * nickname, so the library is searched first – with alternate titles and Sonarr's season-specific titles – and a
 * trailing number or "Season 2" / "II" / "2nd Season" is tried as a season of a series. Search results are scored
 * instead of trusting the first hit.
 */

const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'wa', 'no', 'ga', 'wo', 'to', 'disc', 'disk', 'dvd', 'bd', 'bluray']);

export function tokens(s: string): string[] {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !STOP.has(t));
}

/**
 * How well a disc title matches a name, 0–1: every word of the disc title should appear in the name (a label is
 * usually a shortened title), with a small penalty for names that are much longer.
 */
export function nameScore(term: string, name: string): number {
  const a = tokens(term);
  const b = tokens(name);
  if (!a.length || !b.length) return 0;
  if (a.join(' ') === b.join(' ')) return 1;
  // shortened words ("Oregairu" / "Oregairu S2") count, but only between real words: "snafu" must not match the
  // "s" left over from "World's"
  const found = a.filter((t) => b.includes(t) || (t.length >= 5 && b.some((x) => x.length >= 5 && (x.startsWith(t) || t.startsWith(x))))).length;
  const coverage = found / a.length;
  if (coverage < 1 && a.length === 1) return 0;
  const precision = Math.min(1, a.length / b.length);
  return Math.round((coverage * (0.75 + 0.25 * precision)) * 1000) / 1000;
}

const ROMAN: Record<string, number> = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6 };
const ORDINAL: Record<string, number> = { second: 2, third: 3, fourth: 4, fifth: 5, '2nd': 2, '3rd': 3, '4th': 4, '5th': 5 };

/** "Snafu 2" → { base: "Snafu", season: 2 }; "Fate Zero Season 2", "Title II", "Title 2nd Season", "Title S2" likewise. */
export function splitSequel(term: string): { base: string; season: number } | null {
  const t = term.trim();
  const patterns: [RegExp, (m: RegExpMatchArray) => number | undefined][] = [
    [/^(.*\S)\s+(?:season|series|s)\s*(\d{1,2})$/i, (m) => Number(m[2])],
    [/^(.*\S)\s+(\d{1,2})(?:st|nd|rd|th)?\s+season$/i, (m) => Number(m[2])],
    [/^(.*\S)\s+(second|third|fourth|fifth|2nd|3rd|4th|5th)\s+season$/i, (m) => ORDINAL[m[2].toLowerCase()]],
    [/^(.*\S)\s+(ii|iii|iv|v|vi)$/i, (m) => ROMAN[m[2].toLowerCase()]],
    [/^(.*\D)\s+(\d{1,2})$/, (m) => Number(m[2])],
  ];
  for (const [re, num] of patterns) {
    const m = t.match(re);
    const season = m && num(m);
    if (m && season && season >= 2 && season <= 30) return { base: m[1].trim(), season };
  }
  return null;
}

export interface LibraryCandidate {
  kind: 'movie' | 'series';
  id: number;
  /** TVDB id for series, TMDB id for movies. */
  externalId?: number;
  title: string;
  year?: number;
  alternateTitles?: string[];
  seasonTitles?: { title: string; seasonNumber: number }[];
  /** Season numbers the series has (series only). */
  seasons?: number[];
}

export interface LibraryMatch {
  item: LibraryCandidate;
  score: number;
  season?: number;
  /** What matched, for the log. */
  via: string;
}

/** Best library entry for a disc title, or null when nothing matches well enough. */
export function matchLibrary(term: string, items: LibraryCandidate[], opts: { preferSeries?: boolean } = {}): LibraryMatch | null {
  let best: LibraryMatch | null = null;
  const consider = (m: LibraryMatch) => {
    // ties go to the preferred kind, then to the shorter (closer) title
    if (!best || m.score > best.score + 1e-9 || (Math.abs(m.score - best.score) < 1e-9 && opts.preferSeries && m.item.kind === 'series' && best.item.kind !== 'series')) best = m;
  };
  const sequel = splitSequel(term);
  for (const item of items) {
    // 1. the whole disc title, e.g. "Toy Story 2" in Radarr
    for (const name of [item.title, ...(item.alternateTitles ?? [])]) {
      const score = nameScore(term, name);
      if (score > 0) consider({ item, score, via: name });
    }
    if (item.kind !== 'series') continue;
    // 2. a title Sonarr ties to one season ("… Zoku", "… Too!")
    for (const st of item.seasonTitles ?? []) {
      const score = nameScore(term, st.title);
      if (score > 0) consider({ item, score: score + 0.01, season: st.seasonNumber, via: st.title });
    }
    // 3. "Snafu 2" → season 2 of "My Teen Romantic Comedy SNAFU", when that season exists
    if (sequel && (!item.seasons || item.seasons.includes(sequel.season))) {
      for (const name of [item.title, ...(item.alternateTitles ?? [])]) {
        const score = nameScore(sequel.base, name);
        if (score > 0) consider({ item, score: score - 0.02, season: sequel.season, via: `${name}, season ${sequel.season}` });
      }
    }
  }
  const found = best as LibraryMatch | null;
  return found && found.score >= 0.7 ? found : null;
}
