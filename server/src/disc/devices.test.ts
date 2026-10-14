import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DriveCandidate } from '../../../shared/types.js';
import { newDrives } from './devices.js';

const c = (path: string, name = 'Drive'): DriveCandidate => ({ path, name });

test('a drive MakeMKV already listed is not added a second time', () => {
  const found = [c('/dev/sr0', 'Pioneer BD-RW'), c('/dev/sr1', 'ASUS DVD')];
  assert.deepEqual(newDrives(found, ['/dev/sr0']).map((x) => x.device), ['/dev/sr1']);
  assert.deepEqual(newDrives(found, ['/dev/sr0', '/dev/sr1']), []);
  // nothing accounted for yet: both are new
  assert.deepEqual(newDrives(found, []).map((x) => x.device), ['/dev/sr0', '/dev/sr1']);
  // an empty path among the taken ones (a drive with no device yet) must not swallow everything
  assert.deepEqual(newDrives(found, ['']).map((x) => x.device), ['/dev/sr0', '/dev/sr1']);
});

test('the SCSI generic node is not a drive of its own', () => {
  // MakeMKV reaches a Blu-ray drive through /dev/sgN; it is the same drive as /dev/sr0, not another one
  assert.deepEqual(newDrives([c('/dev/sr0'), c('/dev/sg0')], []).map((x) => x.device), ['/dev/sr0']);
});

test('a drive with no device yet is still a drive', () => {
  // macOS only names the device once a disc is in, and a drive with nothing in it is what this is for
  const out = newDrives([{ path: '', name: 'HL-DT-ST DVDRAM GT50N', state: 'empty' }], ['/dev/sr0']);
  assert.equal(out.length, 1);
  assert.equal(out[0].device, '');
  assert.equal(out[0].candidate.state, 'empty');
  // but two of them are two drives, since there is no path to tell them apart by
  assert.equal(newDrives([{ path: '', name: 'A' }, { path: '', name: 'B' }], []).length, 2);
});
