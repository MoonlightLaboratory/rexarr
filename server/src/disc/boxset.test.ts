import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batchProgress, boxSetName, discFreed, discPhase, driveBusy, episodeNumbers, episodeRange, expectedDiscCount, missingDiscs, nextWantedDisc, sameSet, sortDiscs } from '../../../shared/boxset.js';
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

test('a disc is free to come out once its copy is made, not once it is encoded', () => {
  // the rip is the only part that needs the disc; waiting for the encode idles the drive for nothing
  assert.equal(discFreed(rip({ status: 'transcoding' })), true);
  assert.equal(discFreed(rip({ status: 'delivering' })), true);
  assert.equal(discFreed(rip({ status: 'done' })), true);
  assert.equal(discFreed(rip({ status: 'ripping' })), false);
  assert.equal(discFreed(rip({ status: 'ready' })), false);

  // and nothing comes out of a drive that is still reading
  assert.equal(driveBusy(rip({ status: 'scanning' })), true);
  assert.equal(driveBusy(rip({ status: 'ripping' })), true);
  assert.equal(driveBusy(rip({ status: 'transcoding' })), false);
  assert.equal(driveBusy(undefined), false);
});

test('how many discs a set holds is arithmetic, and a pinned count wins', () => {
  const d1 = rip({ id: 'a', media: media({ discNumber: 1 }), episodeMap: { 0: 1, 1: 2, 2: 3, 3: 4, 4: 5 }, selectedTitleIds: [0, 1, 2, 3, 4] });
  const d2 = rip({ id: 'b', media: media({ discNumber: 2 }), episodeMap: { 0: 6, 1: 7, 2: 8, 3: 9 }, selectedTitleIds: [0, 1, 2, 3] });

  // 35 episodes at 4.5 a disc is 8 discs - the real Naruto season this was built against
  assert.equal(expectedDiscCount([d1, d2], 35), 8);

  // with nothing to divide, all that is known is the discs in hand
  assert.equal(expectedDiscCount([d1, d2], 0), 2);
  assert.equal(expectedDiscCount([], 35), undefined);

  // a count set by hand is not second-guessed
  const pinned = rip({ id: 'c', media: media({ discNumber: 1 }), episodeMap: { 0: 1 }, selectedTitleIds: [0], batch: { id: 'x', name: 'Set', expectedDiscs: 4, discsPinned: true } });
  assert.equal(expectedDiscCount([pinned], 35), 4);
});

test('a set knows which discs are still missing, and which to ask for next', () => {
  const d1 = rip({ id: 'a', media: media({ discNumber: 1 }) });
  const d3 = rip({ id: 'c', media: media({ discNumber: 3 }) });
  assert.deepEqual(missingDiscs([d1, d3], 4), [2, 4]);
  assert.deepEqual(missingDiscs([d1, d3], undefined), [], 'nothing is missing from a set of unknown size');

  // two drives emptied at once must not both be told to wait for disc 2
  assert.equal(nextWantedDisc([d1, d3], 4), 2);
  assert.equal(nextWantedDisc([d1, d3], 4, [2]), 4);
  // and past the end of the set, the next disc is simply the one after the last
  assert.equal(nextWantedDisc([d1, d3], 3, [2]), 4);
});

test("a set's progress follows the titles a disc writes, not its per-title percent", () => {
  // a five-title disc on its second title, a third of the way in, is not 33% done - it is a sixth
  const mid = rip({ id: 'm', status: 'ripping', progress: { percent: 33, step: '', titleIndex: 2, titleCount: 5 } });
  assert.equal(batchProgress([mid]).percent, 27);

  // the first title finishing is not the disc finishing, which is what the raw percent used to claim
  const firstDone = rip({ id: 'f', status: 'ripping', progress: { percent: 100, step: '', titleIndex: 1, titleCount: 5 } });
  assert.equal(batchProgress([firstDone]).percent, 20);

  // a single-title disc has nothing to weigh, so its own percent stands
  const single = rip({ id: 's', status: 'ripping', progress: { percent: 40, step: '', titleIndex: 1, titleCount: 1 } });
  assert.equal(batchProgress([single]).percent, 40);
});
