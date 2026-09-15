import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toArrPath, toLocalPath } from './paths.js';

const maps = [
  { remote: '/data/media', local: '/mnt/nas/media' },
  { remote: '/data/media/anime', local: '/mnt/anime' },
  { remote: 'D:\\Media', local: '/Volumes/Media' },
];

test('maps arr paths to local paths with longest prefix', () => {
  assert.equal(toLocalPath('/data/media/Movies/A (2020)/A.mkv', undefined, maps), '/mnt/nas/media/Movies/A (2020)/A.mkv');
  assert.equal(toLocalPath('/data/media/anime/Show/S01E01.mkv', undefined, maps), '/mnt/anime/Show/S01E01.mkv');
  assert.equal(toLocalPath('/other/file.mkv', undefined, maps), '/other/file.mkv');
  assert.equal(toLocalPath('D:\\Media\\Movies\\A.mkv', undefined, maps), '/Volumes/Media/Movies/A.mkv');
});

test('does not match partial directory names', () => {
  assert.equal(toLocalPath('/data/mediaX/file.mkv', undefined, maps), '/data/mediaX/file.mkv');
});

test('reverse mapping', () => {
  assert.equal(toArrPath('/mnt/anime/Show/ep.mkv', undefined, maps), '/data/media/anime/Show/ep.mkv');
  assert.equal(toArrPath('/mnt/nas/media/Movies/a.mkv', undefined, maps), '/data/media/Movies/a.mkv');
});

test('app-scoped mappings: Radarr and Sonarr see the same share under different paths', () => {
  const m = [
    { remote: '/takidrive/Media', local: '/Volumes/Media', app: 'radarr' as const },
    { remote: '/media', local: '/Volumes/Media', app: 'sonarr' as const },
    { remote: '/anime', local: '/Volumes/Media/Anime', app: 'sonarr' as const },
  ];
  assert.equal(toLocalPath('/takidrive/Media/Anime Movies/Aura (2013)/a.mkv', 'radarr', m), '/Volumes/Media/Anime Movies/Aura (2013)/a.mkv');
  assert.equal(toLocalPath('/anime/Show (2024)/Season 01/e.mkv', 'sonarr', m), '/Volumes/Media/Anime/Show (2024)/Season 01/e.mkv');
  assert.equal(toLocalPath('/media/TV Shows/X/e.mkv', 'sonarr', m), '/Volumes/Media/TV Shows/X/e.mkv');
  // a Sonarr-only mapping must not rewrite a Radarr path
  assert.equal(toLocalPath('/media/whatever.mkv', 'radarr', m), '/media/whatever.mkv');
  // reverse: same local folder resolves to each app's own remote path
  assert.equal(toArrPath('/Volumes/Media/Movies/Rip (2020)', 'radarr', m), '/takidrive/Media/Movies/Rip (2020)');
  assert.equal(toArrPath('/Volumes/Media/TV Shows/Rip', 'sonarr', m), '/media/TV Shows/Rip');
  assert.equal(toArrPath('/Volumes/Media/Anime/Rip', 'sonarr', m), '/anime/Rip');
  assert.equal(toArrPath('/Volumes/Media/Anime Movies/Rip', 'radarr', m), '/takidrive/Media/Anime Movies/Rip');
});
