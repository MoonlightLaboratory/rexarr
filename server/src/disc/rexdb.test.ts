import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DiscTitle, RexDbEntry } from '../../../shared/types.js';
import { applyEntry, discStructure, fingerprint, titleKey } from './rexdb.js';

const title = (id: number, durationSeconds: number, sourceFile?: string): DiscTitle =>
  ({ id, name: `Title ${id}`, durationSeconds, sizeBytes: 1, chapters: 0, fileName: `t0${id}.mkv`, sourceFile, audio: [], subtitles: [] }) as DiscTitle;

test('the fingerprint is the one RexDB defines, to the character', () => {
  // The worked example in RexDB's FINGERPRINT.md. If this ever disagrees, the two halves do not share a
  // database at all - every disc misses - so it is pinned here rather than left to drift.
  assert.equal(
    fingerprint('SERIES_VOL_2', [
      { key: '00001.mpls', seconds: 1416 },
      { key: '00002.mpls', seconds: 1418 },
    ]),
    '2dc06a4d8266f60a',
  );
});

test('the label is normalised, and the structure is not', () => {
  const titles = [{ key: '0', seconds: 100 }];
  // punctuation and case in a label are noise: the same disc read by two drives must hash the same
  const want = fingerprint('SWORD_ART_ONLINE_2_P4', titles);
  assert.equal(fingerprint('sword art online 2 p4', titles), want);
  assert.equal(fingerprint('Sword-Art-Online 2 P4', titles), want);
  // a second of difference is a different disc as far as the hash goes, which is why near misses exist
  assert.notEqual(fingerprint('SWORD_ART_ONLINE_2_P4', [{ key: '0', seconds: 101 }]), want);
  // and two different pressings with the same structure stay apart
  assert.notEqual(fingerprint('OTHER_LABEL', titles), want);
});

test('a title is keyed by its playlist, or its index when the disc gives none', () => {
  assert.equal(titleKey({ id: 3, sourceFile: '00002.mpls' }), '00002.mpls');
  assert.equal(titleKey({ id: 3, sourceFile: '00002.MPLS' }), '00002.mpls');
  // every DVD: MakeMKV reports no source file, so the title number is the key
  assert.equal(titleKey({ id: 3, sourceFile: undefined }), '3');
  assert.equal(titleKey({ id: 0, sourceFile: '  ' }), '0');
  assert.deepEqual(discStructure([title(0, 1416), title(1, 1418.9, '00002.mpls')]), [
    { key: '0', seconds: 1416 },
    { key: '00002.mpls', seconds: 1418 },
  ]);
});

const entry = (titles: Record<string, string>): RexDbEntry => ({ path: 'x', status: 'verified', disc_name: 'D', titles });

test('an entry becomes the episode map, the roles and what to leave out', () => {
  const titles = [title(0, 1416), title(1, 1416), title(2, 1416), title(3, 1416)];
  const m = applyEntry(entry({ '0': 'S02E08', '1': 'S02E09', '2': 'S00E12', '3': 'playall' }), titles);
  assert.deepEqual(m.episodeMap, { 0: 8, 1: 9 });
  assert.deepEqual(m.titleRoles['2'], { kind: 'special', episode: 12 });
  assert.deepEqual(m.skip, [3], 'the play-all compilation is not ripped');
  assert.equal(m.seasonNumber, 2);
  assert.equal(m.episodeStart, 8);
  assert.match(m.summary, /episodes 8-9/);
  assert.match(m.summary, /1 special/);
});

test('a title the entry does not mention is left exactly as it was', () => {
  // an entry that only knows half a disc must not blank the other half
  const m = applyEntry(entry({ '0': 'S01E01' }), [title(0, 100), title(1, 100), title(2, 100)]);
  assert.deepEqual(Object.keys(m.episodeMap), ['0']);
  assert.deepEqual(Object.keys(m.titleRoles), ['0']);
  assert.deepEqual(m.skip, []);
});

test('an episode range, an extra, and a value that means nothing', () => {
  const titles = [title(0, 100), title(1, 100), title(2, 100)];
  const m = applyEntry(entry({ '0': 'S01E04-E05', '1': 'extra:op', '2': 'nonsense' }), titles);
  assert.equal(m.episodeMap[0], 4, 'a double starts at the first of the two');
  assert.deepEqual(m.titleRoles['1'], { kind: 'extra', type: 'op' });
  assert.equal(m.titleRoles['2'], undefined, 'a value Rexarr does not understand changes nothing');
});
