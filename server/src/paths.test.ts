import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toArrPath, toLocalPath } from './paths.js';

const maps = [
  { remote: '/data/media', local: '/mnt/nas/media' },
  { remote: '/data/media/anime', local: '/mnt/anime' },
  { remote: 'D:\\Media', local: '/Volumes/Media' },
];

test('maps arr paths to local paths with longest prefix', () => {
  assert.equal(toLocalPath('/data/media/Movies/A (2020)/A.mkv', maps), '/mnt/nas/media/Movies/A (2020)/A.mkv');
  assert.equal(toLocalPath('/data/media/anime/Show/S01E01.mkv', maps), '/mnt/anime/Show/S01E01.mkv');
  assert.equal(toLocalPath('/other/file.mkv', maps), '/other/file.mkv');
  assert.equal(toLocalPath('D:\\Media\\Movies\\A.mkv', maps), '/Volumes/Media/Movies/A.mkv');
});

test('does not match partial directory names', () => {
  assert.equal(toLocalPath('/data/mediaX/file.mkv', maps), '/data/mediaX/file.mkv');
});

test('reverse mapping', () => {
  assert.equal(toArrPath('/mnt/anime/Show/ep.mkv', maps), '/data/media/anime/Show/ep.mkv');
  assert.equal(toArrPath('/mnt/nas/media/Movies/a.mkv', maps), '/data/media/Movies/a.mkv');
});
