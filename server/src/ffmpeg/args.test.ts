import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Profile } from '../../../shared/types.js';
import { BUILTIN_PROFILES } from '../../../shared/presets.js';
import { buildFfmpegArgs, outputPathFor, splitArgs } from './args.js';
import type { ProbeResult } from './probe.js';

function probe(over: Partial<ProbeResult> = {}): ProbeResult {
  const streams = [
    { index: 0, codec_type: 'video', codec_name: 'hevc', width: 3840, height: 2160, color_primaries: 'bt2020', color_transfer: 'smpte2084', color_space: 'bt2020nc', tags: {} },
    { index: 1, codec_type: 'audio', codec_name: 'truehd', channels: 8, tags: { language: 'eng', title: 'TrueHD 7.1' } },
    { index: 2, codec_type: 'audio', codec_name: 'dts', channels: 6, tags: { language: 'jpn' } },
    { index: 3, codec_type: 'audio', codec_name: 'ac3', channels: 2, tags: { language: 'eng', title: 'Commentary by the director' } },
    { index: 4, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng' } },
    { index: 5, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', tags: { language: 'eng' }, disposition: { forced: 1 } },
    { index: 6, codec_type: 'subtitle', codec_name: 'ass', tags: { language: 'jpn' } },
    { index: 7, codec_type: 'attachment', codec_name: 'ttf', tags: {} },
  ] as ProbeResult['streams'];
  return {
    path: '/in/movie.mkv',
    durationSeconds: 100,
    sizeBytes: 1,
    bitRate: 1,
    formatName: 'matroska',
    streams,
    video: streams[0],
    audio: streams.filter((s) => s.codec_type === 'audio'),
    subtitles: streams.filter((s) => s.codec_type === 'subtitle'),
    attachments: streams.filter((s) => s.codec_type === 'attachment'),
    isHdr: true,
    isDolbyVision: false,
    frameRate: 24,
    ...over,
  };
}

const byId = (id: string) => BUILTIN_PROFILES.find((p) => p.id === id)!;

function argAfter(args: string[], flag: string, nth = 0) {
  let seen = 0;
  for (let i = 0; i < args.length; i++) if (args[i] === flag && seen++ === nth) return args[i + 1];
  return undefined;
}
function maps(args: string[]) {
  return args.filter((_, i) => args[i - 1] === '-map');
}

test('anime preset: x265 10-bit animation tune, jpn+eng opus, subs+fonts kept', () => {
  const r = buildFfmpegArgs(byId('builtin-anime-x265'), probe(), '/in/movie.mkv', '/out/movie.mkv');
  const a = r.args;
  assert.equal(argAfter(a, '-c:v'), 'libx265');
  assert.equal(argAfter(a, '-crf'), '18');
  assert.equal(argAfter(a, '-tune'), 'animation');
  assert.equal(argAfter(a, '-profile:v'), 'main10');
  assert.ok(a.includes('format=yuv420p10le') || a.some((x) => x.includes('format=yuv420p10le')));
  // commentary dropped, both jpn and eng kept
  assert.deepEqual(maps(a), ['0:0', '0:1', '0:2', '0:4', '0:5', '0:6', '0:t?']);
  assert.equal(argAfter(a, '-c:a:0'), 'libopus');
  assert.equal(argAfter(a, '-b:a:0'), '192k');
  assert.equal(argAfter(a, '-c:t'), 'copy');
  assert.equal(a[a.length - 1], '/out/movie.mkv');
  assert.equal(argAfter(a, '-f'), 'matroska');
});

test('HDR passthrough adds colour flags and x265 hdr params', () => {
  const r = buildFfmpegArgs(byId('builtin-movie-4k-hdr'), probe(), '/in/movie.mkv', '/out/movie.mkv');
  const a = r.args;
  assert.equal(argAfter(a, '-color_trc'), 'smpte2084');
  assert.equal(argAfter(a, '-colorspace'), 'bt2020nc');
  assert.match(argAfter(a, '-x265-params')!, /hdr10=1/);
  assert.equal(argAfter(a, '-c:a:0'), 'copy');
});

test('web mp4 preset drops bitmap subs, converts text subs, downscales and uses hvc1/faststart rules', () => {
  const r = buildFfmpegArgs(byId('builtin-web-mp4'), probe(), '/in/movie.mkv', '/out/movie.mp4');
  const a = r.args;
  assert.equal(argAfter(a, '-c:v'), 'libx264');
  assert.ok(argAfter(a, '-vf')!.includes('scale=-2:1080'));
  assert.ok(!maps(a).includes('0:5'), 'PGS should be dropped for mp4');
  assert.ok(!maps(a).includes('0:t?'), 'attachments not allowed in mp4');
  assert.equal(argAfter(a, '-c:s:0'), 'mov_text');
  assert.equal(argAfter(a, '-c:a:0'), 'aac');
  assert.equal(argAfter(a, '-ac:a:0'), '2');
  assert.ok(a.includes('+faststart'));
  // copy-text mode drops bitmap subs silently; plain copy mode should warn about it.
  const web = byId('builtin-web-mp4');
  const copyMode = buildFfmpegArgs({ ...web, subtitles: { ...web.subtitles, mode: 'copy' } }, probe(), '/in/movie.mkv', '/out/movie.mp4');
  assert.ok(copyMode.warnings.some((w) => /bitmap subtitle/.test(w)));
});

test('copy video with truehd into mp4 falls back to aac and warns', () => {
  const p: Profile = { ...byId('builtin-remux-audio-only'), container: 'mp4', audio: { ...byId('builtin-remux-audio-only').audio, encoder: 'copy' } };
  const r = buildFfmpegArgs(p, probe(), '/in/movie.mkv', '/out/movie.mp4');
  assert.equal(argAfter(r.args, '-c:a:0'), 'aac');
  assert.ok(r.warnings.some((w) => /truehd/.test(w)));
});

test('burn-in picks forced PGS via overlay filter_complex', () => {
  const base = byId('builtin-movie-1080p');
  const p: Profile = { ...base, subtitles: { ...base.subtitles, mode: 'burn', burnLanguage: 'eng', burnForcedOnly: true } };
  const r = buildFfmpegArgs(p, probe(), '/in/movie.mkv', '/out/movie.mkv');
  const fc = argAfter(r.args, '-filter_complex')!;
  assert.match(fc, /\[0:5\]overlay\[vout\]/);
  assert.ok(maps(r.args).includes('[vout]'));
  assert.ok(!maps(r.args).includes('0:4'), 'no subtitle streams copied when burning');
});

test('burn-in of text subtitle uses subtitles filter with escaped path', () => {
  const base = byId('builtin-movie-1080p');
  const p: Profile = { ...base, subtitles: { ...base.subtitles, mode: 'burn', burnLanguage: 'jpn' } };
  const r = buildFfmpegArgs(p, probe(), "/in/it's a: movie.mkv", '/out/movie.mkv');
  const vf = argAfter(r.args, '-vf')!;
  assert.match(vf, /subtitles='\/in\/it\\'s a\\: movie.mkv':si=2/);
});

test('language fallback keeps first track when nothing matches', () => {
  const base = byId('builtin-tv-1080p');
  const p: Profile = { ...base, audio: { ...base.audio, languages: ['fre'] } };
  const r = buildFfmpegArgs(p, probe(), '/in/x.mkv', '/out/x.mkv');
  assert.ok(maps(r.args).includes('0:1'));
  assert.ok(!maps(r.args).includes('0:2'));
});

test('hardware encoder families get their own rate-control flags', () => {
  const nv = buildFfmpegArgs(byId('builtin-hw-nvenc'), probe({ isHdr: false }), '/in/x.mkv', '/out/x.mkv').args;
  assert.equal(argAfter(nv, '-cq'), '24');
  assert.equal(argAfter(nv, '-preset'), 'p6');
  assert.equal(argAfter(nv, '-hwaccel'), 'cuda');
  const vt = buildFfmpegArgs(byId('builtin-hw-videotoolbox'), probe({ isHdr: false }), '/in/x.mkv', '/out/x.mkv').args;
  assert.equal(argAfter(vt, '-q:v'), '60');
  assert.equal(argAfter(vt, '-c:v'), 'hevc_videotoolbox');
});

test('extra args are appended and quoted strings are honoured', () => {
  assert.deepEqual(splitArgs(`-x265-params "aq-mode=3:psy-rd=2" -g 240`), ['-x265-params', 'aq-mode=3:psy-rd=2', '-g', '240']);
  const r = buildFfmpegArgs(byId('builtin-anime-av1'), probe({ isHdr: false }), '/in/x.mkv', '/out/x.mkv').args;
  assert.equal(argAfter(r, '-svtav1-params'), 'tune=0:film-grain=0');
  assert.equal(argAfter(r, '-preset'), '6');
});

test('output path never collides with the input', () => {
  const p = byId('builtin-movie-1080p');
  assert.equal(outputPathFor(p, '/in/Movie.mkv'), '/in/Movie.rexarr.mkv');
  assert.equal(outputPathFor({ ...p, output: { ...p.output, suffix: '-x265' } }, '/in/Movie.mkv'), '/in/Movie-x265.mkv');
  assert.equal(outputPathFor({ ...p, output: { ...p.output, directory: '/out' } }, '/in/Movie.mkv'), '/out/Movie.mkv');
  assert.equal(outputPathFor(byId('builtin-web-mp4'), '/in/Movie.mkv'), '/in/Movie.mp4');
});

test('sample profiles all build against the sample probe without throwing', () => {
  for (const p of BUILTIN_PROFILES) buildFfmpegArgs(p, probe(), '/in/x.mkv', `/out/x.${p.container}`);
});

// ---------------------------------------------------------------------------------------------
// Settings → Transcoding (hardware acceleration)
// ---------------------------------------------------------------------------------------------
const hwSettings = (method: string, extra: Record<string, unknown> = {}) => ({ hardwareAcceleration: method, device: '', hardwareDecoding: true, fallbackToSoftware: true, ...extra }) as any;

test('VAAPI maps x265 to hevc_vaapi, uses the render node and keeps frames on the GPU', () => {
  const p = byId('builtin-movie-1080p');
  const r = buildFfmpegArgs({ ...p, video: { ...p.video, maxHeight: 1080 } }, probe({ isHdr: false }), '/in/x.mkv', '/out/x.mkv', { hardware: hwSettings('vaapi', { device: '/dev/dri/renderD129' }) });
  const a = r.args;
  assert.equal(argAfter(a, '-c:v'), 'hevc_vaapi');
  assert.equal(argAfter(a, '-init_hw_device'), 'vaapi=va:/dev/dri/renderD129');
  assert.equal(argAfter(a, '-hwaccel_output_format'), 'vaapi');
  assert.equal(argAfter(a, '-vf'), 'scale_vaapi=w=-2:h=1080:format=p010');
  assert.equal(argAfter(a, '-qp'), '24'); // CRF 20 → QP 24
  assert.ok(r.summary.some((s) => /hevc_vaapi/.test(s)));
});

test('VAAPI falls back to CPU frames + hwupload when subtitles are burned in', () => {
  const p = byId('builtin-movie-1080p');
  const r = buildFfmpegArgs({ ...p, subtitles: { ...p.subtitles, mode: 'burn', burnLanguage: 'jpn' } }, probe({ isHdr: false }), '/in/x.mkv', '/out/x.mkv', { hardware: hwSettings('vaapi') });
  assert.equal(argAfter(r.args, '-hwaccel_output_format'), undefined);
  assert.match(argAfter(r.args, '-vf')!, /subtitles=.*,format=p010le,hwupload$/);
  assert.equal(argAfter(r.args, '-init_hw_device'), 'vaapi=va:/dev/dri/renderD128');
});

test('codec the method cannot encode stays on the CPU with a warning', () => {
  const r = buildFfmpegArgs(byId('builtin-anime-av1'), probe({ isHdr: false }), '/in/x.mkv', '/out/x.mkv', { hardware: hwSettings('videotoolbox') });
  assert.equal(argAfter(r.args, '-c:v'), 'libsvtav1');
  assert.ok(r.warnings.some((w) => /cannot encode AV1/.test(w)));
});

test('profile set to software only ignores hardware acceleration', () => {
  const p = byId('builtin-anime-x265');
  const r = buildFfmpegArgs({ ...p, video: { ...p.video, hwMode: 'software' } }, probe({ isHdr: false }), '/in/x.mkv', '/out/x.mkv', { hardware: hwSettings('nvenc') });
  assert.equal(argAfter(r.args, '-c:v'), 'libx265');
  assert.equal(argAfter(r.args, '-tune'), 'animation');
});

test('NVENC mapping translates quality / preset and selects the GPU', () => {
  const r = buildFfmpegArgs(byId('builtin-anime-x265'), probe({ isHdr: false }), '/in/x.mkv', '/out/x.mkv', { hardware: hwSettings('nvenc', { device: '1' }) });
  const a = r.args;
  assert.equal(argAfter(a, '-c:v'), 'hevc_nvenc');
  assert.equal(argAfter(a, '-cq'), '20'); // CRF 18 → CQ 20
  assert.equal(argAfter(a, '-preset'), 'p5'); // slow
  assert.equal(argAfter(a, '-gpu'), '1');
  assert.equal(argAfter(a, '-hwaccel_device'), '1');
  assert.equal(argAfter(a, '-tune'), 'hq'); // software "animation" tune dropped
});

test('mapping is skipped when the encoder is missing from this ffmpeg build', () => {
  const r = buildFfmpegArgs(byId('builtin-movie-1080p'), probe({ isHdr: false }), '/in/x.mkv', '/out/x.mkv', { hardware: hwSettings('qsv'), availableEncoders: ['libx265'] as any });
  assert.equal(argAfter(r.args, '-c:v'), 'libx265');
  assert.ok(r.warnings.some((w) => /not available in this ffmpeg/.test(w)));
});

test('Rockchip, V4L2 and QSV get their own options; hardware H.264 is 8-bit', () => {
  const p = byId('builtin-movie-1080p');
  const rk = buildFfmpegArgs(p, probe({ isHdr: false }), '/in/x.mkv', '/out/x.mkv', { hardware: hwSettings('rkmpp') }).args;
  assert.equal(argAfter(rk, '-c:v'), 'hevc_rkmpp');
  assert.equal(argAfter(rk, '-qp_init'), '23');
  const v4 = buildFfmpegArgs(p, probe({ isHdr: false }), '/in/x.mkv', '/out/x.mkv', { hardware: hwSettings('v4l2') });
  assert.equal(argAfter(v4.args, '-c:v'), 'hevc_v4l2m2m');
  assert.match(argAfter(v4.args, '-b:v')!, /^\d+k$/);
  const web = buildFfmpegArgs({ ...byId('builtin-web-mp4'), video: { ...byId('builtin-web-mp4').video, pixelFormat: 'yuv420p10le' } }, probe({ isHdr: false }), '/in/x.mkv', '/out/x.mp4', { hardware: hwSettings('qsv') });
  assert.equal(argAfter(web.args, '-c:v'), 'h264_qsv');
  assert.match(argAfter(web.args, '-vf')!, /format=nv12/);
  if (process.platform !== 'win32') assert.ok(web.args.includes('qsv=qs@va'));
});

test('live preview is a second image output, skipped when video is copied', () => {
  const r = buildFfmpegArgs(byId('builtin-movie-1080p'), probe({ isHdr: false }), '/in/x.mkv', '/out/x.mkv', { previewPath: '/t/job__preview.jpg' });
  const a = r.args;
  assert.equal(a[a.length - 1], '/t/job__preview.jpg');
  assert.ok(a.indexOf('/out/x.mkv') < a.indexOf('/t/job__preview.jpg'), 'main output comes first so progress tracks it');
  assert.equal(argAfter(a, '-update'), '1');
  const copy = buildFfmpegArgs(byId('builtin-remux-audio-only'), probe({ isHdr: false }), '/in/x.mkv', '/out/x.mkv', { previewPath: '/t/p.jpg' }).args;
  assert.ok(!copy.includes('/t/p.jpg'));
});
