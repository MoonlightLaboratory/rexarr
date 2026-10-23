import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFinished, normaliseServer, parseArgs, pickDrive, pickProfile, ripInDrive } from './args.js';
import type { DiscDrive, DiscRip, Profile, SmartProfile } from '../../../shared/types.js';

const drive = (d: Partial<DiscDrive>): DiscDrive => ({ index: 0, name: 'Drive', path: '', state: 'loaded', source: '', ...d }) as DiscDrive;

test('the command line is read the way it is typed', () => {
  const r = parseArgs(['rip', '--drive', '1', '--profile', 'anime', '--wait'], {});
  assert.equal(r.command, 'rip');
  assert.equal(r.drive, '1');
  assert.equal(r.profile, 'anime');
  assert.equal(r.wait, true);
  assert.equal(r.error, undefined);

  // the server comes from the flag, then the environment, then the usual place
  assert.equal(parseArgs(['status'], {}).server, 'http://localhost:3939');
  assert.equal(parseArgs(['status'], { REXARR_URL: 'nas:3939' }).server, 'http://nas:3939');
  assert.equal(parseArgs(['status', '--server', 'https://box/'], { REXARR_URL: 'nas:3939' }).server, 'https://box');
  assert.equal(parseArgs(['status'], { REXARR_API_KEY: 'abc' }).key, 'abc');

  // the switches that turn a step off are off, not absent - absent means "whatever the disc already says"
  assert.equal(parseArgs(['rip', '--drive', '1'], {}).transcode, undefined);
  assert.equal(parseArgs(['rip', '--drive', '1', '--no-transcode'], {}).transcode, false);

  // and what is wrong is said rather than guessed at
  assert.match(parseArgs(['rip'], {}).error ?? '', /needs --drive/);
  assert.match(parseArgs(['swap'], {}).error ?? '', /--drive or --all/);
  assert.match(parseArgs(['frobnicate'], {}).error ?? '', /unknown command/);
  assert.match(parseArgs(['status', '--colour'], {}).error ?? '', /unknown option/);
  assert.equal(parseArgs([], {}).command, 'help');
  assert.equal(parseArgs(['rip', '--help'], {}).command, 'help', 'asking for help is never an error');
});

test('a server address survives how people type it', () => {
  assert.equal(normaliseServer('  http://nas:3939/  '), 'http://nas:3939');
  assert.equal(normaliseServer('nas:3939'), 'http://nas:3939');
  assert.equal(normaliseServer('https://rexarr.example.com'), 'https://rexarr.example.com');
  assert.equal(normaliseServer(''), '');
});

test('a drive can be named by number, device or the disc in it', () => {
  const drives = [
    drive({ index: 0, name: 'TSSTcorp DVD+-RW TS-L633J', path: '/dev/rdisk4', discLabel: 'NARUTO_D1' }),
    drive({ index: 1, name: 'HL-DT-ST DVDRAM GT50N', path: '/dev/rdisk5', discLabel: 'NARUTO_D2' }),
  ];
  assert.equal(pickDrive(drives, '1').drive?.index, 1);
  assert.equal(pickDrive(drives, '/dev/rdisk4').drive?.index, 0);
  assert.equal(pickDrive(drives, 'naruto_d2').drive?.index, 1);
  assert.equal(pickDrive(drives, 'GT50N').drive?.index, 1);

  // a name that fits two drives is refused rather than one of them picked
  assert.match(pickDrive(drives, 'DVD').error ?? '', /matches 2 drives/);
  assert.match(pickDrive(drives, '7').error ?? '', /no drive/);
});

test('a profile is matched exactly before loosely', () => {
  const profiles = [
    { id: 'a', name: 'Anime · 1080p x265' },
    { id: 'b', name: 'TV · 1080p x265' },
    { id: 'c', name: 'Anime' },
  ] as Profile[];
  const smart = [{ id: 's', name: 'Smart · Lossless audio' }] as SmartProfile[];

  // "anime" is the name of one of them outright, so the one it names wins over the one that contains it
  assert.equal(pickProfile(profiles, smart, 'anime').id, 'c');
  assert.equal(pickProfile(profiles, smart, '1080p').error !== undefined, true, 'three of them are 1080p');
  assert.equal(pickProfile(profiles, smart, 'lossless').id, 's', 'a smart profile is a profile here');
  assert.match(pickProfile(profiles, smart, 'av1').error ?? '', /no profile matching/);
});

test('the disc in a drive is found however the drive was listed', () => {
  const rips = [{ id: 'r1', driveIndex: 9, drivePath: '/dev/rdisk5', status: 'ready' }] as DiscRip[];
  // MakeMKV says rdisk5 where Rexarr's own detection says disk5; both are the same disc in the same drive
  assert.equal(ripInDrive(rips, drive({ index: 1, path: '/dev/disk5' }))?.id, 'r1');
  assert.equal(ripInDrive(rips, drive({ index: 9, path: '' }))?.id, 'r1');
  assert.equal(ripInDrive(rips, drive({ index: 2, path: '/dev/disk7' })), undefined);
});

test('a rip is finished when it stops moving on its own', () => {
  assert.equal(isFinished('done'), true);
  assert.equal(isFinished('failed'), true);
  assert.equal(isFinished('cancelled'), true);
  assert.equal(isFinished('ripping'), false);
  assert.equal(isFinished('ready'), false, 'ready is waiting for someone, not finished');
});
