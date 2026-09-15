import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DiscManager } from './manager.js';
import type { DiscTitle } from '../../../shared/types.js';

const t = (id: number, durationSeconds: number): DiscTitle => ({ id, name: `Title ${id}`, durationSeconds, sizeBytes: 0, chapters: 0, fileName: `t${id}.mkv`, audio: [], subtitles: [] });

test('detects a play-all title that equals the sum of the episodes', () => {
  const titles = [t(0, 4 * 1420), t(1, 1420), t(2, 1420), t(3, 1420), t(4, 1420)];
  assert.deepEqual(DiscManager.playAllTitles(titles), [0]);
});

test('detects play-all even when extras are present', () => {
  const titles = [t(0, 1420), t(1, 1420), t(2, 1420), t(3, 3 * 1420 + 10), t(4, 300)];
  assert.deepEqual(DiscManager.playAllTitles(titles), [3]);
});

test('no play-all on a movie disc', () => {
  assert.deepEqual(DiscManager.playAllTitles([t(0, 7200), t(1, 900), t(2, 600)]), []);
  assert.deepEqual(DiscManager.playAllTitles([t(0, 7200)]), []);
});
