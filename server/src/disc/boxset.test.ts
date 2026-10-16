import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batchProgress, boxSetName, discPhase, episodeNumbers, episodeRange, sameSet, sortDiscs } from '../../../shared/boxset.js';
import type { DiscRip, RipMedia } from '../../../shared/types.js';

const media = (m: Partial<RipMedia> = {}): RipMedia => ({ kind: 'series', title: 'Naruto', seasonNumber: 1, ...m });

const rip = (r: Partial<DiscRip> = {}): DiscRip =>
  ({
    id: r.id ?? 'x',
    driveIndex: 0,
    source: 'disc:0',
    drivePath: '',
    driveName: '',
    label: '',
    volumeName: '',
    discType: 'dvd',
    status: 'ready',
    media: media(),
    titles: [],
    selectedTitleIds: [],
    options: { transcode: false, deliver: false, eject: false, keepRaw: false },
    files: [],
    progress: { percent: 0, step: '', titleIndex: 0, titleCount: 0 },
    log: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...r,
  }) as DiscRip;

test('a set is one season of one series', () => {
  // the library id decides when both discs have one
  assert.equal(sameSet(media({ arrId: 1 }), media({ arrId: 1 })), true);
  assert.equal(sameSet(media({ arrId: 1 }), media({ arrId: 2 })), false, 'different series, whatever the labels say');
  assert.equal(sameSet(media({ arrId: 1, title: 'Naruto' }), media({ arrId: 2, title: 'Naruto' })), false);

  // seasons of one series are separate sets
  assert.equal(sameSet(media({ arrId: 1, seasonNumber: 1 }), media({ arrId: 1, seasonNumber: 2 })), false);

  // before identification the label is all there is, and punctuation differs more than the words do
  assert.equal(sameSet(media({ title: 'My Teen Romantic Comedy SNAFU' }), media({ title: 'my teen romantic comedy snafu' })), true);
  assert.equal(sameSet(media({ title: 'Naruto' }), media({ title: 'Bleach' })), false);

  // only series are gathered into sets
  assert.equal(sameSet(media({ kind: 'movie' }), media({ kind: 'movie' })), false);
  assert.equal(sameSet(media({ kind: 'unknown', title: '' }), media({ kind: 'unknown', title: '' })), false, 'an unread disc matches nothing');
});

test('a set is named after what is in it', () => {
  assert.equal(boxSetName(media({ seasonNumber: 1 })), 'Naruto - Season 1 box set');
  assert.equal(boxSetName(media({ seasonNumber: 0 })), 'Naruto - Specials box set');
  assert.equal(boxSetName(media({ seasonNumber: undefined })), 'Naruto box set');
});

test('a disc reports the episodes it holds', () => {
  const r = rip({ episodeMap: { 0: 7, 1: 8, 2: 9, 3: 10 }, selectedTitleIds: [0, 1, 2, 3] });
  assert.deepEqual(episodeNumbers(r), [7, 8, 9, 10]);
  assert.deepEqual(episodeRange(r), { from: 7, to: 10 });

  // a title the user has unselected is no longer on the disc's running order
  const trimmed = rip({ episodeMap: { 0: 7, 1: 8, 2: 9, 3: 10 }, selectedTitleIds: [0, 1] });
  assert.deepEqual(episodeRange(trimmed), { from: 7, to: 8 });

  // and a disc that has not been worked out yet says nothing rather than guessing
  assert.equal(episodeRange(rip()), null);
  assert.equal(episodeRange(rip({ episodeMap: {} })), null);
});

test('a disc phase is coarser than a rip status', () => {
  assert.equal(discPhase('inserted'), 'waiting');
  assert.equal(discPhase('scanning'), 'waiting');
  assert.equal(discPhase('ready'), 'waiting');
  assert.equal(discPhase('ripping'), 'ripping');
  assert.equal(discPhase('transcoding'), 'remuxing');
  assert.equal(discPhase('delivering'), 'remuxing');
  assert.equal(discPhase('done'), 'done');
  assert.equal(discPhase('failed'), 'failed');
});

test('a set reports its own progress, counting every disc equally', () => {
  assert.deepEqual(batchProgress([]), { percent: 0, done: 0, total: 0 });

  const done = rip({ id: 'a', status: 'done' });
  const half = rip({ id: 'b', status: 'ripping', progress: { percent: 50, step: '', titleIndex: 0, titleCount: 0 } });
  const waiting = rip({ id: 'c', status: 'ready' });
  assert.deepEqual(batchProgress([done, half, waiting]), { percent: 50, done: 1, total: 3 });

  // a disc that failed has written nothing towards the set, and must not read as progress
  assert.deepEqual(batchProgress([done, rip({ id: 'd', status: 'failed', progress: { percent: 90, step: '', titleIndex: 0, titleCount: 0 } })]), { percent: 50, done: 1, total: 2 });
  assert.equal(batchProgress([done, done]).percent, 100);
});

test('discs are ordered by disc number, and an unnumbered one is not hidden', () => {
  const d2 = rip({ id: 'd2', media: media({ discNumber: 2 }) });
  const d1 = rip({ id: 'd1', media: media({ discNumber: 1 }) });
  const dx = rip({ id: 'dx', media: media({ discNumber: undefined }) });
  assert.deepEqual(sortDiscs([d2, dx, d1]).map((r) => r.id), ['d1', 'd2', 'dx']);
});
