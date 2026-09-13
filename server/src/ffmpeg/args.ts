import path from 'node:path';
import type { Profile } from '../../../shared/types.js';
import { CONTAINER_INFO, VIDEO_ENCODER_INFO } from '../../../shared/presets.js';
import { isTextSubtitle, streamLanguage, streamTitle, type ProbeResult, type ProbeStream } from './probe.js';

export interface BuildResult {
  args: string[];
  warnings: string[];
  /** Human readable summary of what the command does. */
  summary: string[];
}

export interface BuildOptions {
  /**
   * Force bitrate mode (kbps) for encoders whose quality mode is unavailable on this machine,
   * e.g. VideoToolbox on Intel Macs where `-q:v` is rejected. 0 = derive from resolution.
   */
  forceBitrate?: number;
}

/** A sane default bitrate when an encoder cannot run in quality mode. */
export function defaultBitrateFor(height: number | undefined, codec: string): number {
  const h = height ?? 1080;
  const base = h >= 2000 ? 18000 : h >= 1300 ? 10000 : h >= 1000 ? 6000 : 3000;
  return codec === 'h264' ? Math.round(base * 1.5) : base;
}

/** Very small shell-ish splitter for the "extra args" field. Supports quotes. */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** Escape a path for use inside an ffmpeg filter graph (subtitles=...). */
function filterEscape(p: string) {
  return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/\[/g, '\\[').replace(/\]/g, '\\]').replace(/,/g, '\\,').replace(/;/g, '\;');
}

function langMatches(stream: ProbeStream, languages: string[]) {
  if (!languages.length) return true;
  const l = streamLanguage(stream);
  // Accept ISO 639-2/B and /T variants (fre/fra, ger/deu, chi/zho, dut/nld).
  const alias: Record<string, string[]> = { fre: ['fra'], ger: ['deu'], chi: ['zho'], dut: ['nld'], jpn: ['ja'], eng: ['en'] };
  return languages.some((want) => want === l || (alias[want] ?? []).includes(l) || (alias[l] ?? []).includes(want));
}

function isCommentary(stream: ProbeStream) {
  return /commentar/i.test(streamTitle(stream)) || stream.disposition?.comment === 1;
}

function selectAudio(probe: ProbeResult, profile: Profile): ProbeStream[] {
  let list = probe.audio;
  if (profile.audio.dropCommentary) {
    const filtered = list.filter((s) => !isCommentary(s));
    if (filtered.length) list = filtered;
  }
  const byLang = list.filter((s) => langMatches(s, profile.audio.languages));
  if (byLang.length) list = byLang;
  else if (profile.audio.languages.length) list = list.slice(0, 1); // nothing matched; keep the first track rather than none
  if (profile.audio.firstMatchOnly) {
    const seen = new Set<string>();
    list = list.filter((s) => {
      const l = streamLanguage(s);
      if (seen.has(l)) return false;
      seen.add(l);
      return true;
    });
  }
  return list;
}

function selectSubtitles(probe: ProbeResult, profile: Profile, containerBitmap: boolean): ProbeStream[] {
  const mode = profile.subtitles.mode;
  if (mode === 'none' || mode === 'burn') return [];
  let list = probe.subtitles.filter((s) => langMatches(s, profile.subtitles.languages));
  if (mode === 'copy-text' || !containerBitmap) list = list.filter(isTextSubtitle);
  return list;
}

function pickBurnStream(probe: ProbeResult, profile: Profile): ProbeStream | undefined {
  const wantLang = profile.subtitles.burnLanguage ? [profile.subtitles.burnLanguage] : [];
  let cands = probe.subtitles.filter((s) => langMatches(s, wantLang));
  if (profile.subtitles.burnForcedOnly) {
    const forced = cands.filter((s) => s.disposition?.forced === 1 || /forced/i.test(streamTitle(s)));
    if (forced.length) cands = forced;
  }
  return cands[0] ?? probe.subtitles[0];
}

function videoQualityArgs(profile: Profile, probe: ProbeResult, warnings: string[], opts: BuildOptions): string[] {
  const v = profile.video;
  const info = VIDEO_ENCODER_INFO[v.encoder];
  const out: string[] = [];
  const bitrate = v.bitrate > 0 ? [`-b:v`, `${v.bitrate}k`] : [];
  switch (info?.family) {
    case 'x264':
    case 'x265': {
      out.push('-crf', String(v.quality));
      if (v.preset) out.push('-preset', v.preset);
      if (v.tune !== 'none') out.push('-tune', v.tune);
      if (info.family === 'x265') {
        const params: string[] = [];
        if (v.hdrPassthrough && probe.isHdr) {
          params.push('hdr10=1', 'hdr10-opt=1', 'repeat-headers=1');
          const md = probe.video?.side_data_list?.find((d) => d.side_data_type === 'Mastering display metadata') as Record<string, unknown> | undefined;
          const cll = probe.video?.side_data_list?.find((d) => d.side_data_type === 'Content light level metadata') as Record<string, unknown> | undefined;
          const md2 = masteringDisplay(md);
          if (md2) params.push(`master-display=${md2}`);
          if (cll?.max_content !== undefined) params.push(`max-cll=${cll.max_content},${cll.max_average ?? 0}`);
        }
        if (params.length) out.push('-x265-params', params.join(':'));
      }
      break;
    }
    case 'svtav1':
      out.push('-crf', String(v.quality));
      if (v.preset) out.push('-preset', v.preset);
      break;
    case 'aom':
      out.push('-crf', String(v.quality), '-b:v', '0');
      if (v.preset) out.push('-cpu-used', v.preset);
      out.push('-row-mt', '1');
      break;
    case 'vpx':
      out.push('-crf', String(v.quality), '-b:v', '0');
      if (v.preset) out.push('-cpu-used', v.preset);
      out.push('-row-mt', '1');
      break;
    case 'videotoolbox': {
      // Constant quality (-q:v) needs Apple Silicon; Intel Macs only support bitrate mode.
      const forced = opts.forceBitrate !== undefined ? opts.forceBitrate || defaultBitrateFor(probe.video?.height, info.codec) : 0;
      if (forced > 0) {
        out.push('-b:v', `${forced}k`);
        warnings.push(`VideoToolbox constant-quality mode is unavailable here; using ${forced} kbps bitrate mode instead`);
      } else if (v.bitrate > 0) out.push(...bitrate);
      else out.push('-q:v', String(v.quality));
      out.push('-allow_sw', '1');
      break;
    }
    case 'nvenc':
      out.push('-rc', 'vbr', '-cq', String(v.quality), '-b:v', v.bitrate > 0 ? `${v.bitrate}k` : '0');
      if (v.preset) out.push('-preset', v.preset);
      out.push('-tune', 'hq', '-multipass', 'fullres');
      break;
    case 'qsv':
      out.push('-global_quality', String(v.quality), '-look_ahead', '1');
      if (v.preset) out.push('-preset', v.preset);
      break;
    case 'vaapi':
      out.push('-rc_mode', 'CQP', '-qp', String(v.quality));
      break;
    case 'amf':
      out.push('-rc', 'cqp', '-qp_i', String(v.quality), '-qp_p', String(v.quality));
      if (v.preset) out.push('-quality', v.preset);
      break;
    default:
      warnings.push(`Unknown encoder family for ${v.encoder}; passing -crf`);
      out.push('-crf', String(v.quality));
  }
  return out;
}

function masteringDisplay(md?: Record<string, unknown>): string | null {
  if (!md) return null;
  // ffprobe reports rationals like "13250/50000". x265 wants integers scaled by 50000 (chromaticity) / 10000 (luminance).
  const frac = (v: unknown, scale: number) => {
    if (typeof v !== 'string') return null;
    const [n, d] = v.split('/').map(Number);
    if (!d) return null;
    return Math.round((n / d) * scale);
  };
  const rx = frac(md.red_x, 50000), ry = frac(md.red_y, 50000);
  const gx = frac(md.green_x, 50000), gy = frac(md.green_y, 50000);
  const bx = frac(md.blue_x, 50000), by = frac(md.blue_y, 50000);
  const wx = frac(md.white_point_x, 50000), wy = frac(md.white_point_y, 50000);
  const maxL = frac(md.max_luminance, 10000), minL = frac(md.min_luminance, 10000);
  if ([rx, ry, gx, gy, bx, by, wx, wy, maxL, minL].some((v) => v === null)) return null;
  return `G(${gx},${gy})B(${bx},${by})R(${rx},${ry})WP(${wx},${wy})L(${maxL},${minL})`;
}

export function buildFfmpegArgs(profile: Profile, probe: ProbeResult, input: string, output: string, opts: BuildOptions = {}): BuildResult {
  const warnings: string[] = [];
  const summary: string[] = [];
  const container = CONTAINER_INFO[profile.container];
  const encInfo = VIDEO_ENCODER_INFO[profile.video.encoder];
  const args: string[] = ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats', '-loglevel', 'warning'];

  // Hardware decode hints for hardware encoders (keep software decode for software encoders for max compatibility).
  if (encInfo?.family === 'vaapi') args.push('-vaapi_device', '/dev/dri/renderD128');
  if (encInfo?.family === 'nvenc' && probe.video && ['h264', 'hevc', 'av1', 'vp9'].includes(probe.video.codec_name)) args.push('-hwaccel', 'cuda');

  args.push('-i', input);

  if (!probe.video) throw new Error('Input has no video stream');

  // ---------- video ----------
  const filters: string[] = [];
  const burn = profile.subtitles.mode === 'burn' ? pickBurnStream(probe, profile) : undefined;
  const useFilterComplex = burn && !isTextSubtitle(burn);
  const v = profile.video;

  if (v.encoder === 'copy') {
    args.push('-map', `0:${probe.video.index}`, '-c:v', 'copy');
    summary.push('Video: copied');
    if (burn) warnings.push('Cannot burn subtitles when copying video; burn-in skipped');
  } else {
    if (v.maxHeight > 0 && (probe.video.height ?? 0) > v.maxHeight) {
      filters.push(`scale=-2:${v.maxHeight}:flags=lanczos`);
      summary.push(`Downscale to ${v.maxHeight}p`);
    }
    if (burn && isTextSubtitle(burn)) {
      const si = probe.subtitles.indexOf(burn);
      filters.push(`subtitles='${filterEscape(input)}':si=${si}`);
      summary.push(`Burn-in text subtitle #${si} (${streamLanguage(burn)})`);
    }
    let pix = v.pixelFormat === 'auto' ? '' : v.pixelFormat;
    if (encInfo?.family === 'vaapi') {
      filters.push(`format=${pix || 'nv12'}`, 'hwupload');
      pix = '';
    } else if (encInfo?.family === 'videotoolbox' && pix === 'yuv420p10le') pix = 'p010le';
    if (pix) filters.push(`format=${pix}`);
    if (pix === 'yuv420p' && probe.isHdr && v.hdrPassthrough) warnings.push('Source is HDR but pixel format is 8-bit; HDR will be flattened without tone mapping');
    if (probe.isDolbyVision) warnings.push('Source carries Dolby Vision; the RPU layer is dropped (HDR10 base layer kept)');
    if (v.tune === 'animation' && encInfo?.family !== 'x264' && encInfo?.family !== 'x265') warnings.push(`Tune "${v.tune}" is only supported by x264/x265; ignored`);

    if (useFilterComplex) {
      const chain = filters.length ? `[0:${probe.video.index}]${filters.join(',')}[vf];[vf][0:${burn.index}]overlay[vout]` : `[0:${probe.video.index}][0:${burn.index}]overlay[vout]`;
      args.push('-filter_complex', chain, '-map', '[vout]');
      summary.push(`Burn-in bitmap subtitle (${streamLanguage(burn)})`);
    } else {
      args.push('-map', `0:${probe.video.index}`);
      if (filters.length) args.push('-vf', filters.join(','));
    }
    args.push('-c:v', v.encoder, ...videoQualityArgs(profile, probe, warnings, opts));
    if (probe.isHdr && v.hdrPassthrough) {
      args.push('-color_primaries', probe.video.color_primaries ?? 'bt2020', '-color_trc', probe.video.color_transfer ?? 'smpte2084', '-colorspace', probe.video.color_space ?? 'bt2020nc');
      if (probe.video.color_range) args.push('-color_range', probe.video.color_range);
      summary.push('HDR metadata passthrough');
    }
    if (v.encoder === 'libx265' && (v.pixelFormat === 'yuv420p10le' || v.pixelFormat === 'p010le')) args.push('-profile:v', 'main10');
    if (profile.container === 'mp4' || profile.container === 'mov') {
      if (encInfo?.codec === 'hevc') args.push('-tag:v', 'hvc1');
    }
    if (v.extraArgs.trim()) args.push(...splitArgs(v.extraArgs));
    summary.push(`Video: ${encInfo?.label ?? v.encoder} ${encInfo?.qualityLabel ?? 'q'} ${v.quality}${v.preset ? ` (${v.preset})` : ''}`);
  }

  // ---------- audio ----------
  const audio = selectAudio(probe, profile);
  if (!audio.length) warnings.push('No audio streams selected');
  audio.forEach((s, i) => {
    args.push('-map', `0:${s.index}`);
    const a = profile.audio;
    let enc = a.encoder;
    if (enc !== 'copy' && container.audioCodecs[0] !== '*' && !container.audioCodecs.includes(codecForAudioEncoder(enc))) {
      warnings.push(`${enc} is not allowed in ${profile.container}; falling back to aac`);
      enc = 'aac';
    }
    if (enc === 'copy' && container.audioCodecs[0] !== '*' && !container.audioCodecs.includes(s.codec_name)) {
      warnings.push(`Audio codec ${s.codec_name} cannot be stored in ${profile.container}; re-encoding to aac`);
      enc = 'aac';
    }
    args.push(`-c:a:${i}`, enc === 'copy' ? 'copy' : enc);
    if (enc !== 'copy') {
      if (a.bitrate > 0 && enc !== 'flac' && enc !== 'truehd') args.push(`-b:a:${i}`, `${a.bitrate}k`);
      const srcCh = s.channels ?? 2;
      if (a.channels > 0 && a.channels < srcCh) args.push(`-ac:a:${i}`, String(a.channels));
      if (enc === 'libopus') {
        // libopus refuses "5.1(side)" style layouts; normalise to a standard layout.
        args.push(`-filter:a:${i}`, 'aformat=channel_layouts=7.1|5.1|stereo|mono');
      }
      if ((enc === 'ac3' || enc === 'eac3') && a.channels === 0 && srcCh > 6) args.push(`-ac:a:${i}`, '6');
    }
    args.push(`-metadata:s:a:${i}`, `language=${streamLanguage(s)}`);
    if (streamTitle(s)) args.push(`-metadata:s:a:${i}`, `title=${streamTitle(s)}`);
  });
  summary.push(`Audio: ${audio.length} track(s) → ${profile.audio.encoder}${profile.audio.bitrate ? ` ${profile.audio.bitrate}k` : ''}${profile.audio.channels ? ` ${profile.audio.channels}ch` : ''}`);

  // ---------- subtitles ----------
  const subs = selectSubtitles(probe, profile, container.bitmapSubs);
  subs.forEach((s, i) => {
    args.push('-map', `0:${s.index}`);
    const codec = container.textSubs === 'copy' ? 'copy' : isTextSubtitle(s) ? container.textSubs : 'copy';
    args.push(`-c:s:${i}`, codec);
  });
  if (profile.subtitles.mode !== 'none' && profile.subtitles.mode !== 'burn') summary.push(`Subtitles: ${subs.length} stream(s) kept`);
  if (probe.subtitles.length && !container.bitmapSubs && profile.subtitles.mode === 'copy') {
    const dropped = probe.subtitles.filter((s) => !isTextSubtitle(s)).length;
    if (dropped) warnings.push(`${dropped} bitmap subtitle stream(s) dropped (not supported by ${profile.container})`);
  }

  // ---------- attachments / metadata ----------
  if (container.attachments && profile.subtitles.keepFonts && probe.attachments.length) {
    args.push('-map', '0:t?', '-c:t', 'copy');
    summary.push(`Fonts: ${probe.attachments.length} attachment(s) kept`);
  }
  args.push('-map_metadata', '0', '-map_chapters', '0');
  if (profile.container === 'mp4' || profile.container === 'mov') args.push('-movflags', '+faststart');
  args.push('-max_muxing_queue_size', '2048');
  args.push('-f', profile.container === 'mkv' ? 'matroska' : profile.container === 'mov' ? 'mov' : profile.container, output);

  return { args, warnings, summary };
}

function codecForAudioEncoder(enc: string) {
  switch (enc) {
    case 'libfdk_aac':
      return 'aac';
    case 'libopus':
      return 'opus';
    default:
      return enc;
  }
}

export function outputPathFor(profile: Profile, input: string): string {
  const ext = CONTAINER_INFO[profile.container].ext;
  const dir = profile.output.directory?.trim() ? profile.output.directory.trim() : path.dirname(input);
  const base = path.basename(input, path.extname(input));
  const suffix = profile.output.suffix ?? '';
  let candidate = path.join(dir, `${base}${suffix}.${ext}`);
  // Never write over the input file directly; we swap after success when replaceOriginal is set.
  if (path.resolve(candidate) === path.resolve(input)) candidate = path.join(dir, `${base}${suffix || '.rexarr'}.${ext}`);
  return candidate;
}
