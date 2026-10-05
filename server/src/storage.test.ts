import assert from 'node:assert/strict';
import test from 'node:test';
import { networkFilesystem } from './storage.js';

// The shape of /proc/mounts: device, mount point, type, options, dump, pass.
const MOUNTS = [
  'overlay / overlay rw,relatime 0 0',
  '/dev/sda1 /mnt/local ext4 rw,relatime 0 0',
  '//nas/media /data/media cifs rw,relatime 0 0',
  'nas:/export/config /config nfs4 rw,relatime 0 0',
  'tank/apps /mnt/tank/apps zfs rw 0 0',
  '/dev/sdb1 /mnt/with\\040space ext4 rw 0 0',
].join('\n');

test('spots the network filesystem a folder sits on', () => {
  assert.equal(networkFilesystem('/config/data', MOUNTS), 'nfs4');
  assert.equal(networkFilesystem('/data/media/movies', MOUNTS), 'cifs');
});

test('local filesystems are not flagged', () => {
  assert.equal(networkFilesystem('/mnt/local/appdata', MOUNTS), null);
  assert.equal(networkFilesystem('/mnt/tank/apps/rexarr', MOUNTS), null, 'zfs is local');
  assert.equal(networkFilesystem('/var/lib/rexarr', MOUNTS), null, 'falls back to the root mount');
});

test('the longest matching mount point wins, not the first', () => {
  const mounts = ['overlay / overlay rw 0 0', '//nas/x /config cifs rw 0 0', '/dev/sda1 /config/local ext4 rw 0 0'].join('\n');
  assert.equal(networkFilesystem('/config/local/data', mounts), null, '/config/local is the closer mount');
  assert.equal(networkFilesystem('/config/data', mounts), 'cifs');
});

test('mount points with escaped spaces are read', () => {
  assert.equal(networkFilesystem('/mnt/with space/data', MOUNTS), null);
});

test('a path that matches nothing is not a share', () => {
  assert.equal(networkFilesystem('/config', ''), null);
});
