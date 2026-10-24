import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driveNote, driveReads, MAKEMKV_FORUM, readsLabel } from './capability.js';

test('what a drive reads is read off the name MakeMKV gives it', () => {
  // the two drives this was built against
  assert.equal(driveReads('DVD+R-DL TSSTcorp DVD+-RW TS-L633J D400 R8566GNB405125'), 'dvd');
  assert.equal(driveReads('DVD+R-DL HL-DT-ST DVDRAM GT50N LT20 M1BC6B45752'), 'dvd');
  // and a Blu-ray one
  assert.equal(driveReads('BD-RE HL-DT-ST BD-RE  WH16NS40 1.02'), 'bluray');
  assert.equal(driveReads('BD-ROM ASUS BW-16D1HT 3.02'), 'bluray');
  assert.equal(driveReads('CD-RW Generic'), 'cd');
  assert.equal(driveReads(''), 'unknown');
  assert.equal(readsLabel(driveReads('BD-RE HL-DT-ST')), 'Blu-ray');
});

test('a Blu-ray in a DVD drive is said outright, because nothing will fix it', () => {
  const note = driveNote({ name: 'DVD+R-DL HL-DT-ST DVDRAM GT50N' }, 'bluray');
  assert.match(note?.text ?? '', /reads DVDs only/);
  assert.match(note?.text ?? '', /no key or firmware will help/);
  assert.doesNotMatch(note?.text ?? '', /forum/, 'there is nothing on the forum that makes a DVD drive read Blu-ray');
  assert.equal(note?.decisive, true, 'nothing else is worth suggesting after this');
});

test('UHD is named as a firmware matter rather than guessed at', () => {
  const note = driveNote({ name: 'BD-RE HL-DT-ST WH16NS40' }, 'bluray');
  assert.match(note?.text ?? '', /4K UHD/);
  assert.match(note?.text ?? '', /firmware/);
  assert.ok(note?.text.includes(MAKEMKV_FORUM), 'and points at the list rather than inventing one');
  // it must not claim to know: a wrong "your drive cannot" stops someone trying what would have worked
  assert.doesNotMatch(note?.text ?? '', /your drive cannot|this drive cannot/i);
  assert.equal(note?.decisive, false, 'it is a possibility, so the other causes still matter');
});

test('the drive is only blamed when it is the likely reason', () => {
  assert.equal(driveNote({ name: 'DVD+R-DL HL-DT-ST DVDRAM GT50N' }, 'dvd'), undefined, 'a DVD in a DVD drive is not the drive’s fault');
  assert.equal(driveNote({ name: 'BD-RE HL-DT-ST' }, 'dvd'), undefined);
  assert.equal(driveNote(undefined, 'bluray'), undefined, 'an unknown drive is not evidence');
});
