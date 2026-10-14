import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DiscRip, DiscTitle } from '../../../shared/types.js';
import { BUILTIN_PROFILES, BUILTIN_SMART_PROFILES } from '../../../shared/presets.js';
import { estimateRip } from './estimate.js';

/** One 24-minute DVD title with a lossless stereo track and a lossy 5.1 one. */
const title = (id: number, over: Partial<DiscTitle> = {}): DiscTitle =>
  ({
    id,
    name: `Title ${id}`,
    durationSeconds: 1440,
    sizeBytes: 2_000_000_000,
    resolution: '1920x1080',
    frameRate: '23.976',
    videoCodec: 'MPEG-4 AVC',
    audioTracks: [
      { index: 0, codec: 'FLAC', channels: 2, language: 'eng', bitrateKbps: 900, name: 'FLAC 2.0' },
      { index: 1, codec: 'Dolby Digital', channels: 6, language: 'eng', bitrateKbps: 448, name: 'DD 5.1' },
    ],
    subtitles: [],
    ...over,
  }) as DiscTitle;

const rip = (titles: DiscTitle[], over: Partial<DiscRip> = {}): DiscRip =>
  ({
    id: 'r', driveIndex: 0, source: 'disc:0', drivePath: '', driveName: '', label: 'DISC', volumeName: '',
    discType: 'bluray', status: 'ready',
    media: { kind: 'movie', title: 'Something', year: 2024 },
    titles, selectedTitleIds: titles.map((t) => t.id),
    options: { transcode: true, importToArr: false, eject: false, keepRaw: false },
    files: [], progress: { percent: 0, step: '', titleIndex: 0, titleCount: 0 },
    ...over,
  }) as unknown as DiscRip;

const stereoOnly = (id: number) => title(id, { audioTracks: [{ index: 0, codec: 'LPCM', channels: 2, language: 'eng', bitrateKbps: 1536, name: 'LPCM 2.0' }] as DiscTitle['audioTracks'] });

test('a disc rip is estimated with a smart profile, decided per title', () => {
  const smart = BUILTIN_SMART_PROFILES.find((p) => p.id === 'builtin-smart-lossless-audio')!;
  // a title whose only lossless track is stereo is exactly what this profile turns into FLAC
  const e = estimateRip(rip([stereoOnly(1)]), smart, 'all');
  assert.ok(e.transcode, 'a smart profile produces an estimate like any other');
  assert.equal(e.transcode.profileName, smart.name);
  assert.equal(e.transcode.smart, true);
  assert.match(e.transcode.resolved ?? '', /flac/);
  assert.ok(e.transcode.bytes > 0);

  // and the same profile leaves a disc that also carries 5.1 alone, which is the point of it
  const mixed = estimateRip(rip([title(1)]), smart, 'all');
  assert.equal(mixed.transcode?.resolved, 'copy + copy');
});

test('two titles that settle differently are both counted, and both named', () => {
  const smart = BUILTIN_SMART_PROFILES.find((p) => p.id === 'builtin-smart-lossless-audio')!;
  const e = estimateRip(rip([stereoOnly(1), title(2)]), smart, 'all');
  // one title becomes FLAC and the other is left alone; the estimate says so rather than picking one
  assert.equal(e.transcode?.resolved?.split(', ').length, 2);
  assert.equal(e.titleCount, 2);
  const alone = estimateRip(rip([stereoOnly(1)]), smart, 'all');
  assert.ok(e.transcode!.bytes > alone.transcode!.bytes, 'two titles are bigger than one');
});

test('a plain profile is unchanged by any of this', () => {
  const plain = BUILTIN_PROFILES.find((p) => p.id === 'builtin-movie-1080p')!;
  const e = estimateRip(rip([title(1), title(2)]), plain, 'all');
  assert.ok(e.transcode);
  assert.equal(e.transcode.smart, undefined);
  assert.equal(e.transcode.resolved, undefined);
  assert.equal(e.titleCount, 2);
});

test('no profile, or no transcode, means no transcode estimate - only the rip size', () => {
  const r = rip([title(1)]);
  assert.equal(estimateRip(r, undefined, 'all').transcode, undefined);
  assert.equal(estimateRip({ ...r, options: { ...r.options, transcode: false } }, BUILTIN_PROFILES[0], 'all').transcode, undefined);
  assert.ok(estimateRip(r, undefined, 'all').ripBytes > 0, 'the rip itself is still sized');
});
