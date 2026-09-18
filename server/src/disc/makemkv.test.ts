import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findDiscImages, labelToTitle, listVirtualDrives, parseDiscInfo, parseDrives, parseDurationSeconds, splitRobot } from './makemkv.js';
import { audioSelectionFor, bestAudioPerLanguage, codecRank } from './audio.js';
import type { DiscAudioTrack } from '../../../shared/types.js';
import { matchLibrary, splitSequel, type LibraryCandidate } from './identify.js';

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

test('the automatic audio pick keeps the best track per language', () => {
  const tracks: DiscAudioTrack[] = [
    { index: 0, codec: 'DD', language: 'eng', channels: 2, bitrateKbps: 224, lossless: false, label: 'English · DD Stereo', name: 'Stereo' },
    { index: 1, codec: 'DD', language: 'jpn', channels: 2, bitrateKbps: 224, lossless: false, label: 'Japanese · DD Stereo', name: 'Stereo' },
    { index: 2, codec: 'DTS', language: 'eng', channels: 6, bitrateKbps: 768, lossless: false, label: 'English · DTS 5.1', name: 'Surround 5.1' },
    { index: 3, codec: 'DTS', language: 'jpn', channels: 6, bitrateKbps: 768, lossless: false, label: 'Japanese · DTS 5.1', name: 'Surround 5.1' },
    { index: 4, codec: 'DD', language: 'eng', channels: 6, bitrateKbps: 448, lossless: false, label: 'English · DD 5.1', name: 'Surround 5.1' },
    { index: 5, codec: 'DD', language: 'jpn', channels: 6, bitrateKbps: 448, lossless: false, label: 'Japanese · DD 5.1', name: 'Surround 5.1' },
  ];
  assert.deepEqual(bestAudioPerLanguage(tracks), [2, 3]);

  // lossless wins over more channels, and commentary is never the automatic pick
  const bluray: DiscAudioTrack[] = [
    { index: 0, codec: 'DTS-HD MA', language: 'eng', channels: 6, bitrateKbps: 3000, lossless: true, label: 'English · DTS-HD MA 5.1' },
    { index: 1, codec: 'DD', language: 'eng', channels: 8, bitrateKbps: 640, lossless: false, label: 'English · DD 7.1' },
    { index: 2, codec: 'TrueHD', language: 'eng', channels: 8, bitrateKbps: 4000, lossless: true, label: "English · TrueHD 7.1 director's commentary", name: "Director's commentary" },
  ];
  assert.deepEqual(bestAudioPerLanguage(bluray), [0]);
  assert.equal(codecRank('DTS-HD MA').lossless, true);
  assert.equal(codecRank('DD').lossless, false);
});

test('audio selection modes', () => {
  const title = {
    id: 1,
    name: 'Title 1',
    durationSeconds: 1440,
    sizeBytes: 1_600_000_000,
    chapters: 4,
    fileName: 't00.mkv',
    audio: [],
    subtitles: [],
    audioTracks: [
      { index: 0, codec: 'DD', language: 'eng', channels: 2, lossless: false, label: 'English · DD Stereo' },
      { index: 1, codec: 'DTS', language: 'jpn', channels: 6, lossless: false, label: 'Japanese · DTS 5.1' },
    ],
  };
  assert.deepEqual(audioSelectionFor(title, 'all'), [0, 1]);
  assert.deepEqual(audioSelectionFor(title, 'best'), [0, 1]);
  assert.deepEqual(audioSelectionFor(title, 'custom', [1]), [1]);
  // an impossible custom choice falls back to the automatic pick instead of ripping no audio at all
  assert.deepEqual(audioSelectionFor(title, 'custom', [7]), [0, 1]);
});

test('parseDiscInfo reads the audio streams of a title', () => {
  const robot = [
    'DRV:0,2,999,1,"HL-DT-ST DVDRAM","NARUTO_D1","/dev/rdisk4"',
    'CINFO:1,6209,"DVD disc"',
    'CINFO:2,0,"NARUTO_D1"',
    'CINFO:32,0,"NARUTO_D1"',
    'TINFO:0,2,0,"Title 1"',
    'TINFO:0,8,0,"4"',
    'TINFO:0,9,0,"0:23:55"',
    'TINFO:0,11,0,"1685000000"',
    'TINFO:0,27,0,"title_t00.mkv"',
    'SINFO:0,0,1,6201,"Video"',
    'SINFO:0,0,6,0,"Mpeg2"',
    'SINFO:0,0,19,0,"720x576"',
    'SINFO:0,0,21,0,"25"',
    'SINFO:0,1,1,6202,"Audio"',
    'SINFO:0,1,2,0,"Stereo"',
    'SINFO:0,1,3,0,"eng"',
    'SINFO:0,1,4,0,"English"',
    'SINFO:0,1,6,0,"DD"',
    'SINFO:0,1,13,0,"224 Kb/s"',
    'SINFO:0,1,14,0,"2"',
    'SINFO:0,1,40,0,"Stereo"',
    'SINFO:0,2,1,6202,"Audio"',
    'SINFO:0,2,2,0,"Surround 5.1"',
    'SINFO:0,2,3,0,"jpn"',
    'SINFO:0,2,4,0,"Japanese"',
    'SINFO:0,2,6,0,"DTS"',
    'SINFO:0,2,13,0,"768 Kb/s"',
    'SINFO:0,2,14,0,"6"',
    'SINFO:0,2,40,0,"5.1"',
    'SINFO:0,3,1,6203,"Subtitles"',
    'SINFO:0,3,3,0,"eng"',
    'SINFO:0,3,6,0,"VOBSUB"',
  ].join('\n');
  const info = parseDiscInfo(robot);
  assert.equal(info.type, 'dvd');
  const t = info.titles[0];
  assert.equal(t.audioTracks?.length, 2);
  assert.deepEqual(
    t.audioTracks?.map((a) => [a.index, a.codec, a.language, a.channels, a.bitrateKbps]),
    [
      [0, 'DD', 'eng', 2, 224],
      [1, 'DTS', 'jpn', 6, 768],
    ],
  );
  assert.equal(t.audioTracks?.[1].label, 'Japanese · DTS 5.1 768 kbps');
  // one track per language, so both are kept
  assert.deepEqual(audioSelectionFor(t, 'best'), [0, 1]);
});

test('disc titles match the library by nickname, alternate title and sequel number', () => {
  const library: LibraryCandidate[] = [
    {
      kind: 'series',
      id: 359,
      title: 'My Teen Romantic Comedy SNAFU',
      alternateTitles: ['Yahari Ore no Seishun Love Come wa Machigatteiru.', 'Oregairu'],
      seasonTitles: [{ title: 'Yahari Ore no Seishun Love Come wa Machigatteiru Zoku', seasonNumber: 2 }, { title: 'My Teen Romantic Comedy SNAFU Too!', seasonNumber: 2 }],
      seasons: [0, 1, 2, 3],
    },
    { kind: 'series', id: 86, title: 'Saekano: How to Raise a Boring Girlfriend', alternateTitles: ['Saekano', 'Saekano S2'], seasons: [1, 2] },
    { kind: 'series', id: 234, title: 'Naruto', seasons: [1, 2, 3] },
    // matched "Snafu 2" through the "s" of "World's" before the fix
    { kind: 'series', id: 77, title: "Arifureta: From Commonplace to World's Strongest", alternateTitles: ["Arifureta - From Commonplace to World's Strongest Season 2"], seasons: [1, 2, 3] },
    { kind: 'movie', id: 12, title: 'Toy Story 2' },
    { kind: 'movie', id: 13, title: 'Toy Story' },
  ];
  // the disc from the bug report: "SNAFU_2_DISC_1" was matched to Saekano, season 1
  const snafu = matchLibrary(labelToTitle('SNAFU_2_DISC_1').title!, library, { preferSeries: true });
  assert.equal(snafu?.item.id, 359);
  assert.equal(snafu?.season, 2);
  assert.equal(matchLibrary('Snafu Too', library)?.season, 2);
  assert.equal(matchLibrary('Oregairu S2', library)?.item.id, 359);
  assert.equal(matchLibrary('Oregairu S2', library)?.season, 2);
  assert.equal(matchLibrary('Naruto', library)?.item.id, 234);
  // a movie sequel keeps its number
  assert.equal(matchLibrary('Toy Story 2', library)?.item.id, 12);
  // nothing close: no guess at all rather than a wrong one
  assert.equal(matchLibrary('Clannad', library), null);
  assert.deepEqual(splitSequel('Fate Zero Season 2'), { base: 'Fate Zero', season: 2 });
  assert.deepEqual(splitSequel('Title II'), { base: 'Title', season: 2 });
  assert.equal(splitSequel('Naruto'), null);
});

test('a season title such as "SNAFU Too" finds its season', () => {
  const library: LibraryCandidate[] = [
    {
      kind: 'series',
      id: 359,
      title: 'My Teen Romantic Comedy SNAFU',
      // what AniDB contributes: one anime per season
      seasonTitles: [
        { title: 'My Teen Romantic Comedy SNAFU', seasonNumber: 1 },
        { title: 'My Teen Romantic Comedy SNAFU Too!', seasonNumber: 2 },
        { title: 'Yahari Ore no Seishun Lovecome wa Machigatte Iru. Zoku', seasonNumber: 2 },
        { title: 'My Teen Romantic Comedy SNAFU Climax!', seasonNumber: 3 },
      ],
      seasons: [0, 1, 2, 3],
    },
  ];
  assert.equal(matchLibrary(labelToTitle('SNAFU_TOO_DISC_1').title!, library)?.season, 2);
  assert.equal(matchLibrary('Snafu Climax', library)?.season, 3);
  assert.equal(matchLibrary('Snafu 2', library)?.season, 2);
});
