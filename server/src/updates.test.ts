import assert from 'node:assert/strict';
import test from 'node:test';
import { compareVersions, mechanism, parseVersion, toReleases } from './updates.js';

test('parses four-part versions, with or without the v', () => {
  assert.deepEqual(parseVersion('0.1.6.0'), [0, 1, 6, 0]);
  assert.deepEqual(parseVersion('v0.2.0.0'), [0, 2, 0, 0]);
  assert.deepEqual(parseVersion('1.2'), [1, 2, 0, 0]);
  assert.deepEqual(parseVersion('nightly'), []);
});

test('compares versions part by part, not as text', () => {
  assert.equal(compareVersions('0.1.6.0', '0.1.5.0'), 1);
  assert.equal(compareVersions('0.1.10.0', '0.1.9.0'), 1, '10 is above 9');
  assert.equal(compareVersions('0.1.6.0', '0.1.6'), 0);
  assert.equal(compareVersions('0.1.6.0', '0.2.0.0'), -1);
  assert.equal(compareVersions('0.1.6.1', '0.1.6.0'), 1);
});

test('marks the running release and the newer ones, newest first', () => {
  const list = toReleases(
    [
      { tag_name: 'v0.1.5.0', name: 'Rexarr 0.1.5.0', published_at: '2026-09-17T00:00:00Z', body: 'old' },
      { tag_name: 'v0.1.7.0', published_at: '2026-10-10T00:00:00Z', prerelease: true, body: 'new' },
      { tag_name: 'v0.1.6.0', published_at: '2026-10-01T00:00:00Z', body: 'this one' },
      { tag_name: 'v0.1.8.0', draft: true },
    ],
    '0.1.6.0',
  );
  assert.deepEqual(list.map((r) => r.version), ['0.1.7.0', '0.1.6.0', '0.1.5.0'], 'drafts are dropped, newest first');
  assert.equal(list[0].newer, true);
  assert.equal(list[0].prerelease, true);
  assert.equal(list[1].installed, true);
  assert.equal(list[1].newer, false);
  assert.equal(list[2].newer, false);
  assert.equal(list[2].name, 'Rexarr 0.1.5.0');
  assert.equal(list[0].name, '0.1.7.0', 'a release without a name falls back to its version');
});

test('does not tell a package install to pull a Docker image', () => {
  assert.equal(mechanism('docker', true, false), 'docker', 'in a container the setting stands');
  assert.equal(mechanism('docker', false, true), 'external', 'a stale "docker" setting outside one is ignored');
  assert.equal(mechanism('docker', false, false), 'builtIn', 'running from source');
  assert.equal(mechanism('script', false, true), 'script');
  assert.equal(mechanism(undefined, false, true), 'external');
});
