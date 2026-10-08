import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanProductTitle, guessKind, normaliseCode, toExpected } from './barcode.js';

test('a barcode is digits, however it was typed', () => {
  assert.equal(normaliseCode('0 24543-70249 7'), '024543702497');
  assert.equal(normaliseCode('5051892-239-349'), '5051892239349');
  assert.equal(normaliseCode('12345'), null, 'too short');
  assert.equal(normaliseCode('012345678901234567'), null, 'too long');
  assert.equal(normaliseCode(''), null);
});

test('shop listings lose their edition noise', () => {
  assert.deepEqual(cleanProductTitle('Blade Runner 2049 [4K Ultra HD + Blu-ray] (2017)'), { title: 'Blade Runner 2049', year: 2017, seasonNumber: undefined }, 'a year in the title is part of the title');
  assert.deepEqual(cleanProductTitle('1917 [Blu-ray]'), { title: '1917', year: undefined, seasonNumber: undefined });
  assert.deepEqual(cleanProductTitle('Frieren: Beyond Journey’s End - Season 1 [Blu-ray]'), { title: 'Frieren: Beyond Journey’s End', year: undefined, seasonNumber: 1 });
  assert.deepEqual(cleanProductTitle('The Matrix (DVD, Widescreen, Region 1)'), { title: 'The Matrix', year: undefined, seasonNumber: undefined });
  assert.deepEqual(cleanProductTitle('Cowboy Bebop: The Complete Series (Blu-ray, 4 Disc)'), { title: 'Cowboy Bebop', year: undefined, seasonNumber: undefined });
});

test('shop listings keep going: slipcovers, sealed copies, shipping blurb', () => {
  assert.equal(cleanProductTitle('Reign Of The Supermen (4k Ultra Hd + Blu-ray + Digital) Sealed With Slipcover').title, 'Reign Of The Supermen');
  assert.equal(cleanProductTitle('Dune 2021 Blu-ray + Digital, Brand New, Free Shipping').title, 'Dune 2021');
});

test('a title with nothing to strip is left alone', () => {
  assert.deepEqual(cleanProductTitle('Akira'), { title: 'Akira', year: undefined, seasonNumber: undefined });
});

test('what kind of disc the listing sounds like', () => {
  assert.equal(guessKind('Blade Runner 2049 [Blu-ray]'), 'movie');
  assert.equal(guessKind('Frieren Season 1 Blu-ray'), 'series');
  assert.equal(guessKind('Cowboy Bebop: The Complete Series'), 'series');
  assert.equal(guessKind('Utada Hikaru - BADモード', 'Music & CDs'), 'album');
  assert.equal(guessKind('Spirited Away Soundtrack CD'), 'album');
  assert.equal(guessKind('Spirited Away Collector’s Edition Blu-ray + CD'), 'movie', 'a disc that ships with a CD is still a film');
});

test('an expected disc keeps what was scanned', () => {
  const e = toExpected({ code: '5051892239349', product: 'Dune [Blu-ray] (2021)', title: 'Dune', year: 2021, kind: 'movie', source: 'upcitemdb' });
  assert.equal(e.code, '5051892239349');
  assert.equal(e.title, 'Dune');
  assert.equal(e.product, 'Dune [Blu-ray] (2021)');
  assert.equal(e.kind, 'movie');
  assert.match(e.id, /^b/);
  assert.ok(Date.parse(e.addedAt));
  assert.equal(toExpected({ code: '1', product: 'x', title: 'x', kind: 'album', source: 'musicbrainz' }).kind, 'movie', 'albums are not disc rips');
});
