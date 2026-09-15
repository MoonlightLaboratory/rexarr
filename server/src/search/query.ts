/**
 * Smart search query parsing: pull ids, year, season / episode and release wishes out of free text, e.g.
 *   "Blade Runner 2049 2160p remux"   → title "Blade Runner 2049", resolution 2160, category remux
 *   "frieren s01e05"                   → title "frieren", series, season 1, episode 5
 *   "Umaru-chan season 2 bluray"       → title "Umaru-chan", series, season 2, category bluray
 *   "tt1856101" / "tmdb:335984"        → id lookup
 */
import type { ReleaseCategory, SearchQuery } from '../../../shared/types.js';

const CURRENT_YEAR = new Date().getFullYear();

export function parseQuery(raw: string): SearchQuery {
  let s = ` ${raw.trim()} `;
  const out: SearchQuery = { raw: raw.trim(), title: '', wants: {} };
  const take = (re: RegExp, fn: (m: RegExpMatchArray) => void) => {
    const m = s.match(re);
    if (!m) return false;
    fn(m);
    s = s.replace(re, ' ');
    return true;
  };

  // ids
  take(/\b(?:imdb:)?(tt\d{6,9})\b/i, (m) => (out.imdbId = m[1].toLowerCase()));
  take(/\btmdb[:\s#]*(\d+)\b/i, (m) => {
    out.tmdbId = Number(m[1]);
    out.kind ??= 'movie';
  });
  take(/\btvdb[:\s#]*(\d+)\b/i, (m) => {
    out.tvdbId = Number(m[1]);
    out.kind ??= 'series';
  });

  // season / episode: S01E05, S1 E5, 1x05, S01, Season 2, Episode 12, E12, "- 12" (anime absolute)
  take(/\bs(\d{1,2})\s*e(\d{1,4})\b/i, (m) => {
    out.season = Number(m[1]);
    out.episode = Number(m[2]);
  }) ||
    take(/\b(\d{1,2})x(\d{2,3})\b/i, (m) => {
      out.season = Number(m[1]);
      out.episode = Number(m[2]);
    });
  if (out.season === undefined) take(/\b(?:s|season\s*)(\d{1,2})\b/i, (m) => (out.season = Number(m[1])));
  if (out.episode === undefined) take(/\b(?:e|ep|episode\s*)(\d{1,4})\b/i, (m) => (out.episode = Number(m[1])));
  if (out.season === undefined && out.episode === undefined) take(/\s-\s(\d{1,4})\s*$/, (m) => (out.absoluteEpisode = Number(m[1])));
  if (/\b(complete\s+series|all\s+seasons)\b/i.test(s)) take(/\b(complete\s+series|all\s+seasons)\b/i, () => (out.kind = 'series'));
  if (out.season !== undefined || out.episode !== undefined || out.absoluteEpisode !== undefined) out.kind = 'series';

  // explicit kind words, only as a prefix / suffix so titles like "The Truman Show" survive ("movie: heat", "frieren anime")
  take(/^\s*(movie|film)[:\s]\s*|\s(movie)\s*$/i, () => (out.kind ??= 'movie'));
  take(/^\s*(tv|series)[:\s]\s*|\s(tv|tv\s*series)\s*$/i, () => (out.kind ??= 'series'));
  take(/^\s*anime[:\s]\s*|\sanime\s*$/i, () => (out.anime = true));

  // resolution
  take(/\b(2160p|4k|uhd)\b/i, () => (out.wants.resolution = 2160)) ||
    take(/\b1080[pi]?\b/i, () => (out.wants.resolution = 1080)) ||
    take(/\b720p?\b/i, () => (out.wants.resolution = 720)) ||
    take(/\b(480p|576p|sd)\b/i, () => (out.wants.resolution = 480));

  // release category
  const cat = (c: ReleaseCategory) => () => (out.wants.category = c);
  // music
  take(/\bmqa\b/i, cat('mqa')) ||
    take(/\b(24[\s-]?bit|hi[\s-]?res|24[-/](?:44|48|88|96|176|192))\b/i, cat('hires')) ||
    take(/\b(flac|lossless|16[\s-]?bit|cd[\s-]?quality)\b/i, cat('cd')) ||
    take(/\b(mp3|v0|320\s?kbps|aac|ogg|opus)\b/i, cat('lossy')) ||
  take(/\b(bd[\s.-]?remux|remux)\b/i, cat('remux')) ||
    take(/\b(iso|bdmv|br-?disk|full[\s.-]?disc|disc|video_ts|bd(25|50|66|100))\b/i, cat('disc')) ||
    take(/\b(web[\s.-]?dl|webrip)\b/i, cat('web')) ||
    // plain "web" only next to other release words ("1080p web"), not in "Charlotte's Web"
    (out.wants.resolution !== undefined && take(/\bweb\b/i, cat('web'))) ||
    take(/\b(blu-?ray|bdrip|brrip|encode)\b/i, cat('bluray')) ||
    take(/\b(dvd|dvdrip)\b/i, cat('dvd'));
  // a trailing "bluray" after "remux" etc. is noise
  take(/\b(blu-?ray)\b/i, () => undefined);

  take(/\b(dolby\s*vision|dovi|dv)\b/i, () => (out.wants.dolbyVision = true));
  take(/\b(hdr10\+?|hdr)\b/i, () => (out.wants.hdr = true));
  take(/\b(atmos)\b/i, () => (out.wants.atmos = true));
  take(/\b(x265|hevc|h\.?265)\b/i, () => (out.wants.codec = 'hevc'));
  take(/\b(x264|avc|h\.?264)\b/i, () => (out.wants.codec = 'avc'));
  take(/\b(dual[\s.-]?audio|multi)\b/i, () => (out.wants.dualAudio = true));

  // year: "(2017)" or a trailing year, but never when it is the whole title ("1917", "2012") or part of one
  // ("Blade Runner 2049" – a year after the current one is never a release year).
  const words = s.trim().split(/\s+/).filter(Boolean);
  const yearAt = words.findIndex((w, i) => {
    const m = w.match(/^\(?((?:19|20)\d{2})\)?$/);
    if (!m) return false;
    const y = Number(m[1]);
    if (y < 1900 || y > CURRENT_YEAR + 1) return false;
    if (words.length === 1) return false;
    return /^\(/.test(w) || i === words.length - 1;
  });
  if (yearAt >= 0) {
    out.year = Number(words[yearAt].replace(/[()]/g, ''));
    words.splice(yearAt, 1);
  }

  out.title = words.join(' ').replace(/\s+([:,])/g, '$1').replace(/^[\s\-–:]+|[\s\-–:]+$/g, '').trim();
  return out;
}

/** Lower-case, accents / punctuation stripped, leading articles dropped. */
export function normalize(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/**
 * How well a candidate title matches the query title, 0–100.
 * Exact 100 · prefix 88 · every query word present 75 · typo-tolerant similarity · partial word overlap.
 */
export function titleScore(query: string, candidate: string): number {
  const q = normalize(query);
  const c = normalize(candidate);
  if (!q || !c) return 0;
  if (q === c) return 100;
  const compactQ = q.replace(/ /g, '');
  const compactC = c.replace(/ /g, '');
  if (compactQ === compactC) return 97;
  if (c.startsWith(`${q} `) || compactC.startsWith(compactQ)) return Math.max(70, 90 - (c.length - q.length) / 3);
  const qw = q.split(' ');
  const cw = new Set(c.split(' '));
  // words may be typed partially ("umaru" for "umaru chan", "frier" while typing)
  const wordHit = (w: string) => cw.has(w) || (w.length >= 3 && [...cw].some((x) => x.startsWith(w)));
  const hits = qw.filter(wordHit).length;
  let score = 0;
  if (hits === qw.length) score = 78 - Math.max(0, cw.size - qw.length) * 2;
  else if (hits) score = (hits / qw.length) * 55;
  // typo tolerance for short-ish titles
  if (compactQ.length >= 4) {
    const target = compactC.slice(0, Math.max(compactQ.length, Math.min(compactC.length, compactQ.length + 2)));
    const sim = 1 - levenshtein(compactQ, target) / Math.max(compactQ.length, target.length);
    if (sim >= 0.7) score = Math.max(score, sim * 80);
  }
  return Math.max(0, Math.round(score));
}
