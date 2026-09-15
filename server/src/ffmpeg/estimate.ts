/**
 * Estimated output size of an encode, per profile, before anything runs.
 *
 * The file is probed once. Stream selection is the real one (the same audio / subtitle choice and hardware encoder
 * swap as the encode), and each stream gets a bitrate:
 *
 *   video copy        the source stream's bitrate
 *   video quality     a reference bitrate for 1080p24 at x264 CRF 20, scaled by resolution (pixels^0.75), frame rate,
 *                     codec efficiency and CRF / CQ / QP steps (≈ half the bitrate per 6 steps; 8 for AV1 / VP9),
 *                     speed preset, tune (animation / grain), 10-bit and HDR, and by how "busy" the source is
 *                     (its bitrate against a typical remux at that resolution: grainy films are big, anime is small)
 *   audio             copied tracks keep their bitrate; encoded tracks use the profile bitrate or encoder default
 *   subtitles/fonts   stream bitrates where known, typical PGS / text sizes otherwise
 *
 * Constant-quality encoders cannot be predicted exactly, so a range comes with the estimate.
 */
import type { Profile, SizeEstimate, TranscodingSettings, VideoEncoder } from '../../../shared/types.js';
import { CONTAINER_INFO, VIDEO_ENCODER_INFO } from '../../../shared/presets.js';
import { isTextSubtitle, type ProbeResult, type ProbeStream } from './probe.js';
import { selectAudio, selectSubtitles, defaultBitrateFor } from './args.js';
import { planAudio } from './naming.js';
import { resolveHardware } from './hardware.js';

/** Stream bitrate in kbps from ffprobe or mkvmerge statistics tags. */
export function streamKbps(s: ProbeStream): number {
  const direct = Number(s.bit_rate);
  if (direct > 0) return direct / 1000;
  const tag = s.tags ? Object.entries(s.tags).find(([k]) => /^BPS(-[a-z]{2,3})?$/i.test(k))?.[1] : undefined;
  return Number(tag) > 0 ? Number(tag) / 1000 : 0;
}

/** Typical bitrate of a copied audio track when the file does not say. */
function defaultAudioKbps(s: ProbeStream): number {
  const ch = s.channels ?? 2;
  const title = `${s.profile ?? ''} ${s.tags?.title ?? ''}`;
  switch (s.codec_name) {
    case 'truehd':
      return /atmos/i.test(title) ? 4500 : ch > 6 ? 4000 : 3000;
    case 'dts':
      return /MA|HD/i.test(s.profile ?? '') ? (ch > 6 ? 4000 : 3500) : 1509;
    case 'flac':
    case 'alac':
      return ch * 420;
    case 'pcm_s16le':
    case 'pcm_s24le':
    case 'pcm_bluray':
      return (ch * Number(s.sample_rate ?? 48000) * (s.codec_name.includes('16') ? 16 : 24)) / 1000;
    case 'eac3':
      return ch > 2 ? 768 : 224;
    case 'ac3':
      return ch > 2 ? 640 : 192;
    case 'aac':
      return ch > 2 ? 384 : 192;
    case 'opus':
      return ch > 2 ? 384 : 160;
    default:
      return ch > 2 ? 640 : 192;
  }
}

/** Bitrate an audio encoder produces without an explicit bitrate. */
function encodedAudioKbps(enc: string, bitrate: number, channels: number, src: ProbeStream): number {
  if (enc === 'flac') return (channels * Number(src.sample_rate ?? 48000) * 24 * 0.55) / 1000;
  if (enc === 'truehd') return (channels * Number(src.sample_rate ?? 48000) * 24 * 0.5) / 1000;
  if (bitrate > 0) return bitrate;
  const multi = channels > 2;
  switch (enc) {
    case 'libopus':
      return multi ? 64 * channels : 128;
    case 'aac':
    case 'libfdk_aac':
      return multi ? 64 * channels : 128;
    case 'ac3':
      return multi ? 448 : 192;
    case 'eac3':
      return multi ? 640 : 224;
    case 'libmp3lame':
      return 192;
    default:
      return multi ? 448 : 160;
  }
}

/** Quality → bitrate model per encoder family: [reference quality, steps per halving, efficiency vs x264]. */
const FAMILY: Record<string, { ref: number; step: number; eff: number; higherIsBetter?: boolean }> = {
  x264: { ref: 20, step: 6, eff: 1 },
  x265: { ref: 20, step: 6, eff: 0.75 },
  svtav1: { ref: 30, step: 8, eff: 0.42 },
  aom: { ref: 30, step: 8, eff: 0.4 },
  vpx: { ref: 31, step: 8, eff: 0.7 },
  videotoolbox: { ref: 60, step: 12, eff: 1.1, higherIsBetter: true },
  nvenc: { ref: 22, step: 6, eff: 0.95 },
  qsv: { ref: 22, step: 6, eff: 0.9 },
  vaapi: { ref: 22, step: 6, eff: 1 },
  amf: { ref: 22, step: 6, eff: 1.05 },
  rkmpp: { ref: 22, step: 6, eff: 1.1 },
};

const X26X_PRESET: Record<string, number> = { ultrafast: 1.4, superfast: 1.28, veryfast: 1.16, faster: 1.08, fast: 1.04, medium: 1, slow: 0.95, slower: 0.92, veryslow: 0.9, placebo: 0.89 };

/** A remux-like bitrate for a height: what "normal complexity" looks like. */
function typicalSourceKbps(height: number): number {
  return height >= 2000 ? 55000 : height >= 1000 ? 25000 : height >= 700 ? 12000 : 6500;
}

export interface VideoEstimate {
  kbps: number;
  exact: boolean;
  encoder: string;
}

/** Calibration: x265 CRF 18 slow on an anime DVD (720x480 MPEG-2, 5.9 Mbps) measured 1,420 kbps, x264 CRF 19 1,430, SVT-AV1 CRF 28 720. */
export function estimateVideo(profile: Profile, probe: ProbeResult, opts: { anime?: boolean; hardware?: TranscodingSettings; availableEncoders?: VideoEncoder[] } = {}): VideoEstimate {
  const src = probe.video;
  if (!src) return { kbps: 0, exact: true, encoder: 'none' };
  const audioKbps = probe.audio.reduce((n, a) => n + (streamKbps(a) || defaultAudioKbps(a)), 0);
  const subsKbps = probe.subtitles.reduce((n, s) => n + (streamKbps(s) || (isTextSubtitle(s) ? 0.3 : 35)), 0);
  const srcKbps = streamKbps(src) || Math.max(500, probe.bitRate / 1000 - audioKbps - subsKbps);
  const eff = resolveHardware(profile, opts.hardware, opts.availableEncoders).profile;
  const v = eff.video;
  if (v.encoder === 'copy') return { kbps: srcKbps, exact: true, encoder: 'copy' };
  const info = VIDEO_ENCODER_INFO[v.encoder];
  const srcH = src.height ?? 1080;
  const srcW = src.width ?? Math.round((srcH * 16) / 9);
  const outH = v.maxHeight > 0 && srcH > v.maxHeight ? v.maxHeight : srcH;
  const outW = Math.round((srcW * outH) / srcH);
  if (info?.family === 'v4l2' || (v.bitrate > 0 && ['videotoolbox', 'rkmpp'].includes(info?.family ?? ''))) {
    const kbps = v.bitrate > 0 ? v.bitrate : defaultBitrateFor(outH, info.codec);
    return { kbps, exact: true, encoder: v.encoder };
  }
  const fam = FAMILY[info?.family ?? 'x264'] ?? FAMILY.x264;
  let eff2 = fam.eff;
  // hardware H.264 needs about half again as much as hardware HEVC; AV1 hardware a little less
  if (!['x264', 'x265', 'svtav1', 'aom', 'vpx'].includes(info?.family ?? '')) eff2 *= info?.codec === 'h264' ? 1.55 : info?.codec === 'av1' ? 0.85 : 1;
  const steps = fam.higherIsBetter ? (fam.ref - v.quality) / fam.step : (v.quality - fam.ref) / fam.step;
  let kbps = 5500 * eff2 * 2 ** -steps;
  // small frames need relatively more bits per pixel (calibrated on SD and 1080p encodes)
  kbps *= ((outW * outH) / (1920 * 1080)) ** 0.6;
  kbps *= Math.max(0.5, (probe.frameRate || 24) / 24) ** 0.6;
  if (info?.family === 'x264' || info?.family === 'x265') kbps *= X26X_PRESET[v.preset] ?? 1;
  if (info?.family === 'svtav1' && /^\d+$/.test(v.preset)) kbps *= 1 + (Number(v.preset) - 6) * 0.025;
  if (v.tune === 'grain') kbps *= 1.6;
  if (v.pixelFormat === 'yuv420p10le' || v.pixelFormat === 'p010le') kbps *= 0.95;
  if (probe.isHdr && v.hdrPassthrough) kbps *= 1.08;
  // busy sources (grain, noise, fast motion) are big as remuxes and stay big; clean ones shrink more
  const complexity = Math.min(1.8, Math.max(0.55, Math.sqrt(srcKbps / typicalSourceKbps(srcH))));
  kbps *= complexity;
  // flat animation compresses well – less so from noisy sources (old DVDs keep their grain)
  if (v.tune === 'animation' || opts.anime) kbps *= 0.6 + 0.4 * Math.min(1, Math.max(0, (complexity - 0.6) / 0.6));
  // an encode rarely ends up larger than its source stream
  kbps = Math.min(kbps, srcKbps * 1.05);
  return { kbps: Math.max(150, kbps), exact: false, encoder: v.encoder };
}

const VORBIS_Q_KBPS = [64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 500];
const LAME_V_KBPS = [245, 225, 190, 175, 165, 130, 115, 100, 85, 65];

/** Music profiles: one audio file. */
function estimateMusic(profile: Profile, probe: ProbeResult, sourceBytes: number): Omit<SizeEstimate, 'profileId' | 'profileName'> {
  const a = profile.audio;
  const s = probe.audio[0];
  const secs = probe.durationSeconds || 0;
  const bytes = (kbps: number) => (kbps * 1000 * secs) / 8;
  const coverBytes = a.embedCover !== false && probe.streams.some((x) => x.disposition?.attached_pic === 1) && a.encoder !== 'libopus' ? 300_000 : 0;
  if (!s) return { bytes: sourceBytes, low: sourceBytes, high: sourceBytes, sourceBytes, parts: { video: 0, audio: sourceBytes, subtitles: 0, other: 0 }, notes: ['No audio stream found'], exact: true };
  const lossless = ['flac', 'alac', 'wavpack', 'ape', 'tta'].includes(s.codec_name) || s.codec_name.startsWith('pcm_');
  const rate = Number(s.sample_rate ?? 44100);
  const depth = Number((s as ProbeStream & { bits_per_raw_sample?: string }).bits_per_raw_sample) || (s.codec_name.includes('16') ? 16 : 24);
  const notes: string[] = [];
  let audio: number;
  let exact = false;
  switch (a.encoder) {
    case 'copy':
      audio = sourceBytes - coverBytes;
      exact = true;
      break;
    case 'flac':
    case 'wavpack':
    case 'ape': {
      const outRate = a.maxSampleRate && rate > a.maxSampleRate ? a.maxSampleRate : rate;
      const outDepth = a.bitDepth && depth > a.bitDepth ? a.bitDepth : depth;
      const pcm = (outRate * outDepth * (s.channels ?? 2)) / 1000;
      // lossless codecs land around 55–65 % of PCM; the source's own ratio is the best guide when it is lossless
      const srcRatio = lossless && s.codec_name !== 'pcm_s16le' && s.codec_name !== 'pcm_s24le' ? Math.min(0.9, Math.max(0.3, (streamKbps(s) || (sourceBytes * 8) / 1000 / Math.max(1, secs)) / ((rate * depth * (s.channels ?? 2)) / 1000))) : 0.6;
      const codecFactor = a.encoder === 'wavpack' ? 1.02 : a.encoder === 'ape' ? 0.97 : 1;
      audio = bytes(pcm * srcRatio * codecFactor);
      if (!lossless) notes.push('Lossy source: a lossless copy of it is larger without being better');
      break;
    }
    case 'libmp3lame':
      audio = bytes(a.vbrQuality !== undefined && a.vbrQuality !== null ? LAME_V_KBPS[Math.min(9, Math.max(0, a.vbrQuality))] : a.bitrate || 320);
      exact = a.vbrQuality === undefined || a.vbrQuality === null;
      break;
    case 'libvorbis':
      audio = bytes(a.vbrQuality !== undefined && a.vbrQuality !== null ? VORBIS_Q_KBPS[Math.min(10, Math.max(0, Math.round(a.vbrQuality)))] : a.bitrate || 192);
      break;
    case 'libopus':
      audio = bytes(a.bitrate || 160);
      break;
    default:
      audio = bytes(a.bitrate || 256);
  }
  const total = audio + coverBytes + 20_000;
  const spread = exact ? 0.03 : a.encoder === 'flac' || a.encoder === 'wavpack' || a.encoder === 'ape' ? 0.12 : 0.1;
  return { bytes: Math.round(total), low: Math.round(total * (1 - spread)), high: Math.round(total * (1 + spread)), sourceBytes, parts: { video: 0, audio: Math.round(audio), subtitles: 0, other: coverBytes }, notes, exact };
}

/** Estimate one file with one profile. */
export function estimateSize(profile: Profile, probe: ProbeResult, opts: { anime?: boolean; hardware?: TranscodingSettings; availableEncoders?: VideoEncoder[] } = {}): Omit<SizeEstimate, 'profileId' | 'profileName'> {
  const sourceBytes = probe.sizeBytes;
  if (profile.mediaType === 'music' || CONTAINER_INFO[profile.container]?.music) return estimateMusic(profile, probe, sourceBytes);
  const secs = probe.durationSeconds || 0;
  const toBytes = (kbps: number) => (kbps * 1000 * secs) / 8;
  const notes: string[] = [];
  const video = estimateVideo(profile, probe, opts);

  const container = CONTAINER_INFO[profile.container];
  const audioPlan = planAudio(profile, selectAudio(probe, profile));
  let audioKbps = 0;
  for (const p of audioPlan) audioKbps += p.encoder === 'copy' ? streamKbps(p.stream) || defaultAudioKbps(p.stream) : encodedAudioKbps(p.encoder, profile.audio.bitrate, p.channels, p.stream);

  const subs = profile.subtitles.mode === 'none' || profile.subtitles.mode === 'burn' ? [] : selectSubtitles(probe, profile, container.bitmapSubs);
  const subsKbps = subs.reduce((n, s) => n + (streamKbps(s) || (isTextSubtitle(s) ? 0.3 : 35)), 0);
  const fontBytes = container.attachments && profile.subtitles.keepFonts ? probe.attachments.reduce((n, t) => n + (Number((t as ProbeStream & { extradata_size?: number }).extradata_size) || 400_000), 0) : 0;

  const videoBytes = toBytes(video.kbps);
  const audioBytes = toBytes(audioKbps);
  const subsBytes = toBytes(subsKbps);
  const overhead = (videoBytes + audioBytes + subsBytes) * (profile.container === 'mp4' || profile.container === 'mov' ? 0.012 : 0.006);
  const total = videoBytes + audioBytes + subsBytes + fontBytes + overhead;
  // constant quality: ±; the audio / subtitle part is close to exact
  const vLow = video.exact ? 0.97 : 0.65;
  const vHigh = video.exact ? 1.03 : 1.45;
  const rest = total - videoBytes;
  if (!secs) notes.push('Duration unknown – estimate from file size only');
  if (video.encoder === 'copy' && audioPlan.every((p) => p.encoder === 'copy')) notes.push('Streams are copied: the size only changes by the tracks left out');
  return {
    bytes: Math.round(total),
    low: Math.round(videoBytes * vLow + rest * 0.95),
    high: Math.round(videoBytes * vHigh + rest * 1.05),
    sourceBytes,
    parts: { video: Math.round(videoBytes), audio: Math.round(audioBytes), subtitles: Math.round(subsBytes), other: Math.round(fontBytes + overhead) },
    videoKbps: Math.round(video.kbps),
    notes,
    exact: video.exact,
  };
}
