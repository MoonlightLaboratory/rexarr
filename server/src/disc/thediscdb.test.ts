import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discMatches, parseDuration, parseSummary, seriesFolder, slugify, summaryToTitles } from './thediscdb.js';
import type { DiscTitle } from '../../../shared/types.js';

// a real disc summary from TheDiscDb, trimmed: data/series/1883 (2021)/2022-4k/disc01-summary.txt
const SUMMARY = `Name: 1883
Source file name: 00800.mpls
Duration: 1:06:55
Chapters count: 7
Size: 12.1 GB
Segment count: 1
Segment map: 1065
Type: Episode
Season: 1
Episode: 1
File name: 1883.S01.E01.1883.mkv

Name: Behind Us, A Cliff
Source file name: 00801.mpls
Duration: 0:59:12
Segment map: 1066
Type: Episode
Season: 1
Episode: 2

Name: Making 1883
Source file name: 01085.m2ts
Duration: 0:12:30
Type: Featurette
`;

const title = (id: number, sourceFile: string, durationSeconds: number): DiscTitle =>
  ({ id, name: `Title ${id}`, durationSeconds, sourceFile, sizeBytes: 0, chapters: 0, fileName: '', audio: [], subtitles: [] }) as DiscTitle;

test('a disc summary is read as what each title is', () => {
  const s = parseSummary(SUMMARY);
  assert.equal(s.length, 3);
  assert.deepEqual(s[0], { name: '1883', sourceFile: '00800.mpls', segmentMap: '1065', durationSeconds: 4015, type: 'Episode', season: 1, episode: 1 });
  assert.equal(s[2].type, 'Featurette');
  assert.equal(s[2].season, undefined, 'an extra has no episode number to take');

  // hours are not padded, and a block without a source file has nothing to match on
  assert.equal(parseDuration('1:06:55'), 4015);
  assert.equal(parseDuration('0:12:30'), 750);
  assert.equal(parseSummary('Name: Nothing\nDuration: 0:01:00\n').length, 0);
});

test('the summary becomes the mapping Rexarr already applies', () => {
  assert.deepEqual(summaryToTitles(parseSummary(SUMMARY)), {
    '00800.mpls': 'S01E01',
    '00801.mpls': 'S01E02',
    '01085.m2ts': 'extra:featurette',
  });
});

test('a disc is matched on its shape, not its label', () => {
  const theirs = parseSummary(SUMMARY);
  const ours = [title(0, '00800.mpls', 4015), title(1, '00801.mpls', 3552), title(2, '01085.m2ts', 750)];
  assert.equal(discMatches(ours, theirs), true);

  // MakeMKV rounds, and a re-authoring moves a second or two
  assert.equal(discMatches(ours.map((t) => ({ ...t, durationSeconds: t.durationSeconds + 3 })), theirs), true);
});

test('two discs of one season are not the same disc', () => {
  // This is the case that makes duration necessary rather than nice: 1883 disc 1 and disc 2 are pressed from
  // the same template and hold the very same playlist numbers. On playlists alone, disc 2 would be numbered as
  // disc 1 and nobody would be told.
  const theirs = parseSummary(SUMMARY);
  const sameNamesDifferentShow = [title(0, '00800.mpls', 2800), title(1, '00801.mpls', 2750), title(2, '01085.m2ts', 600)];
  assert.equal(discMatches(sameNamesDifferentShow, theirs), false);

  // and a disc that shares nothing is plainly not it
  assert.equal(discMatches([title(0, '00100.mpls', 4015), title(1, '00101.mpls', 3552)], theirs), false);
});

test('too little to compare is not a match', () => {
  const theirs = parseSummary(SUMMARY);
  assert.equal(discMatches([title(0, '00800.mpls', 4015)], theirs), false, 'one title in common is a coincidence');
  assert.equal(discMatches([], theirs), false);
  assert.equal(discMatches([title(0, '00800.mpls', 4015), title(1, '00801.mpls', 3552)], []), false);
});

test('a series is found where TheDiscDb files it', () => {
  assert.equal(seriesFolder('Breaking Bad', 2008), 'Breaking Bad (2008)');
  assert.equal(seriesFolder('1883', 2021), '1883 (2021)');
  assert.equal(seriesFolder('Firefly'), 'Firefly');
  assert.equal(slugify('Breaking Bad (2008)'), 'breaking-bad-2008');
  assert.equal(slugify('1883 (2021)'), '1883-2021');
});
