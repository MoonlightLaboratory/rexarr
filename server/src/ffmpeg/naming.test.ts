import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EncodeDescription } from './naming.js';
import { audioTrackTitle, describeEncode, renameForEncode, resolutionClass } from './naming.js';
import { BUILTIN_PROFILES } from '../../../shared/presets.js';
import type { ProbeResult } from './probe.js';

const uhd: EncodeDescription = { resolution: '2160p', videoCodec: 'x265', videoCodecName: 'HEVC', videoCopied: false, tenBit: true, hdr: true, dolbyVision: false, audio: { codec: 'Opus', channels: '7.1', copied: false, atmos: false } };
const fhd: EncodeDescription = { ...uhd, resolution: '1080p' };
const sdr264: EncodeDescription = { resolution: '1080p', videoCodec: 'x264', videoCodecName: 'H.264', videoCopied: false, tenBit: false, hdr: false, dolbyVision: false, audio: { codec: 'AAC', channels: '2.0', copied: false, atmos: false } };

test('arr-style names lose Remux and follow the output resolution', () => {
  assert.equal(renameForEncode('Blade Runner 2049 (2017) Remux-2160p', uhd), 'Blade Runner 2049 (2017) Bluray-2160p');
  assert.equal(renameForEncode('Blade Runner 2049 (2017) Remux-2160p', fhd), 'Blade Runner 2049 (2017) Bluray-1080p');
  assert.equal(renameForEncode('Frieren - S01E05 - Phantoms of the Dead - Bluray-1080p Remux', sdr264), 'Frieren - S01E05 - Phantoms of the Dead - Bluray-1080p');
  assert.equal(renameForEncode('Movie (2019) {imdb-tt123} [Remux-1080p][DTS-HD MA 5.1][AVC]-GRP', fhd), 'Movie (2019) {imdb-tt123} [Bluray-1080p][Opus 7.1][10bit x265]-GRP');
});

test('scene names get the encode codec, audio, HDR and bit depth', () => {
  assert.equal(renameForEncode('Blade.Runner.2049.2017.2160p.UHD.BluRay.REMUX.DV.HDR.HEVC.TrueHD.Atmos.7.1-FraMeSToR', uhd), 'Blade.Runner.2049.2017.2160p.UHD.BluRay.HDR.10bit.x265.Opus.7.1-FraMeSToR');
  assert.equal(renameForEncode('Blade.Runner.2049.2017.2160p.UHD.BluRay.REMUX.DV.HDR.HEVC.TrueHD.Atmos.7.1-FraMeSToR', fhd), 'Blade.Runner.2049.2017.1080p.BluRay.HDR.10bit.x265.Opus.7.1-FraMeSToR');
  assert.equal(renameForEncode('Movie.2020.1080p.BluRay.REMUX.AVC.DTS-HD.MA.5.1-GRP', sdr264), 'Movie.2020.1080p.BluRay.x264.AAC.2.0-GRP');
  assert.equal(renameForEncode('Some.Movie.2020.1080p.BDRemux.AVC.DTS-HD.MA-GRP', sdr264), 'Some.Movie.2020.1080p.BluRay.x264.AAC.2.0-GRP');
  assert.equal(renameForEncode('Dune.Part.Two.2024.2160p.UHD.BluRay.REMUX.DV.HEVC.TrueHD.7.1.Atmos-GRP', uhd), 'Dune.Part.Two.2024.2160p.UHD.BluRay.HDR.10bit.x265.Opus.7.1-GRP');
  // SDR 8-bit output drops HDR tags
  assert.equal(renameForEncode('Movie.2020.2160p.UHD.BluRay.REMUX.HDR.HEVC.TrueHD.7.1-GRP', { ...sdr264, resolution: '1080p' }), 'Movie.2020.1080p.BluRay.x264.AAC.2.0-GRP');
  // copied audio keeps its codec and Atmos
  assert.equal(renameForEncode('Show.S01E01.1080p.BluRay.Remux.AVC.TrueHD.Atmos.7.1-GRP', { ...fhd, hdr: false, audio: { codec: 'TrueHD', channels: '7.1', copied: true, atmos: true } }), 'Show.S01E01.1080p.BluRay.10bit.x265.TrueHD.Atmos.7.1-GRP');
});

test('names without release tokens are left alone', () => {
  assert.equal(renameForEncode('Home Video', fhd), 'Home Video');
  assert.equal(renameForEncode('Test DVD (2024) DVD', sdr264), 'Test DVD (2024) DVD');
});

test('describeEncode and track titles', () => {
  assert.equal(resolutionClass(1920, 800), '1080p');
  assert.equal(resolutionClass(3840, 1600), '2160p');
  const probe = { video: { index: 0, codec_type: 'video', codec_name: 'hevc', width: 3840, height: 2160, pix_fmt: 'yuv420p10le' }, audio: [], subtitles: [], attachments: [], streams: [], isHdr: true, isDolbyVision: true } as unknown as ProbeResult;
  const hdr = BUILTIN_PROFILES.find((p) => p.id === 'builtin-movie-4k-hdr')!;
  const d = describeEncode(hdr, probe);
  assert.equal(d.resolution, '2160p');
  assert.equal(d.videoCodec, 'x265');
  assert.equal(d.hdr, true);
  assert.equal(d.dolbyVision, false);
  const d2 = describeEncode({ ...hdr, video: { ...hdr.video, maxHeight: 1080 } }, probe);
  assert.equal(d2.resolution, '1080p');
  const stream = { index: 1, codec_type: 'audio', codec_name: 'truehd', channels: 8, tags: { language: 'eng', title: 'TrueHD Atmos 7.1' } } as never;
  assert.equal(audioTrackTitle({ stream, encoder: 'libopus', channels: 8 }), 'English · Opus 7.1');
  assert.equal(audioTrackTitle({ stream, encoder: 'copy', channels: 8 }), 'TrueHD Atmos 7.1');
  const commentary = { index: 2, codec_type: 'audio', codec_name: 'ac3', channels: 2, tags: { language: 'eng', title: 'Director commentary' } } as never;
  assert.equal(audioTrackTitle({ stream: commentary, encoder: 'aac', channels: 2 }), 'English · AAC 2.0 · Commentary');
});
