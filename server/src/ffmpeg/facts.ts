/**
 * What FFprobe found, in the terms smart-profile rules are written in.
 *
 * Object audio is the interesting one. FFmpeg reports it in a stream's profile – "Dolby TrueHD + Dolby Atmos",
 * "Dolby Digital Plus + Dolby Atmos", "DTS-HD MA + DTS:X", "DTS-HD MA + DTS:X IMAX" – and there is nothing else
 * in the container that says so, no side data and no channel count that settles it, since plenty of 7.1 TrueHD
 * tracks carry no objects at all. An FFmpeg too old to name it simply never reports it.
 */
import type { SourceFacts } from '../../../shared/types.js';
import { isTextSubtitle, streamLanguage, streamTitle, type ProbeResult, type ProbeStream } from './probe.js';

const LOSSLESS = new Set(['truehd', 'mlp', 'flac', 'alac', 'pcm', 'dts-hd-ma']);

/** ffprobe's codec_name plus its profile, as one name a person would use. */
export function audioCodecName(s: Pick<ProbeStream, 'codec_name' | 'profile'>): string {
  const codec = (s.codec_name ?? '').toLowerCase();
  const profile = (s.profile ?? '').toLowerCase();
  if (codec === 'dts') {
    if (profile.includes('dts-hd ma')) return 'dts-hd-ma';
    if (profile.includes('dts-hd hra')) return 'dts-hd-hra';
    if (profile.includes('dts express')) return 'dts-express';
    return 'dts';
  }
  if (codec.startsWith('pcm')) return 'pcm';
  if (codec === 'mlp') return 'truehd';
  if (codec === 'libopus') return 'opus';
  return codec;
}

export function isObjectAudio(s: Pick<ProbeStream, 'profile'>): boolean {
  return /atmos|dts:x/i.test(s.profile ?? '');
}

export function sourceFacts(
  info: Pick<ProbeResult, 'audio' | 'video' | 'subtitles' | 'durationSeconds' | 'sizeBytes' | 'bitRate' | 'isHdr' | 'isDolbyVision' | 'formatName' | 'frameRate'>,
  media: SourceFacts['media'] = { kind: 'unknown', genres: [], year: 0 },
): SourceFacts {
  const audio = info.audio ?? [];
  const subs = info.subtitles ?? [];
  const codecs = [...new Set(audio.map(audioCodecName).filter(Boolean))];
  const pix = info.video?.pix_fmt ?? '';
  return {
    audio: {
      maxChannels: audio.reduce((n, s) => Math.max(n, s.channels ?? 0), 0),
      codecs,
      objectBased: audio.some(isObjectAudio),
      lossless: codecs.some((c) => LOSSLESS.has(c)),
      profiles: [...new Set(audio.map((s) => s.profile).filter((p): p is string => Boolean(p)))],
    },
    audioExtra: {
      languages: [...new Set(audio.map(streamLanguage))],
      hasCommentary: audio.some((s) => /comment|director|descriptive|narration/i.test(streamTitle(s))),
      trackCount: audio.length,
      maxBitrateKbps: Math.round(audio.reduce((n, s) => Math.max(n, Number(s.bit_rate ?? 0)), 0) / 1000),
    },
    video: {
      height: info.video?.height ?? 0,
      width: info.video?.width ?? 0,
      codec: (info.video?.codec_name ?? '').toLowerCase(),
      hdr: Boolean(info.isHdr),
      dolbyVision: Boolean(info.isDolbyVision),
      // 10- and 12-bit pixel formats name their depth; everything else is 8
      bitDepth: /12le|12be/.test(pix) ? 12 : /10le|10be|p010/.test(pix) ? 10 : info.video ? 8 : 0,
      frameRate: Number((info.frameRate ?? 0).toFixed(3)),
      interlaced: /tt|bb|tb|bt/.test(info.video?.field_order ?? ''),
    },
    subtitles: {
      count: subs.length,
      languages: [...new Set(subs.map(streamLanguage))],
      hasForced: subs.some((s) => s.disposition?.forced === 1 || /forced/i.test(streamTitle(s))),
      hasText: subs.some(isTextSubtitle),
    },
    source: {
      durationMinutes: Math.round(info.durationSeconds / 60),
      sizeGB: Number((info.sizeBytes / 1e9).toFixed(2)),
      bitrateMbps: Number((info.bitRate / 1e6).toFixed(1)),
      container: containerOf(info.formatName) ?? '',
    },
    media,
  };
}

/** ffprobe names several formats at once ("matroska,webm"); this is the container Rexarr would call it. */
export function containerOf(formatName: string): string | undefined {
  const names = (formatName ?? '').split(',');
  if (names.includes('matroska')) return 'mkv';
  if (names.some((n) => n === 'mp4' || n === 'mov')) return names.includes('mp4') ? 'mp4' : 'mov';
  if (names.includes('webm')) return 'webm';
  return undefined;
}
