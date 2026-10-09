import assert from 'node:assert/strict';
import test from 'node:test';
import { parseIdentifiers, toMatch } from './discdb.js';

test('the flat identifier list is sorted into the ids it holds', () => {
  const ids = parseIdentifiers(['tt8579674', '530915', '191329125670', 'BR61209848']);
  assert.equal(ids.imdbId, 'tt8579674');
  assert.equal(ids.tmdbId, 530915);
  assert.deepEqual(ids.upcs, ['191329125670']);
  assert.deepEqual(ids.asins, ['BR61209848']);
});

test('a barcode is never mistaken for a TMDb id', () => {
  const ids = parseIdentifiers(['043396630390', '1396']);
  assert.deepEqual(ids.upcs, ['043396630390'], '12 digits is a barcode');
  assert.equal(ids.tmdbId, 1396, 'four digits is an id');
});

test('an empty or odd list is harmless', () => {
  assert.deepEqual(parseIdentifiers(), { upcs: [], asins: [] });
  assert.deepEqual(parseIdentifiers(['', '  ', 'nonsense-with-dashes']), { upcs: [], asins: [] });
});

test('a search result becomes something Rexarr can use', () => {
  const m = toMatch({
    type: 'Movie',
    title: '1917',
    relativeUrl: '/movie/1917-2019',
    identifiers: ['tt8579674', '530915', '191329125670'],
    mediaItem: { slug: '1917-2019' },
  })!;
  assert.equal(m.kind, 'movie');
  assert.equal(m.title, '1917');
  assert.equal(m.year, 2019, 'the year comes off the slug, not the title');
  assert.equal(m.tmdbId, 530915);
  assert.equal(m.url, 'https://thediscdb.com/movie/1917-2019');

  const s = toMatch({ type: 'Series', title: 'Breaking Bad', relativeUrl: '/series/breaking-bad-2008', mediaItem: { slug: 'breaking-bad-2008' } })!;
  assert.equal(s.kind, 'series');
  assert.equal(s.year, 2008);

  assert.equal(toMatch({ type: 'Movie', title: '' }), null, 'nothing to use');
  assert.equal(toMatch({ title: 'No url or slug' }), null);
});
