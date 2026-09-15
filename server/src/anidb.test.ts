import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTitle, parseMappings, parseTitles } from './anidb.js';

const titlesXml = `<?xml version="1.0" encoding="UTF-8"?>
<animetitles>
<anime aid="1">
<title type="main" xml:lang="x-jat">Seikai no Monshou</title>
<title xml:lang="ja" type="official">星界の紋章</title>
<title xml:lang="en" type="official">Crest of the Stars</title>
<title xml:lang="en" type="syn">CotS</title>
</anime>
<anime aid="4563">
<title xml:lang="x-jat" type="main">Suzumiya Haruhi no Yuuutsu</title>
<title xml:lang="en" type="official">The Melancholy of Haruhi Suzumiya</title>
<title xml:lang="x-jat" type="short">Haruhi</title>
</anime>
<anime aid="10">
<title xml:lang="x-jat" type="main">Tenshi no Tamago</title>
<title xml:lang="en" type="official">Angel&apos;s Egg</title>
</anime>
</animetitles>`;

const mappingXml = `<?xml version="1.0" encoding="UTF-8"?>
<anime-list>
  <anime anidbid="1" tvdbid="79776" defaulttvdbseason="1" episodeoffset="0"><name>Seikai no Monshou</name></anime>
  <anime anidbid="4563" tvdbid="79571" defaulttvdbseason="1" episodeoffset="0" tmdbtv="30991"><name>Suzumiya Haruhi no Yuuutsu</name></anime>
  <anime anidbid="17785" tvdbid="405920" defaulttvdbseason="0" tmdbid="1062807" imdbid="tt26684398"><name>Gekijouban Spy x Family Code: White</name></anime>
  <anime anidbid="6400" tvdbid="79571" defaulttvdbseason="2" episodeoffset="14"><name>Suzumiya Haruhi no Yuuutsu (2009)</name></anime>
  <anime anidbid="10" tvdbid="movie" imdbid="tt0089226" tmdbid="27829"><name>Tenshi no Tamago</name></anime>
  <anime anidbid="99" tvdbid="unknown"><name>Nothing</name></anime>
</anime-list>`;

test('parseTitles extracts main / romaji / kanji / english / synonyms', () => {
  const t = parseTitles(titlesXml);
  assert.equal(t.size, 3);
  const e = t.get(1)!;
  assert.equal(e.main, 'Seikai no Monshou');
  assert.equal(e.romaji, 'Seikai no Monshou');
  assert.equal(e.kanji, '星界の紋章');
  assert.equal(e.english, 'Crest of the Stars');
  assert.deepEqual(e.synonyms, ['CotS']);
  assert.equal(t.get(10)!.english, "Angel's Egg");
});

test('parseMappings reads TVDB series with offsets and movies', () => {
  const m = parseMappings(mappingXml);
  assert.equal(m.get(1)!.tvdbId, 79776);
  assert.equal(m.get(6400)!.defaultSeason, 2);
  assert.equal(m.get(6400)!.episodeOffset, 14);
  assert.equal(m.get(4563)!.isMovie, false);
  const movie = m.get(10)!;
  assert.equal(movie.isMovie, true);
  assert.equal(movie.tvdbId, undefined);
  assert.equal(movie.imdbId, 'tt0089226');
  assert.equal(movie.tmdbId, 27829);
  assert.equal(m.get(99)!.isMovie, false);
  // a movie mapped into a TVDB season 0 still counts as a movie
  assert.equal(m.get(17785)!.isMovie, true);
  assert.equal(m.get(17785)!.tvdbId, 405920);
});

test('normalizeTitle strips punctuation, accents and articles', () => {
  assert.equal(normalizeTitle('The Melancholy of Haruhi Suzumiya!'), 'melancholy of haruhi suzumiya');
  assert.equal(normalizeTitle('SHINGEKI_NO_KYOJIN'), 'shingeki no kyojin');
  assert.equal(normalizeTitle('Pokémon: Advanced'), 'pokemon advanced');
});
