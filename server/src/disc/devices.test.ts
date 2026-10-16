import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DiscDrive, DriveCandidate } from '../../../shared/types.js';
import { driveId, driveSources, newDrives, statusDrives } from './devices.js';

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

test('a drive is offered both of MakeMKV\'s handles, best first', () => {
  const live: DiscDrive = { index: 1, name: 'HL-DT-ST DVDRAM GT50N', path: '/dev/rdisk4', state: 'loaded', source: 'dev:/dev/rdisk4', detected: true };

  // a fresh disc: the device node leads, the drive's number is the way in if MakeMKV will not resolve the node
  assert.deepEqual(driveSources('dev:/dev/rdisk4', live), ['dev:/dev/rdisk4', 'disc:1']);

  // a handle already known to work leads, even though it is MakeMKV's number
  assert.deepEqual(driveSources('disc:1', live), ['disc:1', 'dev:/dev/rdisk4']);

  // a number from before the drive was renumbered addresses a different drive, so it goes last
  assert.deepEqual(driveSources('disc:0', live), ['dev:/dev/rdisk4', 'disc:1', 'disc:0']);

  // Rexarr's own bands are not MakeMKV drive numbers, so no disc:N is invented for them
  const found: DiscDrive = { index: 2000, name: 'HL-DT-ST DVDRAM GT50N', path: '/dev/disk5', state: 'loaded', source: 'dev:/dev/disk5', detected: false, auto: true };
  assert.deepEqual(driveSources('dev:/dev/disk5', found), ['dev:/dev/disk5']);

  // a drive that has gone away leaves only what the rip was created with
  assert.deepEqual(driveSources('disc:1', undefined), ['disc:1']);
});

test('drutil status is read per drive, so a disc in the second drive is not credited to the first', () => {
  // the real output of a single USB drive with a disc in it
  const one = [
    ' Vendor   Product           Rev ',
    ' HL-DT-ST DVDRAM GT50N      LT20',
    '',
    '           Type: DVD-ROM              Name: /dev/disk5',
    '       Sessions: 1                  Tracks: 1 ',
  ].join('\n');
  assert.deepEqual(statusDrives(one), [{ id: 'HL-DT-ST DVDRAM GT50N', device: '/dev/disk5' }]);

  // two drives, and the disc is in the second one. The first prints no Name at all, which is what used to shift
  // the node up onto it and leave the drive the disc is in with none.
  const two = [
    ' Vendor   Product           Rev ',
    ' TSSTcorp DVD+-RW TS-L633J  D400',
    '',
    '           Type: No Media Inserted',
    '',
    ' Vendor   Product           Rev ',
    ' HL-DT-ST DVDRAM GT50N      LT20',
    '',
    '           Type: DVD-ROM              Name: /dev/disk5',
  ].join('\n');
  assert.deepEqual(statusDrives(two), [
    { id: 'TSSTcorp DVD+-RW TS-L633J', device: '' },
    { id: 'HL-DT-ST DVDRAM GT50N', device: '/dev/disk5' },
  ]);

  // and the same drive reads the same from `drutil list`, which writes different columns after it, so the two
  // listings can be paired by the drive rather than by position
  assert.equal(driveId('1  HL-DT-ST DVDRAM GT50N      LT20  USB       Unsupported'), 'HL-DT-ST DVDRAM GT50N');
  assert.equal(driveId(' HL-DT-ST DVDRAM GT50N      LT20'), 'HL-DT-ST DVDRAM GT50N');
  assert.equal(driveId(''), '');
});

test('an empty drive MakeMKV already listed is not found a second time', () => {
  // drutil and MakeMKV name the same drive differently, and with no disc in it there is no device on either side
  // to match on, so the model has to do it or the drive is listed twice
  const candidates: DriveCandidate[] = [{ path: '', name: 'HL-DT-ST DVDRAM GT50N', state: 'empty' }];
  const makemkvName = 'DVD+R-DL HL-DT-ST DVDRAM GT50N LT20 M1BC6B45752';
  assert.deepEqual(newDrives(candidates, [''], [makemkvName]), [], 'already listed, so not added again');

  // a drive MakeMKV did not list is still worth adding - that is what this detection is for
  assert.equal(newDrives(candidates, [''], ['DVD+R-DL TSSTcorp DVD+-RW TS-L633J D400']).length, 1);
  assert.equal(newDrives(candidates, [''], []).length, 1);
});
