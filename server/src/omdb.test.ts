import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTitle } from './omdb.js';

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
