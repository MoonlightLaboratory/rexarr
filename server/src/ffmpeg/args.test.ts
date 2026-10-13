import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Profile } from '../../../shared/types.js';
import { BUILTIN_PROFILES } from '../../../shared/presets.js';
import { buildFfmpegArgs, outputPathFor, selectAudio, subtitlesToOcr, withoutOcr, splitArgs } from './args.js';
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

// ---- one language, several tracks ---------------------------------------------------------------
// What a disc actually hands you: English three times over, and Japanese once.
function discProbe(): ProbeResult {
  const streams = [
    { index: 0, codec_type: 'video', codec_name: 'hevc', width: 3840, height: 2160, tags: {} },
    { index: 1, codec_type: 'audio', codec_name: 'ac3', channels: 2, bit_rate: '192000', tags: { language: 'eng', title: 'Dolby Digital 2.0' } },
    { index: 2, codec_type: 'audio', codec_name: 'truehd', channels: 6, bit_rate: '4000000', profile: 'Dolby TrueHD + Dolby Atmos', tags: { language: 'eng', title: 'TrueHD 5.1' } },
    { index: 3, codec_type: 'audio', codec_name: 'ac3', channels: 6, bit_rate: '640000', tags: { language: 'eng', title: 'Dolby Digital 5.1' } },
    { index: 4, codec_type: 'audio', codec_name: 'dts', channels: 6, bit_rate: '768000', tags: { language: 'jpn' } },
  ] as ProbeResult['streams'];
  return {
    path: '/in/disc.mkv', durationSeconds: 100, sizeBytes: 1, bitRate: 1, formatName: 'matroska', streams,
    video: streams[0], audio: streams.filter((s) => s.codec_type === 'audio'), subtitles: [], attachments: [],
    isHdr: false, isDolbyVision: false, frameRate: 24,
  };
}
const discProfile = (perLanguage: Profile['audio']['perLanguage']): Profile => ({
  ...byId('builtin-movie-1080p'),
  audio: { ...byId('builtin-movie-1080p').audio, encoder: 'copy', languages: [], dropCommentary: true, perLanguage },
});
const titlesOf = (p: Profile) => selectAudio(discProbe(), p).map((s) => s.tags?.title ?? s.tags?.language);

test('a language carried more than once can be cut down to one track', () => {
  assert.deepEqual(titlesOf(discProfile('all')), ['Dolby Digital 2.0', 'TrueHD 5.1', 'Dolby Digital 5.1', 'jpn']);
  // widest first, then lossless over lossy: TrueHD 5.1 beats both Dolby Digital tracks
  assert.deepEqual(titlesOf(discProfile('best')), ['TrueHD 5.1', 'jpn']);
  // and the other way for a small copy
  assert.deepEqual(titlesOf(discProfile('smallest')), ['Dolby Digital 2.0', 'jpn']);
  // whichever the file listed first, which is what the old firstMatchOnly did
  assert.deepEqual(titlesOf(discProfile('first')), ['Dolby Digital 2.0', 'jpn']);
  // a language with one track is never touched, whatever the mode
  assert.ok(titlesOf(discProfile('best')).includes('jpn'));
});

test('best reads the codec from the stream profile, not the codec name alone', () => {
  // ffprobe calls both of these "dts"; only the profile says which is the lossless one
  const two = discProbe();
  two.streams = two.audio = [
    { index: 1, codec_type: 'audio', codec_name: 'dts', profile: 'DTS', channels: 6, bit_rate: '1509000', tags: { language: 'eng', title: 'DTS 5.1' } },
    { index: 2, codec_type: 'audio', codec_name: 'dts', profile: 'DTS-HD MA', channels: 6, bit_rate: '3000000', tags: { language: 'eng', title: 'DTS-HD MA 5.1' } },
  ] as ProbeResult['streams'];
  const pick = (mode: Profile['audio']['perLanguage']) => selectAudio(two, discProfile(mode)).map((s) => s.tags?.title);
  assert.deepEqual(pick('best'), ['DTS-HD MA 5.1']);
  assert.deepEqual(pick('smallest'), ['DTS 5.1']);
});

test('a commentary track is never the pick, at either end of the scale', () => {
  const two = discProbe();
  two.streams = two.audio = [
    { index: 1, codec_type: 'audio', codec_name: 'ac3', channels: 2, bit_rate: '192000', tags: { language: 'eng', title: 'Commentary by the director' } },
    { index: 2, codec_type: 'audio', codec_name: 'truehd', channels: 6, bit_rate: '4000000', tags: { language: 'eng', title: 'TrueHD 5.1' } },
  ] as ProbeResult['streams'];
  // commentary is dropped outright here, so ask with that switched off
  const keep = (mode: Profile['audio']['perLanguage']) => {
    const p = discProfile(mode);
    return selectAudio(two, { ...p, audio: { ...p.audio, dropCommentary: false } }).map((s) => s.tags?.title);
  };
  assert.deepEqual(keep('best'), ['TrueHD 5.1']);
  assert.deepEqual(keep('smallest'), ['TrueHD 5.1']);
});

test('a profile saved before perLanguage existed still decides the same thing', () => {
  const old = { ...discProfile('all'), audio: { ...discProfile('all').audio, perLanguage: undefined, firstMatchOnly: true } } as unknown as Profile;
  assert.deepEqual(selectAudio(discProbe(), old).map((s) => s.tags?.title ?? s.tags?.language), ['Dolby Digital 2.0', 'jpn']);
  const older = { ...discProfile('all'), audio: { ...discProfile('all').audio, perLanguage: undefined } } as unknown as Profile;
  assert.equal(selectAudio(discProbe(), older).length, 4);
});

test('only one track per language leaves one -map per language', () => {
  const { args } = buildFfmpegArgs(discProfile('best'), discProbe(), '/in/disc.mkv', '/out/disc.mkv');
  assert.equal(maps(args).length, 3); // video + one English + one Japanese
});

// ---- picture subtitles -------------------------------------------------------------------------
function dvdProbe(): ProbeResult {
  const streams = [
    { index: 0, codec_type: 'video', codec_name: 'mpeg2video', width: 720, height: 480, tags: {} },
    { index: 1, codec_type: 'audio', codec_name: 'ac3', channels: 6, tags: { language: 'eng' } },
    { index: 2, codec_type: 'subtitle', codec_name: 'dvd_subtitle', tags: { language: 'eng' } },
    { index: 3, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'jpn' } },
    { index: 4, codec_type: 'subtitle', codec_name: 'dvd_subtitle', tags: { language: 'fre' } },
  ] as ProbeResult['streams'];
  return {
    path: '/in/dvd.mkv', durationSeconds: 100, sizeBytes: 1, bitRate: 1, formatName: 'matroska', streams,
    video: streams[0], audio: streams.filter((s) => s.codec_type === 'audio'),
    subtitles: streams.filter((s) => s.codec_type === 'subtitle'), attachments: [],
    isHdr: false, isDolbyVision: false, frameRate: 25,
  };
}
const dvdProfile = (bitmapMode: Profile['subtitles']['bitmapMode'], over: Partial<Profile> = {}): Profile => ({
  ...byId('builtin-movie-1080p'),
  video: { ...byId('builtin-movie-1080p').video, encoder: 'copy' },
  subtitles: { ...byId('builtin-movie-1080p').subtitles, mode: 'copy', languages: [], bitmapMode },
  ...over,
});

test('only the picture tracks are put forward for reading, by their s:N index', () => {
  assert.deepEqual(subtitlesToOcr(dvdProbe(), dvdProfile('keep')), []);
  // s:0 and s:2 - the SRT between them is already text, and does not shift the indices of the others
  assert.deepEqual(subtitlesToOcr(dvdProbe(), dvdProfile('ocr')).map((x) => [x.subtitleIndex, x.stream.index]), [[0, 2], [2, 4]]);
  assert.deepEqual(subtitlesToOcr(dvdProbe(), dvdProfile('ocr-keep')).map((x) => x.subtitleIndex), [0, 2]);
  // and a language filter narrows it, so an English-only profile does not read the French
  const eng = dvdProfile('ocr');
  assert.deepEqual(subtitlesToOcr(dvdProbe(), { ...eng, subtitles: { ...eng.subtitles, languages: ['eng'] } }).map((x) => x.subtitleIndex), [0]);
  // nothing to read when subtitles are not being kept at all
  assert.deepEqual(subtitlesToOcr(dvdProbe(), { ...eng, subtitles: { ...eng.subtitles, mode: 'none' } }), []);
});

test('text read from pictures is muxed in, and replaces the pictures unless both are asked for', () => {
  const ocrSubtitles = [
    { sourceIndex: 2, path: '/tmp/eng.srt', language: 'eng' },
    { sourceIndex: 4, path: '/tmp/fre.srt', language: 'fre', forced: true },
  ];
  const r = buildFfmpegArgs(dvdProfile('ocr'), dvdProbe(), '/in/dvd.mkv', '/out/dvd.mkv', { ocrSubtitles });
  // the two SRT files are inputs 1 and 2
  assert.deepEqual(r.args.filter((_, i) => r.args[i - 1] === '-i'), ['/in/dvd.mkv', '/tmp/eng.srt', '/tmp/fre.srt']);
  // the pictures are gone; what is left is the source's own SRT plus the two read ones
  assert.deepEqual(maps(r.args), ['0:0', '0:1', '0:3', '1:0', '2:0']);
  assert.ok(r.args.includes('-disposition:s:2'), 'the forced flag is carried over');
  assert.ok(r.summary.some((l) => l.includes('2 read from pictures')));

  // keep both, and the pictures stay alongside the text
  const both = buildFfmpegArgs(dvdProfile('ocr-keep'), dvdProbe(), '/in/dvd.mkv', '/out/dvd.mkv', { ocrSubtitles });
  assert.deepEqual(maps(both.args), ['0:0', '0:1', '0:2', '0:3', '0:4', '1:0', '2:0']);
});

test('an MP4 keeps subtitles it would otherwise lose, as mov_text', () => {
  const p = dvdProfile('ocr', { container: 'mp4' });
  const plain = buildFfmpegArgs(dvdProfile('keep', { container: 'mp4' }), dvdProbe(), '/in/dvd.mkv', '/out/dvd.mp4');
  // as it stands: the two picture tracks are dropped, with a warning that now says what to do about it
  assert.deepEqual(maps(plain.args), ['0:0', '0:1', '0:3']);
  assert.ok(plain.warnings.some((w) => w.includes('Read into text')));
  const r = buildFfmpegArgs(p, dvdProbe(), '/in/dvd.mkv', '/out/dvd.mp4', {
    ocrSubtitles: [{ sourceIndex: 2, path: '/tmp/eng.srt', language: 'eng' }],
  });
  assert.deepEqual(maps(r.args), ['0:0', '0:1', '0:3', '1:0']);
  assert.equal(argAfter(r.args, '-c:s:1'), 'mov_text');
  assert.ok(!r.warnings.some((w) => w.includes('Read into text')), 'nothing is being lost any more');
});

test('with OCR switched off the profile keeps its pictures rather than losing them', () => {
  const off = withoutOcr(dvdProfile('ocr'));
  assert.equal(off.subtitles.bitmapMode, 'keep');
  assert.deepEqual(subtitlesToOcr(dvdProbe(), off), []);
  // an MKV keeps all three tracks, which is the point: half-applying "replace" would drop them
  const r = buildFfmpegArgs(off, dvdProbe(), '/in/dvd.mkv', '/out/dvd.mkv');
  assert.deepEqual(maps(r.args), ['0:0', '0:1', '0:2', '0:3', '0:4']);
  // and a profile that was not asking for OCR is handed back untouched
  const keep = dvdProfile('keep');
  assert.equal(withoutOcr(keep), keep);
});
