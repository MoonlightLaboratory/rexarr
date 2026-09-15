import type { Movie, Series } from '../../shared/types.js';
import { anidb } from './anidb.js';

/** Attach AniDB facts (anime flag, romaji / kanji titles) when the datasets are loaded. */
export function enrichMovie(m: Movie): Movie {
  if (!anidb.enabled || !anidb.status().loaded) return m;
  const mp = (m.tmdbId ? anidb.forTmdb(m.tmdbId) : undefined) ?? (m.imdbId ? anidb.forImdb(m.imdbId) : undefined);
  if (!mp) return m;
  const e = anidb.get(mp.aid);
  return { ...m, anime: true, anidbId: mp.aid, titleRomaji: e?.romaji ?? e?.main, titleKanji: e?.kanji };
}

export function enrichSeries(s: Series): Series {
  if (!anidb.enabled || !anidb.status().loaded) return s;
  const maps = anidb.forTvdb(s.tvdbId);
  if (!maps.length) return s;
  const first = maps.find((mp) => mp.defaultSeason === 1 && mp.episodeOffset === 0) ?? maps[0];
  const e = anidb.get(first.aid);
  return { ...s, anidbIds: maps.map((mp) => mp.aid), titleRomaji: e?.romaji ?? e?.main, titleKanji: e?.kanji };
}
