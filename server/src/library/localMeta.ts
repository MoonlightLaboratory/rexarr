/**
 * Metadata for local media (titles outside the *arr apps).
 *
 *   Movies  TMDb (API key) · otherwise Radarr's lookup, which is TMDb data too
 *   Series  TMDb (API key) · otherwise Sonarr's lookup (TheTVDB)
 *   Albums  MusicBrainz release groups (1 request / second) + Cover Art Archive front covers
 *
 * Matching runs in the background after each scan, one title at a time, and only for titles without a match (or
 * whose last attempt is old). Results are kept in data/local-meta.json by item id; Fix Match stores a manual choice
 * that later runs never overwrite. Images go through rexarr's image proxy and cache.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { LocalItem, LocalMeta, LocalMetaCandidate } from '../../../shared/types.js';
import { DATA_DIR } from '../config.js';
import { store } from '../store.js';
import { arr } from '../arr/index.js';
import { httpFetch } from '../net.js';
import { mb } from '../music/musicbrainz.js';
import { titleScore } from '../search/query.js';

const FILE = path.join(DATA_DIR, 'local-meta.json');
const RETRY_NONE_MS = 7 * 86400_000;
const RETRY_ERROR_MS = 6 * 3600_000;

let metas: Record<string, LocalMeta> = {};
try {
  metas = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Record<string, LocalMeta>;
} catch {
  /* first run */
}
let saveTimer: NodeJS.Timeout | null = null;
const save = () => {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const tmp = `${FILE}.${process.pid}.tmp`;
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(metas));
      fs.renameSync(tmp, FILE);
    } catch (err) {
      console.error('[local-meta] save failed', err);
    }
  }, 1000);
};

export function metaFor(id: string): LocalMeta | undefined {
  return metas[id];
}

const proxied = (url?: string | null) => (url ? `api/image?remote=${encodeURIComponent(url)}` : undefined);
const yearOf = (d?: string) => (d && /^\d{4}/.test(d) ? Number(d.slice(0, 4)) : undefined);

// ---------- TMDb ----------

async function tmdb<T>(p: string, params: Record<string, string | number | undefined>): Promise<T> {
  const s = store.settings.localMedia;
  const key = s.tmdbApiKey.trim();
  const url = new URL(`https://api.themoviedb.org/3/${p}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  url.searchParams.set('language', s.metadataLanguage || 'en-US');
  // v4 read access tokens are JWTs; v3 keys are 32 hex characters
  const bearer = key.length > 40;
  if (!bearer) url.searchParams.set('api_key', key);
  const res = await httpFetch(url, { headers: { Accept: 'application/json', ...(bearer ? { Authorization: `Bearer ${key}` } : {}) }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 401) throw new Error('TMDb: invalid API key');
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 2000));
    return tmdb<T>(p, params);
  }
  if (!res.ok) throw new Error(`TMDb: HTTP ${res.status}`);
  return (await res.json()) as T;
}

interface TmdbHit {
  id: number;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  release_date?: string;
  first_air_date?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number;
  popularity?: number;
}

async function tmdbCandidates(kind: 'movie' | 'series', query: string, year?: number): Promise<LocalMetaCandidate[]> {
  const type = kind === 'movie' ? 'movie' : 'tv';
  const run = (y?: number) => tmdb<{ results: TmdbHit[] }>(`search/${type}`, { query, include_adult: 'false', ...(kind === 'movie' ? { year: y } : { first_air_date_year: y }) });
  let { results } = await run(year);
  if (!results.length && year) ({ results } = await run(undefined));
  return results.slice(0, 10).map((r) => ({
    source: 'tmdb',
    externalId: String(r.id),
    url: `https://www.themoviedb.org/${type}/${r.id}`,
    title: r.title ?? r.name,
    originalTitle: r.original_title ?? r.original_name,
    year: yearOf(r.release_date ?? r.first_air_date),
    overview: r.overview,
    poster: r.poster_path ? proxied(`https://image.tmdb.org/t/p/w500${r.poster_path}`) : undefined,
    backdrop: r.backdrop_path ? proxied(`https://image.tmdb.org/t/p/w1280${r.backdrop_path}`) : undefined,
    rating: r.vote_average ? Math.round(r.vote_average * 10) : undefined,
  }));
}

/** Genres and runtime need the details call. */
async function tmdbDetails(kind: 'movie' | 'series', c: LocalMetaCandidate): Promise<LocalMetaCandidate> {
  const d = await tmdb<{ genres?: { name: string }[]; runtime?: number; episode_run_time?: number[] }>(`${kind === 'movie' ? 'movie' : 'tv'}/${c.externalId}`, {}).catch(() => null);
  return d ? { ...c, genres: d.genres?.map((g) => g.name), runtimeMinutes: d.runtime || d.episode_run_time?.[0] || undefined } : c;
}

// ---------- Radarr / Sonarr lookup (no TMDb key) ----------

async function arrCandidates(kind: 'movie' | 'series', query: string, year?: number): Promise<LocalMetaCandidate[]> {
  const { radarr, sonarr } = arr();
  const client = kind === 'movie' ? radarr : sonarr;
  if (!client.configured) return [];
  const list = await client.lookup(year ? `${query} ${year}` : query).then((l) => (l.length || !year ? l : client.lookup(query)));
  return list.slice(0, 10).map((r) => ({
    source: kind === 'movie' ? 'radarr' : 'sonarr',
    externalId: String(r.externalId),
    url: kind === 'movie' ? `https://www.themoviedb.org/movie/${r.externalId}` : `https://thetvdb.com/dereferrer/series/${r.externalId}`,
    title: r.title,
    year: r.year || undefined,
    overview: r.overview,
    poster: r.poster,
  }));
}

// ---------- MusicBrainz + Cover Art Archive ----------

interface MbReleaseGroup {
  id: string;
  title: string;
  score?: number;
  'primary-type'?: string;
  'first-release-date'?: string;
  'artist-credit'?: { name: string; joinphrase?: string; artist?: { name: string; 'sort-name'?: string; aliases?: { name: string }[] } }[];
  tags?: { name: string; count: number }[];
}

const luceneEscape = (s: string) => s.replace(/([+\-!(){}[\]^"~*?:\\/]|&&|\|\|)/g, '\\$1');

/** Candidate plus whether its artist is known to be the folder's artist (searched by MusicBrainz artist id). */
export type ScoredCandidate = LocalMetaCandidate & { artistVerified?: boolean };

interface MbArtist {
  id: string;
  name: string;
  'sort-name'?: string;
  score?: number;
  aliases?: { name: string; 'sort-name'?: string }[];
}

/** "Utada, Hikaru" → "Hikaru Utada" */
const unsort = (s?: string) => (s && s.includes(', ') ? s.split(', ').reverse().join(' ') : s);

export function artistNames(a: Pick<MbArtist, 'name' | 'sort-name' | 'aliases'>): string[] {
  return [a.name, a['sort-name'], unsort(a['sort-name']), ...(a.aliases ?? []).flatMap((x) => [x.name, x['sort-name'], unsort(x['sort-name'])])].filter((x): x is string => Boolean(x));
}

const artistCache = new Map<string, MbArtist | null>();

/**
 * The MusicBrainz artist for a folder name. Album search does not look at aliases, but artist search does – so
 * "Eir Aoi" finds 藍井エイル and "Hikaru Utada" 宇多田ヒカル, and their albums are then searched by artist id.
 */
async function resolveArtist(name: string): Promise<MbArtist | null> {
  const key = name.trim().toLowerCase();
  if (artistCache.has(key)) return artistCache.get(key)!;
  const n = luceneEscape(name.trim());
  const r = await mb<{ artists?: MbArtist[] }>(`artist?query=${encodeURIComponent(`artist:"${n}" OR alias:"${n}" OR sortname:"${n}"`)}&limit=5`);
  const best = (r.artists ?? [])
    .map((a) => ({ a, s: Math.max(...artistNames(a).map((x) => titleScore(name, x))) }))
    .filter((x) => x.s >= 85 && (x.a.score ?? 0) >= 80)
    .sort((x, y) => y.s - x.s || (y.a.score ?? 0) - (x.a.score ?? 0))[0]?.a;
  artistCache.set(key, best ?? null);
  return best ?? null;
}

async function mbCandidates(title: string, artist?: string): Promise<ScoredCandidate[]> {
  const t = luceneEscape(title);
  const various = !artist || /^various( artists)?$/i.test(artist);
  const resolved = various ? null : await resolveArtist(artist!).catch(() => null);
  const search = (q: string) => mb<{ 'release-groups'?: MbReleaseGroup[] }>(`release-group?query=${encodeURIComponent(q)}&limit=10`).then((x) => x['release-groups'] ?? []);
  let groups: MbReleaseGroup[] = [];
  let verified = false;
  if (resolved) {
    groups = await search(`arid:${resolved.id} AND releasegroup:"${t}"`);
    if (!groups.length) groups = await search(`arid:${resolved.id} AND (${t})`);
    verified = groups.length > 0;
  }
  if (!groups.length) groups = await search([`releasegroup:"${t}"`, various ? '' : `artist:"${luceneEscape(artist!)}"`].filter(Boolean).join(' AND '));
  // loose fallback: title words (and artist words), artist checked by the scorer
  if (!groups.length) groups = await search(`${t}${various ? '' : ` ${luceneEscape(artist!)}`}`);
  return groups.map((g) => ({
    artistVerified: verified || undefined,
    source: 'musicbrainz',
    externalId: g.id,
    url: `https://musicbrainz.org/release-group/${g.id}`,
    title: g.title,
    artist: (g['artist-credit'] ?? []).map((c) => `${c.name}${c.joinphrase ?? ''}`).join('').trim() || undefined,
    year: yearOf(g['first-release-date']),
    type: g['primary-type'],
    genres: (g.tags ?? []).sort((a, b) => b.count - a.count).slice(0, 4).map((t) => t.name),
    score: g.score,
    poster: proxied(`https://coverartarchive.org/release-group/${g.id}/front-500`),
  }));
}

/** Cover Art Archive answers 404 for release groups without art; keep the poster only when it exists. */
async function hasCover(id: string): Promise<boolean> {
  try {
    const res = await httpFetch(`https://coverartarchive.org/release-group/${id}/front-250`, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    return res.status >= 200 && res.status < 400;
  } catch {
    return false;
  }
}

// ---------- matching ----------

export async function candidatesFor(it: LocalItem, query?: string): Promise<ScoredCandidate[]> {
  const q = query?.trim() || it.title;
  if (it.kind === 'album') {
    // "Artist - Album" typed in Fix Match
    const typed = query?.match(/^(.+?)\s+[-–]\s+(.+)$/);
    return typed ? mbCandidates(typed[2], typed[1]) : mbCandidates(q, query ? undefined : it.artist);
  }
  if (store.settings.localMedia.tmdbApiKey.trim()) return tmdbCandidates(it.kind, q, query ? undefined : it.year);
  return arrCandidates(it.kind, q, query ? undefined : it.year);
}

/** How well a candidate fits the title found on disk (0–100). */
export function matchScore(it: Pick<LocalItem, 'kind' | 'title' | 'year' | 'artist'>, c: ScoredCandidate): number {
  const t = Math.max(titleScore(it.title, c.title ?? ''), c.originalTitle ? titleScore(it.title, c.originalTitle) : 0);
  let s = t;
  if (it.year && c.year) s += it.year === c.year ? 10 : Math.abs(it.year - c.year) <= 1 ? 3 : -40;
  if (it.kind === 'album') {
    // searched by the resolved artist id ("Hikaru Utada" → 宇多田ヒカル), or the credit reads like the folder's artist
    const artistOk = !it.artist || /^various( artists)?$/i.test(it.artist) || c.artistVerified || (c.artist ? titleScore(it.artist, c.artist) >= 70 : false);
    s = Math.min(s, 100) * 0.75 + (c.score ?? 50) * 0.25 - (artistOk ? 0 : 45);
  }
  return Math.max(0, Math.min(100, Math.round(s)));
}

async function autoMatch(it: LocalItem): Promise<LocalMeta> {
  const now = new Date().toISOString();
  try {
    const list = await candidatesFor(it);
    const ranked = list.map((c) => ({ c, s: matchScore(it, c) })).sort((a, b) => b.s - a.s);
    const best = ranked[0];
    if (!best || best.s < 72) return { status: 'none', matchedAt: now, score: best?.s };
    let c = best.c;
    if (c.source === 'tmdb') c = await tmdbDetails(it.kind as 'movie' | 'series', c);
    if (c.source === 'musicbrainz' && !(await hasCover(c.externalId))) c = { ...c, poster: undefined };
    return { ...c, status: 'matched', score: best.s, matchedAt: now };
  } catch (err) {
    return { status: 'error', error: (err as Error).message, matchedAt: now };
  }
}

/** Store a Fix Match choice. */
export async function setMatch(it: LocalItem, c: LocalMetaCandidate): Promise<LocalMeta> {
  let full = c;
  if (c.source === 'tmdb') full = await tmdbDetails(it.kind as 'movie' | 'series', c);
  if (c.source === 'musicbrainz' && !(await hasCover(c.externalId))) full = { ...full, poster: undefined };
  metas[it.id] = { ...full, status: 'matched', manual: true, score: 100, matchedAt: new Date().toISOString() };
  save();
  return metas[it.id];
}

export function clearMatch(id: string) {
  delete metas[id];
  save();
}

let running = false;
let progress = { done: 0, total: 0, matched: 0, source: '' };

export function metaStatus() {
  const matched = Object.values(metas).filter((m) => m.status === 'matched').length;
  return { running, ...progress, matched: running ? progress.matched : matched };
}

/** Match every title that needs it (background, sequential). */
export async function enrichLocal(items: LocalItem[], opts: { force?: boolean } = {}) {
  const s = store.settings.localMedia;
  if (!s.metadata || running) return;
  const now = Date.now();
  const todo = items.filter((it) => {
    const m = metas[it.id];
    if (!m || opts.force) return !m?.manual;
    const age = now - new Date(m.matchedAt).getTime();
    return (m.status === 'none' && age > RETRY_NONE_MS) || (m.status === 'error' && age > RETRY_ERROR_MS);
  });
  if (!todo.length) return;
  running = true;
  progress = { done: 0, total: todo.length, matched: 0, source: s.tmdbApiKey.trim() ? 'TMDb · MusicBrainz' : 'Radarr / Sonarr lookup · MusicBrainz' };
  try {
    for (const it of todo) {
      if (!store.settings.localMedia.metadata) break;
      const m = await autoMatch(it);
      metas[it.id] = m;
      progress.done++;
      if (m.status === 'matched') progress.matched++;
      save();
      // TMDb allows ~50 requests / second, the *arr lookups proxy to their own metadata servers: stay polite
      if (it.kind !== 'album') await new Promise((r) => setTimeout(r, s.tmdbApiKey.trim() ? 150 : 400));
    }
    console.log(`[local-meta] matched ${progress.matched} of ${progress.total} titles (${progress.source})`);
  } finally {
    running = false;
  }
}
