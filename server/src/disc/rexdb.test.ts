import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DiscTitle, RexDbEntry } from '../../../shared/types.js';
import { applyEntry, buildEntry, contributionUrl, discStructure, fingerprint, titleKey } from './rexdb.js';

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

test('a corrected disc becomes an entry somebody could send', () => {
  const rip = {
    label: 'Sword Art Online S2 P4',
    volumeName: 'Sword Art Online S2 P4',
    titles: [title(0, 1417), title(1, 1417), title(2, 1416), title(3, 1419), title(4, 1418)],
    media: { kind: 'series', title: 'Sword Art Online', year: 2012, externalId: 259640, seasonNumber: 2, discNumber: 4 },
    episodeMap: { 0: 20, 1: 21, 2: 22, 3: 23, 4: 24 },
    titleRoles: {},
  } as unknown as Parameters<typeof buildEntry>[0];
  const entry = buildEntry(rip) as Record<string, unknown>;
  assert.ok(entry);
  // the fingerprint is the one the live disc produced, so an entry built here is findable by the next person
  assert.equal(entry.fingerprint, '195b057e41397300');
  assert.deepEqual(entry.titles, { '0': 'S02E20', '1': 'S02E21', '2': 'S02E22', '3': 'S02E23', '4': 'S02E24' });
  assert.equal(entry.status, 'unverified', 'you do not mark your own reading verified');
  assert.equal(entry.confirmations, 1);
  assert.deepEqual(entry.series, { title: 'Sword Art Online', year: 2012, tvdb: 259640 });
});

test('specials, extras and the play-all title are written as RexDB spells them', () => {
  const rip = {
    label: 'D',
    volumeName: 'D',
    titles: [title(0, 100), title(1, 100), title(2, 100), title(3, 900)],
    media: { kind: 'series', title: 'X', externalId: 1, seasonNumber: 2 },
    episodeMap: { 0: 8 },
    titleRoles: { '1': { kind: 'special', episode: 12 }, '2': { kind: 'extra', type: 'op' } },
    playAllTitleIds: [3],
  } as unknown as Parameters<typeof buildEntry>[0];
  const entry = buildEntry(rip) as { titles: Record<string, string> };
  assert.deepEqual(entry.titles, { '0': 'S02E08', '1': 'S00E12', '2': 'extra:op', '3': 'playall' });
});

test('the contribution link carries the entry and nothing else', () => {
  const url = contributionUrl({ disc_name: 'DISC', fingerprint: 'abcdef0123456789' });
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, 'https://github.com/MoonlightLaboratory/rexarr/issues/new');
  assert.equal(parsed.searchParams.get('title'), 'RexDB: DISC');
  assert.match(parsed.searchParams.get('body') ?? '', /discs\/ab\/abcdef0123456789\.json/);
});
