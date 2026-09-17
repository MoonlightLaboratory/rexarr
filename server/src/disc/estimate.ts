/**
 * Estimated size of a disc rip, and of the transcode that follows it. MakeMKV's title list already tells us the
 * duration, the raw size and every stream, so the same model the Transcode dialog uses can run before anything
 * has been ripped (no files to probe yet).
 */
import type { DiscRip, DiscTitle, Profile, SizeEstimate, TranscodingSettings, VideoEncoder } from '../../../shared/types.js';
import type { ProbeResult, ProbeStream } from '../ffmpeg/probe.js';
import { estimateSize } from '../ffmpeg/estimate.js';
import { audioSelectionFor } from './audio.js';


/** MakeMKV's stream description → the codec name ffprobe would report. */
function ffCodec(codec: string | undefined, kind: 'video' | 'audio' | 'subtitle'): string {
  const c = (codec ?? '').toLowerCase();
  if (kind === 'video') {
    if (c.includes('mpeg-2') || c.includes('mpeg2')) return 'mpeg2video';
    if (c.includes('265') || c.includes('hevc')) return 'hevc';
    if (c.includes('vc-1') || c.includes('vc1')) return 'vc1';
    return 'h264';
  }
  if (kind === 'audio') {
    if (c.includes('truehd') || c.includes('true hd')) return 'truehd';
    if (c.includes('dts-hd ma') || c.includes('master')) return 'dts';
    if (c.includes('dts')) return 'dts';
    if (c.includes('e-ac3') || c.includes('eac3') || c.includes('plus')) return 'eac3';
    if (c.includes('ac3') || c.includes('dolby digital') || c === 'dd') return 'ac3';
    if (c.includes('lpcm') || c.includes('pcm')) return 'pcm_s24le';
    if (c.includes('flac')) return 'flac';
    if (c.includes('aac')) return 'aac';
    return 'ac3';
  }
  return c.includes('pgs') || c.includes('hdmv') ? 'hdmv_pgs_subtitle' : c.includes('vobsub') || c.includes('dvd') ? 'dvd_subtitle' : 'subrip';
}

/** A ProbeResult as the ripped MKV of this title would look, with only the audio tracks that will be kept. */
export function probeForTitle(title: DiscTitle, keepAudio: number[]): ProbeResult {
  const [w, h] = (title.resolution ?? '1920x1080').split('x').map((n) => Number(n) || 0);
  const frameRate = Number((title.frameRate ?? '').split(/[^\d.]/)[0]) || 24;
  const tracks = (title.audioTracks ?? []).filter((t) => keepAudio.includes(t.index));
  const audio: ProbeStream[] = tracks.map((t, i) => ({
    index: i + 1,
    codec_type: 'audio',
    codec_name: ffCodec(t.codec, 'audio'),
    channels: t.channels ?? 2,
    bit_rate: t.bitrateKbps ? String(t.bitrateKbps * 1000) : undefined,
    tags: { language: t.language || 'und', title: t.name ?? '' },
  }));
  const subtitles: ProbeStream[] = (title.subtitles ?? []).map((s, i) => ({
    index: audio.length + 1 + i,
    codec_type: 'subtitle',
    codec_name: ffCodec(s, 'subtitle'),
    tags: { language: (s.split(/\s+/).pop() ?? 'und').toLowerCase() },
  }));
  const audioKbps = tracks.reduce((n, t) => n + (t.bitrateKbps ?? (t.channels ?? 2) > 2 ? 448 : 192), 0);
  const totalKbps = title.durationSeconds ? (title.sizeBytes * 8) / title.durationSeconds / 1000 : 0;
  const video: ProbeStream = {
    index: 0,
    codec_type: 'video',
    codec_name: ffCodec(title.videoCodec, 'video'),
    width: w || 1920,
    height: h || 1080,
    r_frame_rate: `${frameRate}/1`,
    bit_rate: String(Math.max(500, totalKbps - audioKbps) * 1000),
  };
  return {
    path: title.fileName,
    durationSeconds: title.durationSeconds,
    sizeBytes: title.sizeBytes,
    bitRate: totalKbps * 1000,
    formatName: 'matroska',
    streams: [video, ...audio, ...subtitles],
    video,
    audio,
    subtitles,
    attachments: [],
    isHdr: false,
    isDolbyVision: false,
    frameRate,
  };
}

export interface DiscEstimate {
  /** Raw MakeMKV output for the selected titles, after dropping unwanted audio. */
  ripBytes: number;
  /** After transcoding, when the rip is set to transcode. */
  transcode?: SizeEstimate;
  titleCount: number;
  durationSeconds: number;
}

export function estimateRip(
  rip: DiscRip,
  profile: Profile | undefined,
  audioMode: 'best' | 'all' | 'custom',
  opts: { anime?: boolean; hardware?: TranscodingSettings; availableEncoders?: VideoEncoder[] } = {},
): DiscEstimate {
  const titles = rip.titles.filter((t) => rip.selectedTitleIds.includes(t.id));
  let ripBytes = 0;
  let durationSeconds = 0;
  const probes: ProbeResult[] = [];
  for (const t of titles) {
    const keep = audioSelectionFor(t, audioMode, rip.selectedAudio?.[String(t.id)]);
    const all = t.audioTracks ?? [];
    const dropped = all.filter((a) => !keep.includes(a.index));
    const droppedBytes = dropped.reduce((n, a) => n + ((a.bitrateKbps ?? 448) * 1000 * t.durationSeconds) / 8, 0);
    ripBytes += Math.max(0, t.sizeBytes - droppedBytes);
    durationSeconds += t.durationSeconds;
    probes.push(probeForTitle(t, keep));
  }
  const out: DiscEstimate = { ripBytes, titleCount: titles.length, durationSeconds };
  if (profile && rip.options.transcode && probes.length) {
    const parts = { video: 0, audio: 0, subtitles: 0, other: 0 };
    let bytes = 0;
    let low = 0;
    let high = 0;
    let sourceBytes = 0;
    let videoKbps = 0;
    let exact = true;
    const notes = new Set<string>();
    for (const p of probes) {
      const e = estimateSize(profile, p, opts);
      bytes += e.bytes;
      low += e.low;
      high += e.high;
      sourceBytes += e.sourceBytes;
      videoKbps = e.videoKbps ?? videoKbps;
      exact = exact && e.exact;
      parts.video += e.parts.video;
      parts.audio += e.parts.audio;
      parts.subtitles += e.parts.subtitles;
      parts.other += e.parts.other;
      for (const n of e.notes) notes.add(n);
    }
    out.transcode = { profileId: profile.id, profileName: profile.name, bytes, low, high, sourceBytes, parts, videoKbps, exact, notes: [...notes] };
  }
  return out;
}
