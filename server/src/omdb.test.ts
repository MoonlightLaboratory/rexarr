import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTitle } from './omdb.js';
import { nameScore } from './disc/identify.js';

test('an OMDb answer becomes the facts a smart profile decides on', () => {
  const t = parseTitle({
    Response: 'True',
    Title: 'Spirited Away',
    Year: '2001',
    Genre: 'Animation, Adventure, Family',
    Type: 'movie',
    imdbID: 'tt0245429',
    Runtime: '125 min',
    imdbRating: '8.6',
    Rated: 'PG',
  });
  assert.ok(t);
  // lower-cased and split, which is the shape the "is one of" chips match on
  assert.deepEqual(t.genres, ['animation', 'adventure', 'family']);
  assert.equal(t.kind, 'movie');
  assert.equal(t.year, 2001);
  assert.equal(t.runtimeMinutes, 125);
  assert.equal(t.imdbRating, 8.6);
});

test('a series keeps the year it started, not the range', () => {
  const t = parseTitle({ Response: 'True', Title: 'Breaking Bad', Year: '2008–2013', Genre: 'Crime, Drama, Thriller', Type: 'series', imdbID: 'tt0903747' });
  assert.equal(t?.year, 2008);
  assert.equal(t?.kind, 'series');
  // an episode is still a series as far as a profile is concerned
  assert.equal(parseTitle({ Response: 'True', Title: 'Ozymandias', Year: '2013', Type: 'episode' })?.kind, 'series');
});

test('OMDb’s "N/A" is not a value', () => {
  const t = parseTitle({ Response: 'True', Title: 'Something', Year: 'N/A', Genre: 'N/A', Type: 'movie', Runtime: 'N/A', imdbRating: 'N/A', Plot: 'N/A', Poster: 'N/A', imdbID: 'N/A' });
  assert.deepEqual(t?.genres, []);
  assert.equal(t?.year, 0);
  assert.equal(t?.runtimeMinutes, undefined);
  assert.equal(t?.imdbRating, undefined);
  assert.equal(t?.plot, undefined);
  assert.equal(t?.poster, undefined);
  assert.equal(t?.imdbId, undefined);
});

test('a miss is a miss, not an empty title', () => {
  assert.equal(parseTitle({ Response: 'False', Error: 'Movie not found!' }), null);
  assert.equal(parseTitle({}), null);
});

// ---- how far an OMDb answer is allowed to be from what was asked ------------------------------
// Both callers - a disc label and a shop listing - score OMDb's answer before using it, the same way the rest
// of disc identification does. These pin the cases that decide whether a suggestion is taken.
test('an OMDb suggestion is taken only when it is close to what was asked', () => {
  const close = (a: string, b: string) => nameScore(a, b) >= 0.6;
  // what a shop listing becomes after the edition noise is stripped, against OMDb's proper title
  assert.ok(close('Reign Of The Supermen', 'Reign of the Supermen'));
  assert.ok(close('Blade Runner 2049', 'Blade Runner 2049'));
  // a disc label is usually a shortening of the real title, which is what nameScore is built for
  assert.ok(close('Spirited Away', 'Spirited Away'));
  // a shortened label still matches the full title, which is the usual case for a disc
  assert.ok(close('Snafu', 'My Teen Romantic Comedy SNAFU'));
  // and a different film is not accepted just because OMDb answered something
  assert.equal(nameScore('Reign Of The Supermen', 'Superman'), 0);
  // the one this cannot catch: a sequel contains the whole of the original's name, so "The Matrix" scores
  // highly against "The Matrix Resurrections". The year, when the label carries one, is what separates them.
  assert.ok(nameScore('The Matrix', 'The Matrix Resurrections') >= 0.6);
});
