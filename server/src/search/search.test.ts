import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Release } from '../../../shared/types.js';
import { parseQuery, titleScore } from './query.js';
import { rankReleases, releaseCategory, releaseTags } from './releaseInfo.js';

test('parseQuery pulls release wishes, year and episodes out of the title', () => {
  const a = parseQuery('Blade Runner 2049 2160p remux dv');
  assert.equal(a.title, 'Blade Runner 2049');
  assert.equal(a.year, undefined);
  assert.deepEqual(a.wants, { resolution: 2160, category: 'remux', dolbyVision: true });

  const b = parseQuery('frieren s01e05');
  assert.deepEqual([b.title, b.kind, b.season, b.episode], ['frieren', 'series', 1, 5]);

  const c = parseQuery('Himouto! Umaru-chan Season 2 bluray');
  assert.deepEqual([c.title, c.season, c.episode, c.wants.category], ['Himouto! Umaru-chan', 2, undefined, 'bluray']);

  const d = parseQuery('Dune (2021) 4k hdr');
  assert.deepEqual([d.title, d.year, d.wants.resolution, d.wants.hdr], ['Dune', 2021, 2160, true]);

  assert.deepEqual([parseQuery('1917').title, parseQuery('1917').year], ['1917', undefined]);
  assert.equal(parseQuery('2001: A Space Odyssey').title, '2001: A Space Odyssey');
  assert.equal(parseQuery('The Truman Show').title, 'The Truman Show');
  assert.equal(parseQuery("Charlotte's Web").title, "Charlotte's Web");
  assert.equal(parseQuery("Charlotte's Web 1080p web").wants.category, 'web');
  assert.equal(parseQuery('Akira complete bluray iso').wants.category, 'disc');
  assert.deepEqual([parseQuery('movie: heat').kind, parseQuery('movie: heat').title], ['movie', 'heat']);
  assert.equal(parseQuery('tt1856101').imdbId, 'tt1856101');
  assert.deepEqual([parseQuery('tvdb:81797').tvdbId, parseQuery('tvdb:81797').kind], [81797, 'series']);
  assert.deepEqual([parseQuery('Bocchi the Rock - 05').absoluteEpisode, parseQuery('Bocchi the Rock - 05').title], [5, 'Bocchi the Rock']);
  assert.deepEqual([parseQuery('Breaking Bad 3x07').season, parseQuery('Breaking Bad 3x07').episode], [3, 7]);
});

test('titleScore is typo and partial tolerant', () => {
  assert.equal(titleScore('the matrix', 'The Matrix'), 100);
  assert.ok(titleScore('matrix', 'The Matrix Reloaded') >= 70);
  assert.ok(titleScore('umaru', 'Himouto! Umaru-chan') >= 50);
  assert.ok(titleScore('frieren', 'Frieren: Beyond Journey’s End') >= 70);
  assert.ok(titleScore('bocchi rock', 'Bocchi the Rock!') >= 75);
  assert.ok(titleScore('interstelar', 'Interstellar') >= 70, 'one typo');
  assert.ok(titleScore('spiderman', 'Spider-Man') >= 90, 'spacing');
  assert.ok(titleScore('matrix', 'Mad Max') < 45);
});

const rel = (title: string, over: Partial<Release> = {}): Release => ({
  guid: title,
  indexerId: 1,
  indexer: 'x',
  title,
  size: 10e9,
  quality: '',
  resolution: /2160p/.test(title) ? 2160 : /1080p/.test(title) ? 1080 : 0,
  isRemux: /remux/i.test(title),
  seeders: 10,
  leechers: 0,
  protocol: 'torrent',
  ageDays: 10,
  languages: [],
  approved: true,
  rejections: [],
  source: 'radarr',
  ...over,
});

test('release categories and tags', () => {
  assert.equal(releaseCategory(rel('Movie.2020.1080p.BluRay.REMUX.AVC')), 'remux');
  assert.equal(releaseCategory(rel('Movie.2020.COMPLETE.BLURAY', { isDisc: true })), 'disc');
  assert.equal(releaseCategory(rel('Movie.2020.1080p.BluRay.x264-GRP')), 'bluray');
  assert.equal(releaseCategory(rel('Movie.2020.2160p.AMZN.WEB-DL.DDP5.1', { quality: 'WEBDL-2160p' })), 'web');
  assert.equal(releaseCategory(rel('Show.S01E01.720p.HDTV.x264')), 'hdtv');
  assert.equal(releaseCategory(rel('Movie.2020.DVDRip.XviD')), 'dvd');
  assert.equal(releaseCategory(rel('[SubsPlease] Sousou no Frieren - 05 (1080p)', { quality: 'HDTV-1080p' })), 'web');
  assert.equal(releaseCategory(rel('Sousou.no.Frieren.S01E05.Hulu.1080p.AV1.OPUS', { quality: 'HDTV-1080p' })), 'web');
  assert.deepEqual(releaseTags('Movie.2020.2160p.UHD.BluRay.REMUX.DV.HDR10.HEVC.TrueHD.7.1.Atmos-GRP'), ['DV', 'HDR', 'Atmos', 'TrueHD', 'HEVC']);
  assert.deepEqual(releaseTags('Show.S01.1080p.BluRay.x265.10bit.Dual.Audio.FLAC'), ['FLAC', 'HEVC', '10-bit', 'Dual audio']);
  assert.deepEqual(releaseTags('Movie.2020.2160p.WEB-DL.DDP5.1.HDR10+.HEVC'), ['HDR10+', 'DD+', 'HEVC']);
});

test('rankReleases prefers remux, then what the search asked for', () => {
  const list = [
    rel('Movie.2020.2160p.WEB-DL.HEVC', { quality: 'WEBDL-2160p', seeders: 500 }),
    rel('Movie.2020.1080p.BluRay.REMUX.AVC.DTS-HD.MA'),
    rel('Movie.2020.2160p.UHD.BluRay.REMUX.HEVC.TrueHD.Atmos'),
    rel('Movie.2020.1080p.BluRay.x264'),
    rel('Movie.2020.2160p.UHD.BluRay.REMUX.dead', { seeders: 0 }),
  ];
  assert.deepEqual(
    rankReleases([...list]).map((r) => r.title),
    ['Movie.2020.2160p.UHD.BluRay.REMUX.HEVC.TrueHD.Atmos', 'Movie.2020.1080p.BluRay.REMUX.AVC.DTS-HD.MA', 'Movie.2020.2160p.UHD.BluRay.REMUX.dead', 'Movie.2020.2160p.WEB-DL.HEVC', 'Movie.2020.1080p.BluRay.x264'],
  );
  // (a well-seeded 2160p WEB-DL is a better re-encode source than a 1080p x264 encode)
  // asking for 1080p moves the 1080p remux to the top
  assert.equal(rankReleases([...list], { query: parseQuery('movie 1080p') })[0].title, 'Movie.2020.1080p.BluRay.REMUX.AVC.DTS-HD.MA');
  // asking for web puts WEB first
  assert.equal(rankReleases([...list], { query: parseQuery('movie 2160p web-dl') })[0].title, 'Movie.2020.2160p.WEB-DL.HEVC');
  const top = rankReleases([...list])[0];
  // a different season in the title is pushed down for an episode search
  const eps = rankReleases([rel('[SubsPlease] Show S2 - 05 (1080p)', { seeders: 900 }), rel('[SubsPlease] Show - 05 (1080p)', { seeders: 20 })], { season: 1 });
  assert.equal(eps[0].title, '[SubsPlease] Show - 05 (1080p)');
  assert.ok(top.scoreReasons?.some((r) => r.includes('Remux')));
});
