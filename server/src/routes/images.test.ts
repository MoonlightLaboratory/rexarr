import { test } from 'node:test';
import assert from 'node:assert/strict';
import { posterRef } from './images.js';

/**
 * A job's poster is the URL the browser was given. Embedding it means fetching it server-side, so what counts
 * as fetchable is worth pinning down: the same two shapes /api/image accepts, and nothing else. A poster
 * string is still just a string, and one that arrived from somewhere unexpected must not become an arbitrary
 * outbound request.
 */
test('a proxied poster is taken apart into the three things the cache needs', () => {
  assert.deepEqual(posterRef('api/image?arr=radarr&local=%2FMediaCover%2F97%2Fposter-500.jpg'), {
    arr: 'radarr',
    local: '/MediaCover/97/poster-500.jpg',
    remote: undefined,
  });
  assert.deepEqual(posterRef('api/image?arr=sonarr&remote=https%3A%2F%2Fimage.tmdb.org%2Ft%2Fp%2Fw500%2Fx.jpg'), {
    arr: 'sonarr',
    local: undefined,
    remote: 'https://image.tmdb.org/t/p/w500/x.jpg',
  });
});

test('anything that is not one of those two shapes is not fetched', () => {
  assert.equal(posterRef(undefined), null);
  assert.equal(posterRef(''), null);
  assert.equal(posterRef('/local/poster.jpg'), null, 'a bare path is not a proxied poster');
  assert.equal(posterRef('api/image?arr=radarr'), null, 'nothing to fetch');
  assert.equal(posterRef('api/image?remote=http://insecure.example/x.jpg'), null, 'plain http is not accepted');
  assert.equal(posterRef('api/image?remote=file:///etc/passwd'), null);
  assert.equal(posterRef('api/image?local=/etc/passwd'), null, 'only the arr MediaCover path is allowed');
  assert.equal(posterRef('api/image?local=../../etc/passwd'), null);
});

test('an unknown app is dropped but a usable image is still fetched', () => {
  assert.deepEqual(posterRef('api/image?arr=nope&remote=https%3A%2F%2Fimage.tmdb.org%2Fx.jpg'), {
    arr: undefined,
    local: undefined,
    remote: 'https://image.tmdb.org/x.jpg',
  });
});
