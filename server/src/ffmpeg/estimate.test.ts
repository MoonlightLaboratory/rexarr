import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProbeResult } from './probe.js';
import { estimateSize } from './estimate.js';
import { BUILTIN_PROFILES } from '../../../shared/presets.js';

const GB = 1e9;
const remux4k: ProbeResult = {
  path: '/m/Movie Remux-2160p.mkv',
  durationSeconds: 7200,
  sizeBytes: 60 * GB,
  bitRate: 66_000_000,
  formatName: 'matroska,webm',
  streams: [],
  video: { index: 0, codec_type: 'video', codec_name: 'hevc', width: 3840, height: 2160, color_transfer: 'smpte2084', color_primaries: 'bt2020', tags: { BPS: '58000000' } },
  audio: [
    { index: 1, codec_type: 'audio', codec_name: 'truehd', channels: 8, tags: { language: 'eng', BPS: '4500000' } },
    { index: 2, codec_type: 'audio', codec_name: 'ac3', channels: 6, tags: { language: 'eng', title: 'Commentary', BPS: '640000' } },
  ],
  subtitles: [{ index: 3, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', tags: { language: 'eng', BPS: '40000' } }],
  attachments: [],
  isHdr: true,
  isDolbyVision: false,
  frameRate: 23.976,
};
remux4k.streams = [remux4k.video!, ...remux4k.audio, ...remux4k.subtitles];
const byName = (n: string) => structuredClone(BUILTIN_PROFILES.find((p) => p.name === n)!);

test('size estimates: plausible, ordered by quality, ranges around the guess', () => {
  const hdr = estimateSize(byName('Movie · 4K HDR x265'), remux4k);
  assert.ok(hdr.bytes > 8 * GB && hdr.bytes < 40 * GB, `4K HDR x265 of a 60 GB remux: ${hdr.bytes / GB} GB`);
  assert.ok(hdr.low < hdr.bytes && hdr.bytes < hdr.high);
  const p1080 = estimateSize(byName('Movie · 1080p x265'), remux4k);
  assert.ok(p1080.bytes < hdr.bytes, 'downscaled 1080p is smaller than 4K');
  const lowerCrf = byName('Movie · 4K HDR x265');
  lowerCrf.video.quality -= 6;
  assert.ok(Math.abs(estimateSize(lowerCrf, remux4k).parts.video / hdr.parts.video - 2) < 0.3, '6 CRF steps ≈ double the video');
  const keep = estimateSize(byName('Remux · Keep video, Opus audio'), remux4k);
  assert.ok(keep.parts.video > 50 * GB && keep.parts.video < 55 * GB, 'copied video keeps its bitrate');
});

test('music estimates: MP3 320 from bitrate, FLAC close to a lossless source', () => {
  const flacSrc: ProbeResult = { path: '/a/01.flac', durationSeconds: 240, sizeBytes: 30_000_000, bitRate: 1_000_000, formatName: 'flac', streams: [], audio: [{ index: 0, codec_type: 'audio', codec_name: 'flac', channels: 2, sample_rate: '44100', tags: {} }], subtitles: [], attachments: [], isHdr: false, isDolbyVision: false, frameRate: 0 };
  flacSrc.streams = [...flacSrc.audio];
  const mp3 = estimateSize(byName('Music · MP3 320 (LAME)'), flacSrc);
  assert.ok(Math.abs(mp3.bytes - (320_000 * 240) / 8) < 200_000, `mp3 320: ${mp3.bytes}`);
  const flac = estimateSize(byName('Music · FLAC (lossless, keeps MQA)'), flacSrc);
  assert.ok(flac.bytes > 20_000_000 && flac.bytes < 40_000_000, `flac: ${flac.bytes}`);
});
