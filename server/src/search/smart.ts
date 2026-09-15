/**
 * Smart title search across the library and TMDB / TVDB.
 *
 * Library titles (Radarr + Sonarr, cached briefly) are matched on title, alternate titles and AniDB romaji / kanji,
 * typo-tolerant, with the year and "movie / series" hints from the query. With online=1 the Radarr / Sonarr lookups
 * run in parallel (ids go straight to tmdb: / tvdb: / imdb: lookups) and AniDB resolves romaji anime names to their
 * TVDB / TMDB entries.
 */
import type { Album, LookupResult, Movie, SearchQuery, Series, SmartSearchResult } from '../../../shared/types.js';
import { arr } from '../arr/index.js';
import { store } from '../store.js';
import { anidb } from '../anidb.js';
import { enrichMovie, enrichSeries } from '../enrich.js';
import { parseQuery, titleScore } from './query.js';
import { hashId } from '../arr/lidarr.js';
import { localItems } from '../library/local.js';
import type { LocalItem } from '../../../shared/types.js';

const LIBRARY_TTL_MS = 60_000;
type LocalResultList = LookupResult[];
interface LibraryCache {
  key: string;
  at: number;
  movies: Movie[];
  series: Series[];
  albums: Album[];
  errors: string[];
}
let cache: LibraryCache | null = null;
let inflight: Promise<LibraryCache> | null = null;

async function library(): Promise<LibraryCache> {
  const { radarr, sonarr, lidarr } = arr();
  const key = `${radarr.configured ? store.settings.radarr.url : ''}|${sonarr.configured ? store.settings.sonarr.url : ''}|${lidarr.configured ? store.settings.lidarr.url : ''}`;
  if (cache && cache.key === key && Date.now() - cache.at < LIBRARY_TTL_MS) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    const errors: string[] = [];
    await anidb.ensure().catch(() => undefined);
    const [movies, series, albums] = await Promise.all([
      radarr.configured ? radarr.movies().then((l) => l.map(enrichMovie)).catch((e: Error) => (errors.push(e.message), [] as Movie[])) : [],
      sonarr.configured ? sonarr.series().then((l) => l.map(enrichSeries)).catch((e: Error) => (errors.push(e.message), [] as Series[])) : [],
      lidarr.configured ? lidarr.albums().catch((e: Error) => (errors.push(e.message), [] as Album[])) : [],
    ]);
    const fresh: LibraryCache = { key, at: Date.now(), movies, series, albums, errors };
    cache = fresh;
    return fresh;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Forget the cached library (after adding a title). */
export function invalidateLibrary() {
  cache = null;
}

function bestTitle(q: SearchQuery, titles: (string | undefined)[]): { score: number; matched: string } {
  let best = { score: 0, matched: '' };
  titles.forEach((t, i) => {
    if (!t) return;
    // the main title wins ties; alternates are slightly discounted
    const s = titleScore(q.title, t) - (i === 0 ? 0 : 2);
    if (s > best.score) best = { score: s, matched: t };
  });
  return best;
}

function adjust(q: SearchQuery, base: number, kind: 'movie' | 'series' | 'album', year: number, anime?: boolean) {
  let s = base;
  if (q.year) s += year === q.year ? 12 : Math.abs(year - q.year) <= 1 ? 4 : -20;
  if (q.kind) s += q.kind === kind ? 10 : -30;
  if (q.anime) s += anime ? 8 : -5;
  return s;
}

function movieHit(m: Movie, score: number, matched: string): LookupResult {
  return {
    kind: 'movie',
    arrId: m.id,
    externalId: m.tmdbId,
    title: m.title,
    year: m.year,
    overview: m.overview,
    poster: m.poster,
    inLibrary: true,
    anime: m.anime,
    score,
    matchedOn: matched !== m.title ? matched : undefined,
    library: { hasFile: m.hasFile, remux: Boolean(m.file?.isRemux), quality: m.file?.quality, sizeOnDisk: m.file?.size },
  };
}

function seriesHit(s: Series, score: number, matched: string): LookupResult {
  return {
    kind: 'series',
    arrId: s.id,
    externalId: s.tvdbId,
    title: s.title,
    year: s.year,
    overview: s.overview,
    poster: s.poster,
    inLibrary: true,
    seriesType: s.seriesType,
    anime: s.seriesType === 'anime' || Boolean(s.anidbIds?.length),
    score,
    matchedOn: matched !== s.title ? matched : undefined,
    library: { hasFile: s.statistics.episodeFileCount > 0, remux: s.statistics.remuxFileCount > 0, files: s.statistics.episodeFileCount, episodes: s.statistics.episodeCount, remuxFiles: s.statistics.remuxFileCount, sizeOnDisk: s.statistics.sizeOnDisk },
  };
}

function localHit(it: LocalItem, score: number, matched: string): LookupResult {
  const best = it.files.find((f) => f.isRemux) ?? [...it.files].sort((a, b) => (b.resolution ?? 0) - (a.resolution ?? 0))[0];
  const episodes = it.kind === 'series' ? it.files.length : it.kind === 'album' ? it.files.length : undefined;
  return {
    kind: it.kind,
    externalId: parseInt(it.id.slice(0, 12), 16),
    title: it.title,
    year: it.year ?? it.meta?.year ?? 0,
    artist: it.artist,
    overview: it.meta?.overview ?? '',
    poster: it.poster ? `api/local/items/${it.id}/poster` : it.meta?.poster,
    inLibrary: false,
    anime: it.anime,
    score,
    matchedOn: matched !== it.title ? matched : undefined,
    local: { id: it.id, folder: it.folder, files: it.files.length, size: it.size, quality: it.kind === 'album' ? undefined : best?.quality, modified: Math.max(0, ...it.files.map((f) => f.mtime)) || undefined, matched: it.meta?.status === 'matched' || undefined },
    library: { hasFile: true, remux: it.files.some((f) => f.isRemux), quality: best?.quality, files: episodes, episodes, remuxFiles: it.files.filter((f) => f.isRemux).length || undefined, sizeOnDisk: it.size },
  };
}

/** Local titles matching a query (best first), or every local title when the query is empty. */
export function searchLocal(query: SearchQuery, scope: 'all' | 'movie' | 'series' | 'music' = 'all'): LookupResult[] {
  const out: LookupResult[] = [];
  for (const it of localItems()) {
    const kind = it.kind === 'album' ? 'music' : it.kind;
    if (scope !== 'all' && scope !== kind) continue;
    if (!query.title) {
      out.push(localHit(it, 0, it.title));
      continue;
    }
    const m = it.meta?.status === 'matched' ? it.meta : undefined;
    const artists = [it.artist, m?.artist].filter((a): a is string => Boolean(a));
    const b = bestTitle(query, [it.title, ...artists.flatMap((a) => [`${a} ${it.title}`, `${it.title} ${a}`]), m?.title, m?.originalTitle, ...(m?.title ? artists.map((a) => `${a} ${m.title}`) : [])]);
    const s = Math.max(b.score, artists.some((a) => titleScore(query.title, a) >= 95) ? 60 : 0);
    if (s >= (it.kind === 'album' && scope !== 'music' ? 60 : 45)) out.push(localHit(it, Math.round(adjust(query, s, it.kind, it.year ?? 0, it.anime)), b.matched || it.title));
  }
  return out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.title.localeCompare(b.title));
}

function albumHit(a: Album, score: number, matched: string): LookupResult {
  return {
    kind: 'album',
    arrId: a.id,
    artistId: a.artistId,
    artist: a.artist,
    foreignId: a.foreignAlbumId,
    externalId: hashId(a.foreignAlbumId),
    title: a.title,
    year: a.year ?? 0,
    overview: a.overview ?? '',
    poster: a.cover,
    inLibrary: true,
    score,
    matchedOn: matched !== a.title ? matched : undefined,
    library: { hasFile: a.statistics.trackFileCount > 0, remux: false, files: a.statistics.trackFileCount, episodes: a.statistics.trackCount, sizeOnDisk: a.statistics.sizeOnDisk },
  };
}

export async function smartSearch(raw: string, opts: { scope?: 'all' | 'movie' | 'series' | 'music'; online?: boolean; limit?: number } = {}): Promise<SmartSearchResult> {
  const query = parseQuery(raw);
  const scope = opts.scope && opts.scope !== 'all' ? opts.scope : query.kind ?? 'all';
  const limit = opts.limit ?? 12;
  const { radarr, sonarr, lidarr } = arr();
  const lib = await library();
  const errors = [...lib.errors];
  const hits: LookupResult[] = [];

  // AniDB: a romaji / Japanese / English anime title → ids of the library entry it maps to
  // Only confident hits: a prefix match like "Blade" for "Blade Runner" is not the same show.
  const anidbIds = { tvdb: new Map<number, { title: string; score: number }>(), tmdb: new Map<number, { title: string; score: number }>() };
  if (query.title && anidb.enabled && anidb.status().loaded) {
    for (const h of anidb.search(query.title, 8)) {
      if (!h.mapping || Math.min(h.score, titleScore(query.title, h.matched)) < 75) continue;
      const hit = { title: h.entry.main, score: Math.min(95, h.score) };
      if (h.mapping.tvdbId && !anidbIds.tvdb.has(h.mapping.tvdbId)) anidbIds.tvdb.set(h.mapping.tvdbId, hit);
      if (h.mapping.tmdbId && !anidbIds.tmdb.has(h.mapping.tmdbId)) anidbIds.tmdb.set(h.mapping.tmdbId, hit);
    }
  }

  if (scope === 'all' || scope === 'music') {
    for (const a of lib.albums) {
      if (!query.title) break;
      // "Artist Album", "Album" or "Album Artist"
      const b = bestTitle(query, [a.title, a.artist ? `${a.artist} ${a.title}` : undefined, a.artist ? `${a.title} ${a.artist}` : undefined]);
      const s = Math.max(b.score, a.artist && titleScore(query.title, a.artist) >= 95 ? 60 : 0);
      if (s >= (scope === 'music' ? 45 : 60)) hits.push(albumHit(a, Math.round(adjust(query, s, 'album', a.year ?? 0)), b.matched || a.title));
    }
  }
  if (scope !== 'series' && scope !== 'music') {
    for (const m of lib.movies) {
      let s = 0;
      let matched = m.title;
      if (query.tmdbId === m.tmdbId || (query.imdbId && m.imdbId === query.imdbId)) s = 200;
      else if (query.title) {
        const b = bestTitle(query, [m.title, m.titleRomaji, m.titleKanji, ...(m.alternateTitles ?? [])]);
        s = b.score;
        matched = b.matched;
        const viaAnidb = anidbIds.tmdb.get(m.tmdbId);
        if (viaAnidb && s < viaAnidb.score) {
          if (s < 45) matched = viaAnidb.title;
          s = viaAnidb.score;
        }
      }
      if (s >= 45) hits.push(movieHit(m, Math.round(adjust(query, s, 'movie', m.year, m.anime)), matched));
    }
  }
  if (scope !== 'movie' && scope !== 'music') {
    for (const se of lib.series) {
      let s = 0;
      let matched = se.title;
      if (query.tvdbId === se.tvdbId || (query.imdbId && se.imdbId === query.imdbId)) s = 200;
      else if (query.title) {
        const b = bestTitle(query, [se.title, se.titleRomaji, se.titleKanji, ...(se.alternateTitles ?? [])]);
        s = b.score;
        matched = b.matched;
        const viaAnidb = anidbIds.tvdb.get(se.tvdbId);
        if (viaAnidb && s < viaAnidb.score) {
          if (s < 45) matched = viaAnidb.title;
          s = viaAnidb.score;
        }
      }
      if (s >= 45) hits.push(seriesHit(se, Math.round(adjust(query, s, 'series', se.year, se.seriesType === 'anime')), matched));
    }
  }
  hits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.title.localeCompare(b.title));

  // Files on disk no *arr app manages
  const local: LocalResultList = query.title ? searchLocal(query, scope) : [];

  let online: LookupResult[] = [];
  if (opts.online && (query.title || query.tmdbId || query.tvdbId || query.imdbId)) {
    const jobs: Promise<LookupResult[]>[] = [];
    const safe = (p: Promise<LookupResult[]>, label: string) => p.catch((e: Error) => (errors.push(`${label}: ${e.message}`), [] as LookupResult[]));
    const term = query.title + (query.year ? ` ${query.year}` : '');
    if ((scope === 'music' || scope === 'all') && lidarr.configured && query.title) {
      jobs.push(safe(lidarr.lookupAlbums(query.title).then((l) => l.slice(0, scope === 'music' ? 12 : 4)), 'Lidarr'));
    }
    if (scope !== 'series' && scope !== 'music' && radarr.configured) {
      if (query.tmdbId) jobs.push(safe(radarr.lookup(`tmdb:${query.tmdbId}`), 'Radarr'));
      else if (query.imdbId) jobs.push(safe(radarr.lookup(`imdb:${query.imdbId}`), 'Radarr'));
      else if (query.title) jobs.push(safe(radarr.lookup(term), 'Radarr'));
      for (const id of [...anidbIds.tmdb.keys()].slice(0, 2)) jobs.push(safe(radarr.lookup(`tmdb:${id}`), 'Radarr'));
    }
    if (scope !== 'movie' && scope !== 'music' && sonarr.configured) {
      if (query.tvdbId) jobs.push(safe(sonarr.lookup(`tvdb:${query.tvdbId}`), 'Sonarr'));
      else if (query.imdbId) jobs.push(safe(sonarr.lookup(`imdb:${query.imdbId}`), 'Sonarr'));
      else if (query.title) jobs.push(safe(sonarr.lookup(query.title), 'Sonarr'));
      for (const id of [...anidbIds.tvdb.keys()].slice(0, 2)) jobs.push(safe(sonarr.lookup(`tvdb:${id}`), 'Sonarr'));
    }
    const seen = new Set(hits.map((h) => `${h.kind}:${h.externalId}`));
    const results = (await Promise.all(jobs)).flat();
    results.forEach((r, i) => {
      const key = `${r.kind}:${r.externalId}`;
      if (!r.externalId || seen.has(key)) return;
      seen.add(key);
      if (r.kind === 'album') {
        const inLibAlbum = lib.albums.find((x) => x.foreignAlbumId === r.foreignId);
        if (hits.some((h) => h.kind === 'album' && h.foreignId === r.foreignId)) return;
        const base = Math.max(titleScore(query.title, r.title), r.artist ? titleScore(query.title, `${r.artist} ${r.title}`) : 0, i < 2 ? 46 : 0);
        if (base < 45) return;
        const score = Math.round(adjust(query, base, 'album', r.year));
        if (inLibAlbum) hits.push(albumHit(inLibAlbum, score, r.title));
        else online.push({ ...r, score });
        return;
      }
      // Already in the library but not matched locally (lookup knows a translation we do not): show it as a library hit.
      const inLib = r.kind === 'movie' ? lib.movies.find((m) => m.tmdbId === r.externalId) : lib.series.find((s) => s.tvdbId === r.externalId);
      const viaAnidb = r.kind === 'movie' ? anidbIds.tmdb.get(r.externalId) : anidbIds.tvdb.get(r.externalId);
      const idMatch = (r.kind === 'movie' ? query.tmdbId === r.externalId : query.tvdbId === r.externalId) || Boolean(query.imdbId);
      const ts = titleScore(query.title, r.title);
      // TMDB / TVDB also match translations we cannot see, so their first couple of answers get some benefit of the doubt.
      const base = idMatch ? 100 : Math.max(ts, viaAnidb?.score ?? 0, i < 2 && ts >= 20 ? 46 : 0);
      if (base < 45) return;
      const score = Math.round(adjust(query, base, r.kind, r.year, r.seriesType === 'anime'));
      if (inLib) hits.push(r.kind === 'movie' ? movieHit(inLib as Movie, score, r.title) : seriesHit(inLib as Series, score, r.title));
      else online.push({ ...r, score, anime: r.seriesType === 'anime' || undefined });
    });
    hits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    online = online.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, limit);
  }

  return { query, library: hits.slice(0, limit), local: local.slice(0, limit), online, errors };
}
