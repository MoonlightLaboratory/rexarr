import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Where disc N of a set starts. The manager's own method needs the manager, so this pins the two rules it
 * follows; they are the whole of the decision.
 */
function guess(opts: { discNumber: number; episodeCount: number; earlier: number[][] }): number {
  const highest = Math.max(0, ...opts.earlier.flat());
  if (highest > 0) return highest + 1;
  return (opts.discNumber - 1) * opts.episodeCount + 1;
}

test('with earlier discs of the same set ripped, it carries on from them', () => {
  // Sword Art Online S2: P1 was 1-7, P2 was 8-14. P3 then starts at 15, whatever its own episode count.
  assert.equal(guess({ discNumber: 3, episodeCount: 5, earlier: [[1, 2, 3, 4, 5, 6, 7], [8, 9, 10, 11, 12, 13, 14]] }), 15);
  // the uniform assumption would have said 11 here, which is what makes this worth doing
  assert.notEqual(guess({ discNumber: 3, episodeCount: 5, earlier: [[1, 2, 3, 4, 5, 6, 7], [8, 9, 10, 11, 12, 13, 14]] }), 11);
});

test('with nothing to go on it assumes equal discs, which is a guess and is flagged as one', () => {
  assert.equal(guess({ discNumber: 2, episodeCount: 6, earlier: [] }), 7);
  assert.equal(guess({ discNumber: 4, episodeCount: 5, earlier: [] }), 16);
  // and the real set was 7 + 7 + 5 + 5, so disc 4 starts at 20 - the number above is why it must say it guessed
  assert.notEqual(guess({ discNumber: 4, episodeCount: 5, earlier: [] }), 20);
});

test('disc 1 is never guessed at', () => {
  assert.equal(guess({ discNumber: 1, episodeCount: 7, earlier: [] }), 1);
});
