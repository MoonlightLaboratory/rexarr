/**
 * What FFprobe found, in the terms smart-profile rules are written in.
 *
 * Object audio is the interesting one. FFmpeg reports it in a stream's profile – "Dolby TrueHD + Dolby Atmos",
 * "Dolby Digital Plus + Dolby Atmos", "DTS-HD MA + DTS:X", "DTS-HD MA + DTS:X IMAX" – and there is nothing else
 * in the container that says so, no side data and no channel count that settles it, since plenty of 7.1 TrueHD
 * tracks carry no objects at all. An FFmpeg too old to name it simply never reports it.
 */
import type { SourceFacts } from '../../../shared/types.js';
import type { ProbeResult, ProbeStream } from './probe.js';

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

export function sourceFacts(info: Pick<ProbeResult, 'audio' | 'video' | 'durationSeconds' | 'sizeBytes' | 'bitRate' | 'isHdr' | 'isDolbyVision'>): SourceFacts {
  const audio = info.audio ?? [];
  const codecs = [...new Set(audio.map(audioCodecName).filter(Boolean))];
  return {
    audio: {
      maxChannels: audio.reduce((n, s) => Math.max(n, s.channels ?? 0), 0),
      codecs,
      objectBased: audio.some(isObjectAudio),
      lossless: codecs.some((c) => LOSSLESS.has(c)),
      profiles: [...new Set(audio.map((s) => s.profile).filter((p): p is string => Boolean(p)))],
    },
    video: {
      height: info.video?.height ?? 0,
      codec: (info.video?.codec_name ?? '').toLowerCase(),
      hdr: Boolean(info.isHdr),
      dolbyVision: Boolean(info.isDolbyVision),
    },
    source: {
      durationMinutes: Math.round(info.durationSeconds / 60),
      sizeGB: Number((info.sizeBytes / 1e9).toFixed(2)),
      bitrateMbps: Number((info.bitRate / 1e6).toFixed(1)),
    },
  };
}
