import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import type { Release } from '../../../shared/types.js';
import { BUILTIN_PROFILES } from '../../../shared/presets.js';
import { discId, parseCdparanoiaToc, parseTocPlist, tocString } from './musicbrainz.js';
import { formatLabel, musicCategory, musicFormatFromText } from './format.js';
import { crashedAfterDone, freacEncoderArgs } from './freac.js';
import { detectMqaInSamples, MQA_SYNC } from '../audio/mqa.js';
import { groupResponses, splitSoulseekPath } from '../arr/slskd.js';
import { rankReleases } from '../search/releaseInfo.js';
import { parseQuery } from '../search/query.js';
import { localCandidates } from '../routes/images.js';

test('MusicBrainz disc id matches the web service', () => {
  // https://musicbrainz.org/ws/2/discid/lwHl8fGzJyLXQR33ug60E8jhf4k-
  const toc = { firstTrack: 1, lastTrack: 2, leadout: 37890, offsets: [150, 18645], tracks: [] };
  assert.equal(discId(toc), 'lwHl8fGzJyLXQR33ug60E8jhf4k-');
  assert.equal(tocString(toc), '1 2 37890 150 18645');
});

test('TOC parsing: cdparanoia -Q and macOS .TOC.plist', () => {
  const cdp = `Table of contents (audio tracks only):
track        length               begin        copy pre ch
===========================================================
  1.    18495 [04:06.45]        0 [00:00.00]    no   no  2
  2.    19095 [04:14.45]    18495 [04:06.45]    no   no  2
TOTAL   37590 [08:21.15]    (audio only)`;
  const t = parseCdparanoiaToc(cdp)!;
  assert.deepEqual([t.firstTrack, t.lastTrack, t.leadout, t.offsets], [1, 2, 37740, [150, 18645]]);
  const plist = `<plist><dict><key>Sessions</key><array><dict><key>Leadout Block</key><integer>37740</integer><key>Track Array</key><array>
    <dict><key>Data</key><false/><key>Point</key><integer>1</integer><key>Start Block</key><integer>0</integer></dict>
    <dict><key>Data</key><false/><key>Point</key><integer>2</integer><key>Start Block</key><integer>18495</integer></dict>
  </array></dict></array></dict></plist>`;
  const p = parseTocPlist(plist)!;
  assert.deepEqual([p.leadout, p.offsets, p.tracks[1].sectors], [37890, [150, 18645], 19245]);
});

test('music format parsing and categories', () => {
  const a = musicFormatFromText('Artist - Album (2021) [FLAC 24-96] WEB');
  assert.deepEqual([a.format, a.bitDepth, a.sampleRate, a.source, a.lossless, musicCategory(a)], ['FLAC', 24, 96000, 'WEB', true, 'hires']);
  const b = musicFormatFromText('Artist - Album 1994 CD FLAC Log Cue');
  assert.deepEqual([b.format, b.source, musicCategory(b)], ['FLAC', 'CD', 'cd']);
  const c = musicFormatFromText('Artist - Album MP3 320kbps');
  assert.deepEqual([c.format, c.bitrate, musicCategory(c)], ['MP3', 320, 'lossy']);
  assert.equal(musicCategory(musicFormatFromText('Album [MQA-CD FLAC 16-44.1]')), 'mqa');
  assert.equal(formatLabel({ format: 'FLAC', bitDepth: 24, sampleRate: 96000 }), 'FLAC 24/96');
  assert.equal(formatLabel({ format: 'FLAC', bitDepth: 16, sampleRate: 44100 }), 'FLAC 16/44.1');
  assert.equal(parseQuery('Daft Punk Random Access Memories 24bit').wants.category, 'hires');
  assert.equal(parseQuery('Radiohead OK Computer mp3').wants.category, 'lossy');
});

test('fre:ac encoder arguments for the music presets use open-source encoders only', () => {
  const byId = (id: string) => freacEncoderArgs(BUILTIN_PROFILES.find((p) => p.id === id)!);
  assert.deepEqual(byId('builtin-music-flac'), { encoder: 'flac', options: ['-c', '8'], ext: 'flac' });
  assert.deepEqual(byId('builtin-music-mp3-v0'), { encoder: 'lame', options: ['-m', 'VBR', '-q', '0'], ext: 'mp3' });
  assert.deepEqual(byId('builtin-music-mp3-320'), { encoder: 'lame', options: ['-m', 'CBR', '-b', '320'], ext: 'mp3' });
  assert.deepEqual(byId('builtin-music-opus'), { encoder: 'opus', options: ['--bitrate', '160', '--comp', '10'], ext: 'opus' });
  assert.deepEqual(byId('builtin-music-vorbis'), { encoder: 'vorbis', options: ['-q', '60'], ext: 'ogg' });
  for (const p of BUILTIN_PROFILES.filter((x) => x.mediaType === 'music' && x.audio.encoder !== 'copy')) assert.ok(['flac', 'lame', 'opus', 'vorbis', 'wv', 'mac'].includes(freacEncoderArgs(p).encoder), p.id);
});

test('MQA sync word is found in the channel-XOR bit stream', () => {
  const frames = 4000;
  const pcm = new Int32Array(frames * 2);
  let seed = 1;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  for (let i = 0; i < frames * 2; i++) pcm[i] = (rnd() & 0xffff) << 16; // 16-bit noise, left-aligned
  assert.equal(detectMqaInSamples(pcm, 44100).detected, false);
  // embed the 36-bit sync (MSB first) at bit 17 of L^R, followed by original-rate code 0b0110 → 44.1 kHz × 8 = 352.8 kHz? (bits 1–3 reversed)
  const bits = [...MQA_SYNC.toString(2).padStart(36, '0')].map(Number);
  const code = [0, 0, 0, 1, 1, 0, 0]; // positions +1..+7 after the sync; +3..+6 carry the rate code
  const start = 1000;
  [...bits, ...code].forEach((b, k) => {
    const i = start + k;
    const l = pcm[2 * i];
    const want = b << 17;
    pcm[2 * i + 1] = (l & ~(1 << 17)) ^ want ^ (l & (1 << 17)); // make (L ^ R) bit 17 == b
  });
  const found = detectMqaInSamples(pcm, 44100);
  assert.equal(found.detected, true);
  assert.equal(found.bitPosition, 17);
});

test('Soulseek responses become ranked album folders', () => {
  const files = (dir: string, ext: string, n: number, extra: object = {}) => Array.from({ length: n }, (_, i) => ({ filename: `@@music\\${dir}\\${String(i + 1).padStart(2, '0')} - Song.${ext}`, size: 30e6, extension: ext, ...extra }));
  const grouped = groupResponses([
    { username: 'hires', files: [...files('Artist\\Album (2020) [24-96]', 'flac', 10, { bitDepth: 24, sampleRate: 96000 }), { filename: '@@music\\Artist\\Album (2020) [24-96]\\cover.jpg', size: 1e5 }], hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 2e6 },
    { username: 'mp3', files: files('Artist\\Album', 'mp3', 10, { bitRate: 320 }), hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 5e6 },
    { username: 'partial', files: files('Artist\\Album FLAC', 'flac', 6, { bitDepth: 16, sampleRate: 44100 }), hasFreeUploadSlot: false, queueLength: 40, uploadSpeed: 1e5 },
  ]);
  assert.equal(grouped.length, 3);
  const hires = grouped.find((r) => r.indexer === 'hires')!;
  assert.deepEqual([hires.title, hires.quality, hires.music?.trackCount, hires.music?.files?.length], ['Album (2020) [24-96]', 'FLAC 24/96', 10, 10]);
  const ranked = rankReleases(grouped as Release[], { expectedTracks: 10 });
  assert.deepEqual(ranked.map((r) => r.indexer), ['hires', 'mp3', 'partial']);
  assert.equal(splitSoulseekPath('@@x\\A\\B\\01.flac').folder, 'B');
});

test('Lidarr covers are fetched through /api/v1/mediacover, resized variant first', () => {
  assert.deepEqual(localCandidates('lidarr', '/MediaCover/2/poster-500.jpg?lastWrite=1'), [
    '/api/v1/mediacover/artist/2/poster-500.jpg',
    '/api/v1/mediacover/artist/2/poster.jpg',
    '/MediaCover/2/poster-500.jpg?lastWrite=1',
    '/MediaCover/2/poster.jpg?lastWrite=1',
  ]);
  assert.equal(localCandidates('lidarr', '/MediaCover/Albums/15/cover-500.jpg')[0], '/api/v1/mediacover/album/15/cover-500.jpg');
  assert.deepEqual(localCandidates('radarr', '/MediaCover/97/poster-500.jpg'), ['/MediaCover/97/poster-500.jpg', '/MediaCover/97/poster.jpg']);
});

test('cue sheets: Shift-JIS decoding, parsing, image detection with a mismatched FILE name', async () => {
  const { decodeCueText, parseCue, findCueImages, normalisedCue } = await import('./cue.js');
  const { isCueTitle } = await import('../arr/lidarr.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const text = 'REM GENRE J-Pop\r\nREM DATE 2008\r\nPERFORMER "宇多田ヒカル"\r\nTITLE "HEART STATION"\r\nFILE "CDImage.wav" WAVE\r\n  TRACK 01 AUDIO\r\n    TITLE "Fight The Blues"\r\n    INDEX 01 00:00:00\r\n  TRACK 02 AUDIO\r\n    TITLE "HEART STATION"\r\n    INDEX 00 04:13:40\r\n    INDEX 01 04:15:02\r\n';
  const encoded = Buffer.from(execSjis(text));
  const dec = decodeCueText(encoded);
  assert.equal(dec.encoding, 'shift_jis');
  const sheet = parseCue(dec.text);
  assert.equal(sheet.performer, '宇多田ヒカル');
  assert.equal(sheet.files[0].tracks.length, 2);
  assert.equal(sheet.files[0].tracks[1].start, (4 * 60 + 15) * 75 + 2);
  assert.equal(sheet.files[0].tracks[1].pregap, (4 * 60 + 13) * 75 + 40);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rexarr-cue-'));
  try {
    fs.writeFileSync(path.join(dir, 'album.cue'), encoded);
    fs.writeFileSync(path.join(dir, 'album.flac'), 'fake');
    // an already split album next to it is not an image
    fs.mkdirSync(path.join(dir, 'split'));
    fs.writeFileSync(path.join(dir, 'split', 'a.cue'), 'FILE "01.flac" WAVE\n TRACK 01 AUDIO\n INDEX 01 00:00:00\nFILE "02.flac" WAVE\n TRACK 02 AUDIO\n INDEX 01 00:00:00\n');
    fs.writeFileSync(path.join(dir, 'split', '01.flac'), 'x');
    fs.writeFileSync(path.join(dir, 'split', '02.flac'), 'x');
    const images = findCueImages(dir);
    assert.equal(images.length, 1);
    assert.equal(images[0].audio[0], path.join(dir, 'album.flac'));
    const cue = normalisedCue(images[0]);
    assert.match(cue, new RegExp(`FILE "${path.join(dir, 'album.flac').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" WAVE`));
    assert.match(cue, /INDEX 00 04:13:40\n {4}INDEX 01 04:15:02/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(isCueTitle('宇多田ヒカル - HEART STATION (FLAC+CUE)'));
  assert.ok(isCueTitle('Artist - Album [APE image+cue]'));
  assert.ok(!isCueTitle('Barracuda - Rescued'));
});

test('Soulseek: a folder of one lossless file plus a cue sheet is an image, and the cue is downloaded too', () => {
  const releases = groupResponses([
    { username: 'peer', hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 1e6, files: [
      { filename: '@@x\\Music\\Utada\\HEART STATION\\CDImage.flac', size: 300e6, bitDepth: 16, sampleRate: 44100 },
      { filename: '@@x\\Music\\Utada\\HEART STATION\\CDImage.cue', size: 2000 },
      { filename: '@@x\\Music\\Utada\\HEART STATION\\folder.jpg', size: 90000 },
    ] },
  ]);
  assert.equal(releases.length, 1);
  assert.equal(releases[0].music?.cue, true);
  assert.equal(releases[0].music?.trackCount, undefined);
  assert.ok(releases[0].music?.files?.some((f) => f.filename.endsWith('.cue')));
});

function execSjis(s: string): Uint8Array {
  // Node has no Shift-JIS encoder; iconv is on macOS and Linux
  return new Uint8Array(execFileSync('iconv', ['-f', 'UTF-8', '-t', 'SHIFT_JIS'], { input: s }));
}

test('fre:ac crash on exit is only forgiven after every file finished', () => {
  const bin = '/usr/bin/freaccmd';
  assert.equal(crashedAfterDone(bin, null, 'SIGSEGV', 'Processing file: /tmp/img.flac...done.'), true);
  assert.equal(crashedAfterDone(bin, 139, null, 'Processing file: a.wav...\ndone.\nProcessing file: b.wav...done.'), true);
  assert.equal(crashedAfterDone(bin, null, 'SIGSEGV', 'Processing file: a.wav...done.\nProcessing file: b.wav...'), false);
  assert.equal(crashedAfterDone(bin, null, 'SIGSEGV', 'File not found: nope.flac'), false);
  assert.equal(crashedAfterDone(bin, null, 'SIGSEGV', 'Could not process file: bad.flac'), false);
  assert.equal(crashedAfterDone(bin, null, 'SIGSEGV', 'Processing file: a.wav...done.\n\nError: Unable to create output file: a.flac\naborted.'), false);
  assert.equal(crashedAfterDone(bin, 1, null, 'Processing file: a.wav...done.'), false);
  assert.equal(crashedAfterDone('/usr/bin/ffmpeg', null, 'SIGSEGV', 'Processing file: a.wav...done.'), false);
});
