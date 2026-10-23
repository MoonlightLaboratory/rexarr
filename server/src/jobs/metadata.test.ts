import { test } from 'node:test';
import assert from 'node:assert/strict';
import { embeddedTitle } from './metadata.js';

test('what goes inside the file is a name, not Rexarr’s notes', () => {
  // the bug this fixes: "disc rip" is the queue's note about where the file came from, and Jellyfin can be told
  // to show the embedded title instead of the episode it matched - so it was displayed to people
  assert.equal(embeddedTitle('Naruto', 'S01E01 · disc rip', 'clean'), 'Naruto - S01E01');
  assert.equal(embeddedTitle('Naruto', 'S01E01 · download', 'clean'), 'Naruto - S01E01');
  assert.equal(embeddedTitle('Naruto', 'S01E01', 'clean'), 'Naruto - S01E01');

  // a subtitle that is a file name rather than an episode has no place beside the show
  assert.equal(embeddedTitle('Naruto', 'Disc rip · t03.mkv', 'clean'), 'Naruto');
  assert.equal(embeddedTitle('Blade Runner 2049 (2017)', undefined, 'clean'), 'Blade Runner 2049 (2017)');

  // and a file that is to say nothing says nothing
  assert.equal(embeddedTitle('Naruto', 'S01E01 · disc rip', 'none'), undefined);
  assert.equal(embeddedTitle('', 'S01E01 · disc rip', 'clean'), 'S01E01', 'no show is still better than nothing');
});
