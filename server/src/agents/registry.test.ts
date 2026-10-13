import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Agent } from '../../../shared/types.js';
import { mapArgs, toAgentPath } from './registry.js';

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 'a1',
  name: 'shelf-pi-1',
  version: '0.1.8.0',
  capabilities: { rip: true, transcode: true, platform: 'linux', arch: 'arm64', cpus: 4, totalMemoryBytes: 4e9 },
  drives: [],
  concurrency: 1,
  pathMappings: [],
  enabled: true,
  firstSeen: '',
  lastSeen: new Date().toISOString(),
  running: [],
  ...over,
});

test('a path is rewritten into what that agent mounts the share at', () => {
  const a = agent({ pathMappings: [{ remote: '/Volumes/Media', local: '/mnt/media' }] });
  assert.equal(toAgentPath(a, '/Volumes/Media/Movies/A (2024)/a.mkv'), '/mnt/media/Movies/A (2024)/a.mkv');
  // anything outside the share is left alone: a temp folder on the agent is the agent's own
  assert.equal(toAgentPath(a, '/tmp/x.mkv'), '/tmp/x.mkv');
  // and with no mappings at all, both machines see the same paths
  assert.equal(toAgentPath(agent(), '/Volumes/Media/x.mkv'), '/Volumes/Media/x.mkv');
});

test('the longest mapping wins, so a specific folder can sit inside a general one', () => {
  const a = agent({
    pathMappings: [
      { remote: '/Volumes/Media', local: '/mnt/media' },
      { remote: '/Volumes/Media/4K', local: '/mnt/fast' },
    ],
  });
  assert.equal(toAgentPath(a, '/Volumes/Media/4K/x.mkv'), '/mnt/fast/x.mkv');
  assert.equal(toAgentPath(a, '/Volumes/Media/HD/x.mkv'), '/mnt/media/HD/x.mkv');
});

test('every path in a command is rewritten, inside a makemkvcon source too', () => {
  const a = agent({ pathMappings: [{ remote: '/Volumes/Media', local: '/mnt/media' }] });
  assert.deepEqual(
    mapArgs(a, ['-i', '/Volumes/Media/in.mkv', '-crf', '20', '/Volumes/Media/out.mkv']),
    ['-i', '/mnt/media/in.mkv', '-crf', '20', '/mnt/media/out.mkv'],
  );
  // "iso:/path" and "file:/path" are one argument with a path in them
  assert.deepEqual(mapArgs(a, ['mkv', 'file:/Volumes/Media/Discs/D', '0', '/Volumes/Media/Rips']), ['mkv', 'file:/mnt/media/Discs/D', '0', '/mnt/media/Rips']);
  // a flag that looks like a scheme is not a path and must survive untouched
  assert.deepEqual(mapArgs(a, ['-crf', '20', '-map', '0:0']), ['-crf', '20', '-map', '0:0']);
});
