/**
 * AniDB metadata for anime, built from two public datasets (no API key needed):
 *
 *  - anime-titles.xml.gz  (https://anidb.net/api/anime-titles.xml.gz): every AniDB anime with its main,
 *    official (en / ja), romaji (x-jat) and synonym titles. AniDB asks for at most one download per day.
 *  - anime-list-full.xml  (Anime-Lists on GitHub): maps AniDB ids to TVDB series (with default season and
 *    episode offsets) and to movies (IMDb / TMDB ids).
 *
 * Both are cached in the data directory and refreshed weekly.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { PATHS, APP_VERSION, REPO_URL } from './config.js';
import { httpFetch } from './net.js';

const TITLES_URL = 'https://anidb.net/api/anime-titles.xml.gz';
const MAPPING_URL = 'https://raw.githubusercontent.com/Anime-Lists/anime-lists/master/anime-list-full.xml';
const MAX_AGE_MS = 7 * 24 * 3600_000;

export interface AnidbEntry {
  aid: number;
  /** AniDB main title (usually romaji). */
  main: string;
  romaji?: string;
  kanji?: string;
  english?: string;
  synonyms: string[];
}

export interface AnidbMapping {
  aid: number;
  name: string;
  /** TVDB series id, or 'movie' / 'unknown' / other placeholder. */
  tvdbId?: number;
  isMovie: boolean;
  defaultSeason?: number;
  episodeOffset: number;
  tmdbId?: number;
  imdbId?: string;
}

export interface AnidbSearchHit {
  entry: AnidbEntry;
  mapping?: AnidbMapping;
  score: number;
  matched: string;
}

export interface AnidbStatus {
  enabled: boolean;
  loaded: boolean;
  loading: boolean;
  animeCount: number;
  mappingCount: number;
  updatedAt?: string;
  error?: string;
}

/** Lower-case, strip accents and punctuation, collapse whitespace. */
export function normalizeTitle(s: string): string {
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

function decodeXml(s: string) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');
}

/** Parse anime-titles.xml (a very regular format; a full XML parser is not needed). */
export function parseTitles(xml: string): Map<number, AnidbEntry> {
  const out = new Map<number, AnidbEntry>();
  const animeRe = /<anime aid="(\d+)">([\s\S]*?)<\/anime>/g;
  const titleRe = /<title\s+([^>]*)>([^<]*)<\/title>/g;
  let m: RegExpExecArray | null;
  while ((m = animeRe.exec(xml))) {
    const aid = Number(m[1]);
    const e: AnidbEntry = { aid, main: '', synonyms: [] };
    let t: RegExpExecArray | null;
    while ((t = titleRe.exec(m[2]))) {
      // attribute order varies between entries (xml:lang/type or type/xml:lang)
      const lang = t[1].match(/xml:lang="([^"]*)"/)?.[1] ?? '';
      const type = t[1].match(/\btype="([^"]*)"/)?.[1] ?? '';
      const title = decodeXml(t[2]).trim();
      if (!title) continue;
      if (type === 'main') e.main = title;
      else if (type === 'official' && lang === 'en' && !e.english) e.english = title;
      else if (type === 'official' && lang === 'ja' && !e.kanji) e.kanji = title;
      else if (type === 'official' && lang === 'x-jat' && !e.romaji) e.romaji = title;
      else if (type === 'syn' || type === 'short') {
        if ((lang === 'en' || lang === 'x-jat' || lang === 'ja') && e.synonyms.length < 12) e.synonyms.push(title);
      }
    }
    if (!e.romaji && /^[\x20-\x7e]+$/.test(e.main)) e.romaji = e.main;
    if (e.main) out.set(aid, e);
  }
  return out;
}

/** Parse anime-list-full.xml. */
export function parseMappings(xml: string): Map<number, AnidbMapping> {
  const out = new Map<number, AnidbMapping>();
  const re = /<anime\s([^>]*?)\s*\/>|<anime\s([^>]*)>([\s\S]*?)<\/anime>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const attrs = m[1] ?? m[2] ?? '';
    const body = m[3] ?? '';
    const attr = (n: string) => attrs.match(new RegExp(`\\b${n}="([^"]*)"`))?.[1];
    const aid = Number(attr('anidbid'));
    if (!aid) continue;
    const tvdb = attr('tvdbid') ?? '';
    const tmdb = attr('tmdbid');
    const imdb = attr('imdbid');
    const name = decodeXml(body.match(/<name>([^<]*)<\/name>/)?.[1] ?? '');
    // Anime-Lists uses `tmdbid` only for TMDB *movie* ids (TV shows use `tmdbtv`), so its presence marks a
    // movie even when it is also mapped into a TVDB season as a special.
    const isMovie = tvdb === 'movie' || Boolean(tmdb) || (!/^\d+$/.test(tvdb) && Boolean(imdb));
    out.set(aid, {
      aid,
      name,
      tvdbId: /^\d+$/.test(tvdb) ? Number(tvdb) : undefined,
      isMovie,
      defaultSeason: attr('defaulttvdbseason') !== undefined && /^\d+$/.test(attr('defaulttvdbseason')!) ? Number(attr('defaulttvdbseason')) : undefined,
      episodeOffset: Number(attr('episodeoffset') ?? 0) || 0,
      tmdbId: tmdb && /^\d+$/.test(tmdb.split(',')[0]) ? Number(tmdb.split(',')[0]) : undefined,
      imdbId: imdb && /^tt\d+/.test(imdb) ? imdb.split(',')[0] : undefined,
    });
  }
  return out;
}

class AniDb {
  private entries = new Map<number, AnidbEntry>();
  private mappings = new Map<number, AnidbMapping>();
  private byTvdb = new Map<number, AnidbMapping[]>();
  private byTmdb = new Map<number, AnidbMapping>();
  private byImdb = new Map<string, AnidbMapping>();
  /** normalized title -> aids */
  private index = new Map<string, number[]>();
  private loading: Promise<void> | null = null;
  private loaded = false;
  private error: string | undefined;
  private updatedAt: string | undefined;
  enabled = false;

  private get dir() {
    return PATHS.metadata;
  }

  status(): AnidbStatus {
    return { enabled: this.enabled, loaded: this.loaded, loading: Boolean(this.loading), animeCount: this.entries.size, mappingCount: this.mappings.size, updatedAt: this.updatedAt, error: this.error };
  }

  /** Load from cache (downloading when stale or missing). Safe to call often; work is deduplicated. */
  ensure(force = false): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    if (this.loaded && !force) return Promise.resolve();
    if (this.loading) return this.loading;
    this.loading = this.load(force)
      .catch((err) => {
        this.error = (err as Error).message;
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  private async fetchToFile(url: string, file: string, force: boolean) {
    const fresh = fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < MAX_AGE_MS;
    if (fresh && !force) return;
    const res = await httpFetch(url, { headers: { 'User-Agent': `rexarr/${APP_VERSION} (+${REPO_URL})`, 'Accept-Encoding': 'identity' }, signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, buf);
    fs.renameSync(`${file}.tmp`, file);
  }

  private async load(force: boolean) {
    this.error = undefined;
    const titlesFile = path.join(this.dir, 'anime-titles.xml.gz');
    const mapFile = path.join(this.dir, 'anime-list-full.xml');
    await Promise.all([this.fetchToFile(TITLES_URL, titlesFile, force), this.fetchToFile(MAPPING_URL, mapFile, force)]);
    const gz = fs.readFileSync(titlesFile);
    const titlesXml = (gz[0] === 0x1f && gz[1] === 0x8b ? zlib.gunzipSync(gz) : gz).toString('utf8');
    this.entries = parseTitles(titlesXml);
    this.mappings = parseMappings(fs.readFileSync(mapFile, 'utf8'));
    this.byTvdb = new Map();
    this.byTmdb = new Map();
    this.byImdb = new Map();
    for (const mp of this.mappings.values()) {
      if (mp.tvdbId) {
        if (!this.byTvdb.has(mp.tvdbId)) this.byTvdb.set(mp.tvdbId, []);
        this.byTvdb.get(mp.tvdbId)!.push(mp);
      }
      if (mp.tmdbId && mp.isMovie) this.byTmdb.set(mp.tmdbId, mp);
      if (mp.imdbId && mp.isMovie) this.byImdb.set(mp.imdbId, mp);
    }
    for (const list of this.byTvdb.values()) list.sort((a, b) => (a.defaultSeason ?? 99) - (b.defaultSeason ?? 99) || a.episodeOffset - b.episodeOffset || a.aid - b.aid);
    this.index = new Map();
    for (const e of this.entries.values()) {
      for (const t of [e.main, e.romaji, e.english, e.kanji, ...e.synonyms]) {
        if (!t) continue;
        const n = normalizeTitle(t);
        if (!n) continue;
        if (!this.index.has(n)) this.index.set(n, []);
        const l = this.index.get(n)!;
        if (!l.includes(e.aid)) l.push(e.aid);
      }
    }
    this.updatedAt = new Date(Math.min(fs.statSync(titlesFile).mtimeMs, fs.statSync(mapFile).mtimeMs)).toISOString();
    this.loaded = true;
  }

  get(aid: number) {
    return this.entries.get(aid);
  }
  mapping(aid: number) {
    return this.mappings.get(aid);
  }
  forTvdb(tvdbId: number): AnidbMapping[] {
    return this.byTvdb.get(tvdbId) ?? [];
  }
  /** Names AniDB gives each TVDB season of a series: one anime per season for most shows. */
  seasonTitles(tvdbId: number): { seasonNumber: number; titles: string[]; english?: string }[] {
    const out: { seasonNumber: number; titles: string[]; english?: string }[] = [];
    for (const mp of this.forTvdb(tvdbId)) {
      if (!mp.defaultSeason || mp.defaultSeason < 1 || mp.episodeOffset) continue;
      const e = this.entries.get(mp.aid);
      if (!e) continue;
      const titles = [...new Set([e.english, e.main, e.romaji, ...e.synonyms].filter((t): t is string => Boolean(t)))];
      out.push({ seasonNumber: mp.defaultSeason, titles, english: e.english });
    }
    return out;
  }

  forTmdb(tmdbId: number) {
    return this.byTmdb.get(tmdbId);
  }
  forImdb(imdbId: string) {
    return this.byImdb.get(imdbId);
  }

  /** Title search: exact normalized match, then prefix, then word overlap. */
  search(query: string, limit = 10): AnidbSearchHit[] {
    const q = normalizeTitle(query);
    if (!q || !this.loaded) return [];
    const scores = new Map<number, { score: number; matched: string }>();
    const bump = (aid: number, score: number, matched: string) => {
      const cur = scores.get(aid);
      if (!cur || cur.score < score) scores.set(aid, { score, matched });
    };
    for (const aid of this.index.get(q) ?? []) bump(aid, 100, q);
    if (scores.size < limit) {
      const words = q.split(' ').filter((w) => w.length > 1);
      for (const [title, aids] of this.index) {
        if (title === q) continue;
        let score = 0;
        if (title.startsWith(q + ' ') || q.startsWith(title + ' ')) score = 80 - Math.abs(title.length - q.length) / 4;
        else if (words.length >= 2) {
          const tw = new Set(title.split(' '));
          const hit = words.filter((w) => tw.has(w)).length;
          if (hit === words.length) score = 60 - Math.max(0, tw.size - words.length) * 3;
          else if (hit >= Math.max(2, words.length - 1)) score = 40 + hit * 2 - tw.size;
        }
        if (score > 0) for (const aid of aids) bump(aid, score, title);
      }
    }
    return [...scores.entries()]
      .sort((a, b) => b[1].score - a[1].score || a[0] - b[0])
      .slice(0, limit)
      .map(([aid, s]) => ({ entry: this.entries.get(aid)!, mapping: this.mappings.get(aid), score: s.score, matched: s.matched }))
      .filter((h) => h.entry);
  }
}

export const anidb = new AniDb();
