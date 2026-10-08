import assert from 'node:assert/strict';
import test from 'node:test';
import { groupEpisodes, upgradeFrom } from './wanted.js';

test('what kind of disc would actually improve what is on disk', () => {
  assert.equal(upgradeFrom('DVD').with, 'bluray');
  assert.equal(upgradeFrom('SDTV').with, 'bluray');
  assert.equal(upgradeFrom('HDTV-720p').with, 'bluray');
  assert.equal(upgradeFrom('WEBDL-1080p').with, 'bluray', 'a remux beats a web encode');
  assert.equal(upgradeFrom('Bluray-1080p').with, 'bluray');
  assert.equal(upgradeFrom('Remux-1080p').with, 'uhd', 'a Blu-ray would give the same file again');
  assert.equal(upgradeFrom('Bluray-2160p').with, 'uhd');
  assert.equal(upgradeFrom('Remux-2160p').with, 'none', 'nothing on a shelf beats this');
  assert.equal(upgradeFrom(undefined).with, 'bluray');
  assert.equal(upgradeFrom(undefined).from, 'nothing on disk');
});

test('episodes are grouped into the season you would put in the drive', () => {
  const rows = groupEpisodes([
    { seriesId: 7, seriesTitle: 'Naruto', tvdbId: 78857, seasonNumber: 3, episodeNumber: 45, quality: 'DVD' },
    { seriesId: 7, seriesTitle: 'Naruto', tvdbId: 78857, seasonNumber: 3, episodeNumber: 46, quality: 'DVD' },
    { seriesId: 7, seriesTitle: 'Naruto', tvdbId: 78857, seasonNumber: 4, episodeNumber: 1, quality: 'HDTV-720p' },
    { seriesId: 9, seriesTitle: 'Frieren', tvdbId: 424536, seasonNumber: 1, episodeNumber: 5, quality: 'WEBDL-1080p' },
  ]);
  assert.equal(rows.length, 3, 'two Naruto seasons and one Frieren');
  const s3 = rows.find((r) => r.title === 'Naruto' && r.seasonNumber === 3)!;
  assert.equal(s3.episodes, 2);
  assert.equal(s3.quality, 'DVD');
  assert.equal(s3.upgradeWith, 'bluray');
  assert.equal(s3.externalId, 78857);
  assert.equal(rows.find((r) => r.title === 'Frieren')!.episodes, 1);
});

test('a season is judged by its worst episode', () => {
  const [row] = groupEpisodes([
    { seriesId: 1, seriesTitle: 'Show', seasonNumber: 1, episodeNumber: 1, quality: 'Bluray-1080p' },
    { seriesId: 1, seriesTitle: 'Show', seasonNumber: 1, episodeNumber: 2, quality: 'SDTV' },
  ]);
  assert.equal(row.episodes, 2);
  assert.match(row.quality, /^SDTV/, 'the worst one is what you would fix');
  assert.match(row.quality, /and others/, 'and it says the season is mixed');
});
