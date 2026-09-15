/**
 * Hardware acceleration (Settings → Transcoding).
 *
 * Profiles are written against software encoders (x264 / x265 / SVT-AV1). When a hardware method is selected,
 * a profile following the global setting is mapped to that method's encoder for the same codec, with quality and
 * preset translated to the hardware encoder's scale. Profiles that already name a hardware encoder keep it.
 */
import type { HwAccel, Profile, TranscodingSettings, VideoEncoder } from '../../../shared/types.js';
import { HW_ACCEL_INFO, VIDEO_ENCODER_INFO } from '../../../shared/presets.js';

export interface HwContext {
  method: HwAccel;
  family: string;
  device: string;
  decode: boolean;
}

export interface HwResolution {
  profile: Profile;
  /** Set when a hardware encoder is in use (either mapped or named by the profile). */
  hw?: HwContext;
  notes: string[];
  warnings: string[];
}

const SOFTWARE_FAMILIES = new Set(['x264', 'x265', 'svtav1', 'aom', 'vpx']);
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));

/** Translate a software CRF (x264/x265 ~18–24, SVT-AV1 ~24–35) into the hardware encoder's quality scale. */
export function translateQuality(family: string, codec: string, softwareFamily: string, crf: number): number {
  // Normalise to an x265-like CRF first; AV1 CRFs run ~8 higher for similar quality.
  const base = softwareFamily === 'svtav1' || softwareFamily === 'aom' || softwareFamily === 'vpx' ? crf - 8 : crf;
  switch (family) {
    case 'nvenc':
      return clamp(base + 2, 0, codec === 'av1' ? 63 : 51);
    case 'qsv':
      return clamp(base + 2, 1, codec === 'av1' ? 63 : 51);
    case 'vaapi':
      return clamp(base + 4, 0, codec === 'av1' ? 255 : 52);
    case 'amf':
      return clamp(base + 2, 0, codec === 'av1' ? 255 : 51);
    case 'rkmpp':
      return clamp(base + 3, 0, 51);
    case 'videotoolbox':
      // -q:v 1–100, higher is better. CRF 18 → 60, CRF 24 → 48.
      return clamp(96 - base * 2, 1, 100);
    default:
      return clamp(base, 0, 51);
  }
}

/** Translate a software speed preset into the hardware encoder's preset names. */
export function translatePreset(family: string, preset: string): string {
  const order = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow', 'placebo'];
  let rank = order.indexOf(preset); // 0 fastest … 9 slowest
  if (rank < 0 && /^\d+$/.test(preset)) rank = clamp(9 - (Number(preset) / 13) * 9, 0, 9); // SVT-AV1 0 (slow) … 13 (fast)
  if (rank < 0) rank = 5;
  switch (family) {
    case 'nvenc':
      return `p${clamp(1 + (rank / 9) * 6, 1, 7)}`;
    case 'qsv':
      return ['veryfast', 'veryfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow', 'veryslow'][rank];
    case 'amf':
      return rank <= 3 ? 'speed' : rank <= 5 ? 'balanced' : 'quality';
    default:
      return '';
  }
}

/** The encoder a method uses for a codec, or undefined if the method cannot encode it. */
export function hwEncoderFor(method: HwAccel, codec: string): VideoEncoder | undefined {
  return HW_ACCEL_INFO[method]?.encoders[codec as 'h264' | 'hevc' | 'av1'] as VideoEncoder | undefined;
}

/** Apply Settings → Transcoding to a profile. */
export function resolveHardware(profile: Profile, t: TranscodingSettings | undefined, available?: VideoEncoder[]): HwResolution {
  const notes: string[] = [];
  const warnings: string[] = [];
  const v = profile.video;
  const info = VIDEO_ENCODER_INFO[v.encoder];
  const method = t?.hardwareAcceleration ?? 'none';
  if (!info || v.encoder === 'copy') return { profile, notes, warnings };

  // Profile names a hardware encoder itself: keep it, but still use the configured device / decode.
  if (!SOFTWARE_FAMILIES.has(info.family)) {
    const m = (Object.keys(HW_ACCEL_INFO) as HwAccel[]).find((k) => HW_ACCEL_INFO[k].family === info.family) ?? 'none';
    const sameMethod = m === method;
    return { profile, hw: { method: m, family: info.family, device: sameMethod ? t?.device ?? '' : '', decode: t?.hardwareDecoding ?? true }, notes, warnings };
  }

  if (method === 'none') return { profile, notes, warnings };
  if (v.hwMode === 'software') {
    notes.push('Hardware acceleration skipped: this profile is set to software only');
    return { profile, notes, warnings };
  }
  const hwInfo = HW_ACCEL_INFO[method];
  const encoder = hwEncoderFor(method, info.codec);
  if (!encoder) {
    warnings.push(`${hwInfo.label} cannot encode ${info.codec.toUpperCase()}; encoding on the CPU with ${v.encoder}`);
    return { profile, notes, warnings };
  }
  if (available && !available.includes(encoder)) {
    warnings.push(`${encoder} is not available in this ffmpeg build; encoding on the CPU with ${v.encoder}`);
    return { profile, notes, warnings };
  }
  const encInfo = VIDEO_ENCODER_INFO[encoder];
  let pixelFormat = v.pixelFormat;
  if (pixelFormat === 'yuv420p10le') pixelFormat = 'p010le';
  if (info.codec === 'h264' && pixelFormat === 'p010le') {
    pixelFormat = 'nv12';
    warnings.push('Hardware H.264 encoders are 8-bit; using nv12');
  }
  const mapped: Profile = {
    ...profile,
    video: {
      ...v,
      encoder,
      quality: translateQuality(encInfo.family, info.codec, info.family, v.quality),
      preset: translatePreset(encInfo.family, v.preset),
      pixelFormat,
      tune: 'none',
      // software-only encoder parameters do not apply to hardware encoders
      extraArgs: /-(x264|x265|svtav1)-params/.test(v.extraArgs) ? '' : v.extraArgs,
    },
  };
  if (v.tune !== 'none') notes.push(`Tune "${v.tune}" is software-only and was dropped`);
  if (mapped.video.extraArgs !== v.extraArgs) notes.push('Software encoder parameters (extra args) were dropped for the hardware encoder');
  notes.push(`Hardware: ${hwInfo.label} → ${encoder} (${encInfo.qualityLabel} ${mapped.video.quality}${mapped.video.preset ? `, ${mapped.video.preset}` : ''}; profile asked for ${v.encoder} ${info.qualityLabel} ${v.quality})`);
  return { profile: mapped, hw: { method, family: encInfo.family, device: t?.device ?? '', decode: Boolean(t?.hardwareDecoding) }, notes, warnings };
}

/** Software equivalent of a profile, used when a hardware encode fails and fallback is enabled. */
export function softwareEquivalent(profile: Profile): Profile {
  const v = profile.video;
  const info = VIDEO_ENCODER_INFO[v.encoder];
  if (!info || v.encoder === 'copy' || SOFTWARE_FAMILIES.has(info.family)) return { ...profile, video: { ...v, hwMode: 'software' } };
  const sw = info.codec === 'h264' ? { encoder: 'libx264', quality: 20, preset: 'medium' } : info.codec === 'av1' ? { encoder: 'libsvtav1', quality: 30, preset: '8' } : { encoder: 'libx265', quality: 22, preset: 'medium' };
  const tenBit = v.pixelFormat === 'p010le' || v.pixelFormat === 'yuv420p10le';
  return {
    ...profile,
    video: { ...v, encoder: sw.encoder as VideoEncoder, quality: sw.quality, preset: sw.preset, pixelFormat: info.codec === 'h264' ? 'yuv420p' : tenBit ? 'yuv420p10le' : v.pixelFormat === 'nv12' ? 'yuv420p' : v.pixelFormat, bitrate: 0, extraArgs: '', hwMode: 'software' },
  };
}

/** Source codecs each decoder path handles well; others are decoded on the CPU. */
const HW_DECODE_CODECS: Record<string, string[]> = {
  nvenc: ['h264', 'hevc', 'av1', 'vp9', 'mpeg2video', 'vc1'],
  qsv: ['h264', 'hevc', 'av1', 'vp9', 'mpeg2video', 'vc1'],
  vaapi: ['h264', 'hevc', 'av1', 'vp9'],
  amf: ['h264', 'hevc', 'av1', 'vp9'],
  videotoolbox: ['h264', 'hevc', 'vp9', 'mpeg2video'],
  rkmpp: ['h264', 'hevc', 'vp9', 'av1'],
  v4l2: [],
};

export function canHwDecode(hw: HwContext, codec: string | undefined) {
  return Boolean(hw.decode && codec && HW_DECODE_CODECS[hw.family]?.includes(codec));
}
