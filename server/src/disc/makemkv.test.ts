import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findDiscImages, labelToTitle, listVirtualDrives, parseDiscInfo, parseDrives, parseDurationSeconds, splitRobot } from './makemkv.js';

test('splitRobot handles quoted fields with commas and escaped quotes', () => {
  assert.deepEqual(splitRobot('0,2,999,12,"BD-RE HL-DT-ST, WH16NS40","BLADE_RUNNER","/dev/sr0"'), ['0', '2', '999', '12', 'BD-RE HL-DT-ST, WH16NS40', 'BLADE_RUNNER', '/dev/sr0']);
  assert.deepEqual(splitRobot('1,0,0,"say ""hi"""'), ['1', '0', '0', 'say "hi"']);
});

test('parseDrives maps states and skips absent drives', () => {
  const out = parseDrives(
    [
      'MSG:1005,0,1,"MakeMKV v1.17.8 darwin(x64-release) started","%1 started","MakeMKV v1.17.8"',
      'DRV:0,2,999,12,"BD-RE HL-DT-ST BD-RE  WH16NS40 1.02","BLADE_RUNNER_2049","/dev/rdisk4"',
      'DRV:1,0,999,0,"DVD+RW Drive","","/dev/rdisk5"',
      'DRV:2,256,999,0,"","",""',
      'TCOUNT:0',
    ].join('\n'),
  );
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { index: 0, state: 'loaded', name: 'BD-RE HL-DT-ST BD-RE  WH16NS40 1.02', discLabel: 'BLADE_RUNNER_2049', path: '/dev/rdisk4', source: 'disc:0' });
  assert.equal(out[1].state, 'empty');
  assert.equal(out[1].discLabel, undefined);
});

test('parseDiscInfo builds titles with streams', () => {
  const out = parseDiscInfo(
    [
      'CINFO:1,6209,"Blu-ray disc"',
      'CINFO:2,0,"Blade Runner 2049"',
      'CINFO:32,0,"BLADE_RUNNER_2049"',
      'TINFO:0,2,0,"Blade Runner 2049"',
      'TINFO:0,8,0,"24"',
      'TINFO:0,9,0,"2:43:41"',
      'TINFO:0,11,0,"48432117760"',
      'TINFO:0,16,0,"00800.mpls"',
      'TINFO:0,27,0,"Blade_Runner_2049_t00.mkv"',
      'SINFO:0,0,1,6201,"Video"',
      'SINFO:0,0,6,0,"Mpeg4"',
      'SINFO:0,0,19,0,"1920x1080"',
      'SINFO:0,0,21,0,"23.976 (24000/1001)"',
      'SINFO:0,1,1,6202,"Audio"',
      'SINFO:0,1,3,0,"eng"',
      'SINFO:0,1,6,0,"TrueHD"',
      'SINFO:0,1,14,0,"8"',
      'SINFO:0,2,1,6203,"Subtitles"',
      'SINFO:0,2,3,0,"eng"',
      'SINFO:0,2,6,0,"PGS"',
      'TINFO:1,2,0,"Extras"',
      'TINFO:1,9,0,"0:12:00"',
      'TINFO:1,11,0,"1000"',
      'TINFO:1,27,0,"t01.mkv"',
    ].join('\n'),
  );
  assert.equal(out.type, 'bluray');
  assert.equal(out.name, 'Blade Runner 2049');
  assert.equal(out.titles.length, 2);
  const t = out.titles[0];
  assert.equal(t.durationSeconds, 2 * 3600 + 43 * 60 + 41);
  assert.equal(t.sizeBytes, 48432117760);
  assert.equal(t.chapters, 24);
  assert.equal(t.resolution, '1920x1080');
  assert.equal(t.videoCodec, 'Mpeg4');
  assert.deepEqual(t.audio, ['TrueHD 8ch eng']);
  assert.deepEqual(t.subtitles, ['PGS eng']);
  assert.equal(t.fileName, 'Blade_Runner_2049_t00.mkv');
});

test('listVirtualDrives finds ISOs and disc folders', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rexarr-vd-'));
  fs.writeFileSync(path.join(dir, 'TEST_DVD.iso'), '');
  fs.mkdirSync(path.join(dir, 'SOME_BLURAY', 'BDMV'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'not-a-disc'));
  fs.writeFileSync(path.join(dir, 'notes.txt'), '');
  const drives = listVirtualDrives(dir);
  assert.deepEqual(drives.map((d) => [d.discLabel, d.source.split(':')[0], d.state, d.virtual]), [
    ['SOME_BLURAY', 'file', 'loaded', true],
    ['TEST_DVD', 'iso', 'loaded', true],
  ]);
  assert.equal(drives[0].index, 1000);
  assert.deepEqual(listVirtualDrives(''), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('parseDurationSeconds', () => {
  assert.equal(parseDurationSeconds('1:02:03'), 3723);
  assert.equal(parseDurationSeconds('12:30'), 750);
  assert.equal(parseDurationSeconds('bad'), 0);
});

test('labelToTitle cleans disc labels', () => {
  assert.deepEqual(labelToTitle('BLADE_RUNNER_2049'), { title: 'Blade Runner 2049', year: undefined, season: undefined, disc: undefined });
  assert.deepEqual(labelToTitle('Peach Girl – Disc 1'), { title: 'Peach Girl', year: undefined, season: undefined, disc: 1 });
  assert.equal(labelToTitle('SPIDER-MAN - DISC 2').title, 'Spider-man');
  assert.deepEqual(labelToTitle('THE_OFFICE_S2_D1'), { title: 'The Office', year: undefined, season: 2, disc: 1 });
  assert.deepEqual(labelToTitle('SPIRITED.AWAY.2001.BLURAY'), { title: 'Spirited Away', year: 2001, season: undefined, disc: undefined });
  assert.equal(labelToTitle('COWBOY_BEBOP_SEASON_1_DISC_3').season, 1);
});

test('findDiscImages finds ISOs and disc folders inside a download', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rexarr-dl-'));
  const big = (p: string) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '');
    fs.truncateSync(p, 600 * 1024 * 1024); // sparse
  };
  // season pack with two BDMV discs, a sample ISO that must be skipped
  fs.mkdirSync(path.join(root, 'Show.S01.COMPLETE.BLURAY', 'DISC_2', 'BDMV'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Show.S01.COMPLETE.BLURAY', 'DISC_1', 'BDMV'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Show.S01.COMPLETE.BLURAY', 'sample.iso'), 'x');
  assert.deepEqual(findDiscImages(path.join(root, 'Show.S01.COMPLETE.BLURAY')).map((p) => path.basename(p)), ['DISC_1', 'DISC_2']);
  // a download folder that is itself the disc root
  fs.mkdirSync(path.join(root, 'Movie.BD50', 'BDMV'), { recursive: true });
  assert.deepEqual(findDiscImages(path.join(root, 'Movie.BD50')), [path.join(root, 'Movie.BD50')]);
  // nested ISO
  big(path.join(root, 'Movie.DVD9', 'iso', 'MOVIE.ISO'));
  assert.deepEqual(findDiscImages(path.join(root, 'Movie.DVD9')), [path.join(root, 'Movie.DVD9', 'iso', 'MOVIE.ISO')]);
  // a single-file download
  assert.deepEqual(findDiscImages(path.join(root, 'Movie.DVD9', 'iso', 'MOVIE.ISO')), [path.join(root, 'Movie.DVD9', 'iso', 'MOVIE.ISO')]);
  // nothing
  fs.mkdirSync(path.join(root, 'Empty'));
  assert.deepEqual(findDiscImages(path.join(root, 'Empty')), []);
  fs.rmSync(root, { recursive: true, force: true });
});
