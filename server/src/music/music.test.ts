import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import type { Release } from '../../../shared/types.js';
import { BUILTIN_PROFILES } from '../../../shared/presets.js';
import { discId, discLookupIsExact, mapMbRelease, parseCdparanoiaToc, parseTocPlist, tocString } from './musicbrainz.js';
import { formatLabel, musicCategory, musicFormatFromText } from './format.js';
import { cdTrackTags, VARIOUS_ARTISTS } from './tags.js';
import { cddbDiscId, cddbQueryArgs, cddbUrl, DEFAULT_HELLO, parseCddbQuery, parseXmcd, toRelease } from './cddb.js';
import { crashedAfterDone, freacEncoderArgs } from './freac.js';
import { toolError } from '../spawnError.js';
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

test('tool errors explain themselves', () => {
  const wrongArch = { errno: -86, code: 'UNKNOWN', message: 'spawn Unknown system error -86' };
  assert.match(toolError(wrongArch, '/usr/local/bin/ffmpeg'), /different processor|Apple silicon/);
  assert.match(toolError({ code: 'ENOENT' }, '/usr/bin/freaccmd'), /freaccmd was not found/);
  assert.match(toolError({ code: 'EACCES' }, '/opt/x/ffmpeg'), /not executable/);
  assert.equal(toolError({ message: 'something else' }, 'ffmpeg'), 'something else');
});

test('a disc of a box set maps to its own medium, not to disc 1', () => {
  // shaped like /ws/2/discid/<id>: every medium comes back, each with its disc ids
  const release = {
    id: 'rel-1',
    title: 'The Wall',
    date: '1994-10-10',
    'artist-credit': [{ name: 'Pink Floyd', joinphrase: '', artist: { id: 'pf', name: 'Pink Floyd', 'sort-name': 'Pink Floyd' } }],
    'release-group': { id: 'rg-1', 'first-release-date': '1979-11-30' },
    'label-info': [{ label: { name: 'EMI' }, 'catalog-number': '7243 8 31243 2 9' }],
    media: [
      { position: 1, format: 'CD', discs: [{ id: 'disc-one' }], tracks: [{ id: 't1', position: 1, number: '1', title: 'In the Flesh?', recording: { id: 'r1', title: 'In the Flesh?' } }] },
      { position: 2, format: 'CD', title: 'Side C', discs: [{ id: 'disc-two' }], tracks: [{ id: 't2', position: 1, number: '1', title: 'Hey You', recording: { id: 'r2', title: 'Hey You' } }] },
    ],
  };
  const second = mapMbRelease(release, 'disc-two');
  assert.equal(second.discNumber, 2);
  assert.equal(second.discCount, 2);
  assert.equal(second.tracks[0].title, 'Hey You');
  assert.equal(second.discTitle, 'Side C');
  assert.equal(second.trackCount, 1);
  // the album's year, not this pressing's, and the catalogue number of the physical release
  assert.equal(second.originalDate, '1979-11-30');
  assert.equal(second.date, '1994-10-10');
  assert.equal(second.catalogNumber, '7243 8 31243 2 9');
  // without a disc id it falls back to the first medium
  assert.equal(mapMbRelease(release).tracks[0].title, 'In the Flesh?');
  // two discs of 13 tracks each cannot be told apart by their length, so guessing is refused
  const sameLength = { ...release, media: release.media.map((m) => ({ ...m, discs: [] })) };
  assert.equal(mapMbRelease(sameLength, 'disc-two', 1).discNumber, 1);
});

test('a release search result reports its track count even though it carries no tracks', () => {
  // /ws/2/release?query=… returns media with a track-count and nothing else
  const found = mapMbRelease({
    id: 'rel-2',
    title: 'The Wall',
    'artist-credit': [{ name: 'Pink Floyd', joinphrase: '' }],
    media: [
      { position: 1, format: 'CD', 'track-count': 13 },
      { position: 2, format: 'CD', 'track-count': 13 },
    ],
  });
  assert.deepEqual([found.tracks.length, found.trackCount, found.discCount], [0, 26, 2]);
  assert.equal(found.artist, 'Pink Floyd');
});

test('a ripped CD track is tagged from MusicBrainz, Picard field names and all', () => {
  const rel = mapMbRelease({
    id: 'rel-1',
    title: 'The Wall',
    date: '1994-10-10',
    country: 'XE',
    barcode: '0724383124329',
    'artist-credit': [{ name: 'Pink Floyd', joinphrase: '', artist: { id: 'pf', name: 'Pink Floyd', 'sort-name': 'Floyd, Pink' } }],
    'release-group': { id: 'rg-1', 'first-release-date': '1979-11-30' },
    'label-info': [{ label: { name: 'EMI' }, 'catalog-number': 'CAT-1' }],
    media: [
      { position: 1, format: 'CD', 'track-count': 1, discs: [{ id: 'disc-one' }], tracks: [{ id: 't1', position: 1, number: '1', title: 'In the Flesh?', recording: { id: 'r1', title: 'In the Flesh?' } }] },
      { position: 2, format: 'CD', 'track-count': 1, discs: [{ id: 'disc-two' }], tracks: [{ id: 't2', position: 1, number: '1', title: 'Hey You', recording: { id: 'r2', title: 'Hey You' } }] },
    ],
  }, 'disc-two');
  const tags = cdTrackTags({ rel, cd: { discId: 'disc-two', toc: '', tracks: [], releases: [rel], selected: 0 }, media: { kind: 'album', title: 'The Wall' }, track: 1, trackTotal: 1 });
  assert.equal(tags.TITLE, 'Hey You');
  assert.equal(tags.ALBUMARTISTSORT, 'Floyd, Pink');
  assert.deepEqual([tags.DISCNUMBER, tags.DISCTOTAL, tags.TOTALDISCS], [2, 2, 2]);
  // the pressing and the album both get a date, the way Picard writes them
  assert.deepEqual([tags.DATE, tags.ORIGINALDATE, tags.ORIGINALYEAR], ['1994-10-10', '1979-11-30', '1979']);
  assert.deepEqual([tags.MEDIA, tags.CATALOGNUMBER, tags.BARCODE, tags.RELEASECOUNTRY], ['CD', 'CAT-1', '0724383124329', 'XE']);
  // a recording id and a release-track id are different things; Picard puts each in its own field
  assert.deepEqual([tags.MUSICBRAINZ_TRACKID, tags.MUSICBRAINZ_RELEASETRACKID], ['r2', 't2']);
  assert.equal(tags.MUSICBRAINZ_DISCID, 'disc-two');
  assert.equal(tags.COMPILATION, undefined);
  // no release at all: generic names, and nothing is invented
  const bare = cdTrackTags({ media: { kind: 'album', title: 'Unknown Album', artist: 'Unknown Artist' }, track: 3, trackTotal: 8 });
  assert.deepEqual([bare.TITLE, bare.ARTIST, bare.ALBUM, bare.TRACKNUMBER, bare.TRACKTOTAL], ['Track 3', 'Unknown Artist', 'Unknown Album', 3, 8]);
  assert.deepEqual([bare.DATE, bare.MUSICBRAINZ_ALBUMID, bare.ORIGINALDATE], [undefined, undefined, undefined]);
});

test('a Various Artists disc is tagged as a compilation', () => {
  const rel = mapMbRelease({
    id: 'rel-va',
    title: 'Now That’s What I Call Music! 42',
    'artist-credit': [{ name: 'Various Artists', joinphrase: '', artist: { id: VARIOUS_ARTISTS, name: 'Various Artists' } }],
    media: [{ position: 1, format: 'CD', tracks: [{ position: 1, number: '1', title: 'Song', 'artist-credit': [{ name: 'Someone', joinphrase: '', artist: { id: 'a1', name: 'Someone', 'sort-name': 'Someone' } }] }] }],
  });
  const tags = cdTrackTags({ rel, media: { kind: 'album', title: rel.title }, track: 1, trackTotal: 1 });
  assert.equal(tags.COMPILATION, 1);
  // the track keeps its own artist, the album stays with Various Artists
  assert.deepEqual([tags.ARTIST, tags.ALBUMARTIST, tags.MUSICBRAINZ_ARTISTID], ['Someone', 'Various Artists', 'a1']);
});

test('CDDB disc id and query arguments match the freedb algorithm', () => {
  // The Wall, disc 2 of the 1994 remaster – the TOC MusicBrainz holds for disc id uDAm7lKUREWYqiy5SA5BJ.OI6QM-
  const offsets = [150, 21265, 33285, 48625, 55605, 62142, 90770, 97980, 117235, 137015, 154892, 157160, 181140];
  const toc = { firstTrack: 1, lastTrack: 13, leadout: 188875, offsets, tracks: [] };
  // freedbtest.dyndns.org answers this id with "country a109d40d Pink Floyd / The Wall … (Disc 2)"
  assert.equal(cddbDiscId(toc), 'a109d40d');
  assert.deepEqual(cddbQueryArgs(toc), ['a109d40d', '13', ...offsets.map(String), '2518']);
  // a disc whose checksum byte sets the top bit must not come out negative
  const high = { firstTrack: 1, lastTrack: 1, leadout: 90000, offsets: [150], tracks: [] };
  assert.match(cddbDiscId(high), /^[0-9a-f]{8}$/);
});

test('CDDB query answers: one match, a list, nothing, a refusal', () => {
  assert.deepEqual(parseCddbQuery('200 country a109d40d Pink Floyd / The Wall [1994 Digital Remaster] (Disc 2)'), [
    { category: 'country', discId: 'a109d40d', artist: 'Pink Floyd', title: 'The Wall [1994 Digital Remaster] (Disc 2)', inexact: false },
  ]);
  const list = parseCddbQuery(`210 Found exact matches, list follows (until terminating \`.')
rock a109d489 Pink Floyd / The Wall cd 2
misc a109d493 Pink Floyd / The Wall (CD 2/2)
.`);
  assert.deepEqual(list.map((m) => `${m.category}/${m.discId}`), ['rock/a109d489', 'misc/a109d493']);
  assert.deepEqual(parseCddbQuery('202 No match found'), []);
  // a self-titled album has no " / " in its title line
  assert.deepEqual(parseCddbQuery('200 rock abcd1234 Metallica')[0], { category: 'rock', discId: 'abcd1234', artist: 'Metallica', title: 'Metallica', inexact: false });
  // 211 is the server saying "near enough", which is not the same as "this disc"
  const near = parseCddbQuery(`211 Found inexact matches, list follows (until terminating \`.')
classical c20a6a0f Daniel O'Donnell / The last waltz
data b30a6a0f Daniel O'Donnell / The Last Waltz
.`);
  assert.deepEqual(near.map((m) => m.inexact), [true, true]);
  // but the one filed under the disc id we asked about is this disc, whatever the server called the answer
  assert.equal(toRelease({ artist: 'a', title: 'b', tracks: [] }, near[1], 'b30a6a0f').fuzzy, false);
  assert.equal(toRelease({ artist: 'a', title: 'b', tracks: [] }, near[0], 'b30a6a0f').fuzzy, true);
  // gnudb refuses clients it does not know; the reason has to reach the disc log
  assert.throws(() => parseCddbQuery('500 Unknown application, developer email for rexarr 0.1.7.2'), /Unknown application/);
});

test('an xmcd entry becomes a release match', () => {
  const xmcd = `# xmcd CD database file
#
# Track frame offsets:
#  150
#
# Disc length: 2518 seconds
#
DISCID=a109d40d
DTITLE=Pink Floyd / The Wall [1994 Digital
DTITLE= Remaster] (Disc 2)
DYEAR=1979
DGENRE=Rock
TTITLE0=Hey You
TTITLE1=Is There Anybody Out There?
EXTD=
PLAYORDER=
.`;
  const entry = parseXmcd(xmcd)!;
  // a value split over two lines is joined with nothing between the halves
  assert.equal(entry.title, 'The Wall [1994 Digital Remaster] (Disc 2)');
  assert.deepEqual([entry.artist, entry.year, entry.genre], ['Pink Floyd', 1979, 'Rock']);
  assert.deepEqual(entry.tracks, [
    { number: 1, title: 'Hey You', artist: undefined },
    { number: 2, title: 'Is There Anybody Out There?', artist: undefined },
  ]);

  const rel = toRelease(entry, { category: 'country', discId: 'a109d40d' });
  assert.deepEqual([rel.source, rel.releaseId, rel.date, rel.trackCount], ['cddb', 'country/a109d40d', '1979', 2]);

  // no MusicBrainz ids are invented from a CDDB entry, and the genre and freedb id are written
  const tags = cdTrackTags({ rel, cd: { discId: 'mb-disc-id', toc: '', tracks: [], releases: [rel], selected: 0 }, media: { kind: 'album', title: rel.title }, track: 1, trackTotal: 2 });
  assert.deepEqual([tags.TITLE, tags.GENRE, tags.DISCID, tags.MEDIA], ['Hey You', 'Rock', 'a109d40d', 'CD']);
  assert.deepEqual([tags.MUSICBRAINZ_ALBUMID, tags.MUSICBRAINZ_TRACKID, tags.MUSICBRAINZ_ALBUMARTISTID], [undefined, undefined, undefined]);
  // the disc id Rexarr computed itself is still true, whoever named the disc
  assert.equal(tags.MUSICBRAINZ_DISCID, 'mb-disc-id');
  // a compilation puts the performer in front of each title
  const va = parseXmcd('DTITLE=Various / Now 42\nTTITLE0=Robbie Williams / Angels\n.')!;
  assert.deepEqual(va.tracks[0], { number: 1, title: 'Angels', artist: 'Robbie Williams' });
});

test('the CDDB server setting may be a bare endpoint or a whole URL with the handshake in it', () => {
  const cmd = ['cddb', 'query', 'a109d40d', '1', '150', '2518'];
  // the plain case: Rexarr adds the command, its own hello and the protocol level
  const plain = new URL(cddbUrl('https://freedbtest.dyndns.org/~cddb/cddb.cgi', cmd));
  assert.equal(plain.origin + plain.pathname, 'https://freedbtest.dyndns.org/~cddb/cddb.cgi');
  assert.equal(plain.searchParams.get('cmd'), 'cddb query a109d40d 1 150 2518');
  assert.equal(plain.searchParams.get('hello'), DEFAULT_HELLO);
  assert.equal(plain.searchParams.get('proto'), '6');
  // the protocol wants the spaces as +, not %20
  assert.match(plain.toString(), /cmd=cddb\+query\+a109d40d/);

  // gnudb publishes its service as a whole URL, handshake and all: keep that hello, replace only the command
  const pasted = cddbUrl('gnudb.gnudb.org/~cddb/cddb.cgi?cmd=cddb+read+data+4105d789&hello=emailname+emailhost.com+applicationname+0.1&proto=6', cmd);
  const u = new URL(pasted);
  assert.equal(u.protocol, 'https:'); // no scheme pasted, so https
  assert.equal(u.searchParams.get('hello'), 'emailname emailhost.com applicationname 0.1');
  assert.equal(u.searchParams.get('cmd'), 'cddb query a109d40d 1 150 2518');
  assert.match(pasted, /hello=emailname\+emailhost\.com\+applicationname\+0\.1/);

  // cddbd parses the query string in order: cmd has to come first or it answers "500 Command syntax error"
  const reordered = cddbUrl('https://gnudb.gnudb.org/~cddb/cddb.cgi?hello=name+host.com+app+0.1&proto=6', cmd);
  assert.match(reordered, /\?cmd=cddb\+query\+.*&hello=name\+host\.com\+app\+0\.1&proto=6$/);

  assert.throws(() => cddbUrl('   ', cmd), /no CDDB server/);
});

test('a release MusicBrainz only guessed at is marked, and never becomes the disc on its own', () => {
  // the shape of an answer for the disc id itself: it echoes the id and the TOC it was asked about
  const exact = { id: 'disc-one', sectors: 188875, offsets: [150], releases: [{ id: 'rel-1', title: 'The Wall', media: [{ position: 1, discs: [{ id: 'disc-one' }], tracks: [{ position: 1, number: '1', title: 'Hey You' }] }] }] };
  // and of a ?toc= answer, which is a search result for releases of a similar length and nothing more
  const fuzzy = { 'release-count': 1, 'release-offset': 0, releases: exact.releases };
  assert.equal(discLookupIsExact(exact, 'disc-one'), true);
  assert.equal(discLookupIsExact(fuzzy, 'disc-one'), false);
  // the id of a different disc is not this disc either
  assert.equal(discLookupIsExact({ ...exact, id: 'disc-two' }, 'disc-one'), false);
});
