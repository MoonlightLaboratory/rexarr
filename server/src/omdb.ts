/**
 * OMDb (https://www.omdbapi.com) – the IMDb data, by title or by IMDb id, behind a free key.
 *
 * Rexarr asks it one question: what is this film or series? Genre, year and whether it is a film or a series
 * are what a [smart profile](../../docs/guide/profiles.md) decides on, and until now they could only come from
 * Radarr and Sonarr - so a rule like "if it is animation, use the animation tune" did nothing for a local file,
 * a disc being ripped, or anything else the *arr apps have never heard of. OMDb answers for those.
 *
 * It is asked last and only when something actually wants the answer, so a library that is entirely in Radarr
 * and Sonarr never sends it a request. Answers are kept for a day: a film's genre does not change, and the free
 * key allows a thousand requests a day.
 */
import { httpFetch } from './net.js';
import { store } from './store.js';

const BASE = 'https://www.omdbapi.com/';
const TTL_MS = 24 * 3600_000;

export interface OmdbTitle {
  title: string;
  year: number;
  /** What OMDb calls it, mapped to the words a smart profile uses. */
  kind: 'movie' | 'series' | 'unknown';
  genres: string[];
  imdbId?: string;
  runtimeMinutes?: number;
  imdbRating?: number;
  plot?: string;
  rated?: string;
  poster?: string;
}

interface RawTitle {
  Response?: string;
  Error?: string;
  Title?: string;
  Year?: string;
  Genre?: string;
  Type?: string;
  imdbID?: string;
  Runtime?: string;
  imdbRating?: string;
  Plot?: string;
  Rated?: string;
  Poster?: string;
}

const cache = new Map<string, { at: number; value: OmdbTitle | null }>();

export function omdbSettings() {
  return store.settings.omdb ?? { enabled: false, apiKey: '' };
}

export function omdbConfigured(): boolean {
  const s = omdbSettings();
  return s.enabled && Boolean(s.apiKey.trim());
}

/** "Action, Adventure, Sci-Fi" → ["action","adventure","sci-fi"], which is the shape a smart profile matches on. */
function genresOf(raw?: string): string[] {
  if (!raw || raw === 'N/A') return [];
  return raw.split(',').map((g) => g.trim().toLowerCase()).filter(Boolean);
}

function numberOf(raw?: string): number | undefined {
  if (!raw || raw === 'N/A') return undefined;
  const n = Number.parseFloat(raw.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

export function parseTitle(raw: RawTitle): OmdbTitle | null {
  if (raw.Response === 'False' || !raw.Title) return null;
  return {
    title: raw.Title,
    // a series reads "2008–2013"; the first number is the one that means anything here
    year: Number.parseInt(raw.Year ?? '', 10) || 0,
    kind: raw.Type === 'movie' ? 'movie' : raw.Type === 'series' || raw.Type === 'episode' ? 'series' : 'unknown',
    genres: genresOf(raw.Genre),
    imdbId: raw.imdbID && raw.imdbID !== 'N/A' ? raw.imdbID : undefined,
    runtimeMinutes: numberOf(raw.Runtime),
    imdbRating: numberOf(raw.imdbRating),
    plot: raw.Plot && raw.Plot !== 'N/A' ? raw.Plot : undefined,
    rated: raw.Rated && raw.Rated !== 'N/A' ? raw.Rated : undefined,
    poster: raw.Poster && raw.Poster !== 'N/A' ? raw.Poster : undefined,
  };
}

async function ask(params: Record<string, string>, signal?: AbortSignal): Promise<OmdbTitle | null> {
  const s = omdbSettings();
  if (!omdbConfigured()) return null;
  const url = new URL(BASE);
  url.searchParams.set('apikey', s.apiKey.trim());
  url.searchParams.set('r', 'json');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  // the key is in the query string, so it must never be the cache key or turn up in a log
  const key = Object.entries(params).map(([k, v]) => `${k}=${v}`).sort().join('&');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const res = await httpFetch(url, { signal, headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`OMDb answered ${res.status} ${res.statusText}`);
  const raw = (await res.json()) as RawTitle;
  if (raw.Response === 'False' && raw.Error && !/not found/i.test(raw.Error)) throw new Error(`OMDb: ${raw.Error}`);
  const value = parseTitle(raw);
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 500) for (const [k, v] of cache) if (Date.now() - v.at > TTL_MS) cache.delete(k);
  return value;
}

/** By IMDb id, which is exact. Radarr and TheDiscDB both hand one over. */
export function byImdbId(imdbId: string, signal?: AbortSignal): Promise<OmdbTitle | null> {
  return ask({ i: imdbId }, signal);
}

/** By title, optionally pinned to a year and a kind. OMDb picks the best match itself. */
export function byTitle(title: string, opts: { year?: number; kind?: 'movie' | 'series' } = {}, signal?: AbortSignal): Promise<OmdbTitle | null> {
  const params: Record<string, string> = { t: title };
  if (opts.year) params.y = String(opts.year);
  if (opts.kind) params.type = opts.kind;
  return ask(params, signal);
}

/** Settings → Metadata → OMDb → Test: is the key the right one, and does it still have requests left? */
export async function testOmdb(apiKey: string): Promise<{ ok: boolean; error?: string; sample?: string }> {
  const trimmed = apiKey.trim();
  if (!trimmed) return { ok: false, error: 'No API key. Get a free one at omdbapi.com/apikey.aspx.' };
  try {
    const url = new URL(BASE);
    url.searchParams.set('apikey', trimmed);
    url.searchParams.set('i', 'tt0111161'); // The Shawshank Redemption: it is not going anywhere
    const res = await httpFetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) return { ok: false, error: `OMDb answered ${res.status} ${res.statusText}` };
    const raw = (await res.json()) as RawTitle;
    if (raw.Response === 'False') return { ok: false, error: raw.Error ?? 'OMDb refused the request' };
    const t = parseTitle(raw);
    return { ok: true, sample: t ? `${t.title} (${t.year}) – ${t.genres.join(', ')}` : undefined };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** For tests and for a key change, which must not be answered from the old key's cache. */
export function clearOmdbCache(): void {
  cache.clear();
}
