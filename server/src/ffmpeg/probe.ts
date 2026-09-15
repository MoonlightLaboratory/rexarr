import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface ProbeStream {
  index: number;
  codec_type: 'video' | 'audio' | 'subtitle' | 'attachment' | 'data';
  codec_name: string;
  profile?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  color_primaries?: string;
  color_transfer?: string;
  color_space?: string;
  color_range?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  channels?: number;
  channel_layout?: string;
  sample_rate?: string;
  bit_rate?: string;
  tags?: Record<string, string>;
  disposition?: Record<string, number>;
  side_data_list?: { side_data_type: string; [k: string]: unknown }[];
}

export interface ProbeResult {
  path: string;
  durationSeconds: number;
  sizeBytes: number;
  bitRate: number;
  formatName: string;
  streams: ProbeStream[];
  video?: ProbeStream;
  audio: ProbeStream[];
  subtitles: ProbeStream[];
  attachments: ProbeStream[];
  isHdr: boolean;
  isDolbyVision: boolean;
  frameRate: number;
}

export function streamLanguage(s: ProbeStream): string {
  return (s.tags?.language ?? s.tags?.LANGUAGE ?? 'und').toLowerCase();
}
export function streamTitle(s: ProbeStream): string {
  return s.tags?.title ?? s.tags?.TITLE ?? '';
}

const TEXT_SUB_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);
export function isTextSubtitle(s: ProbeStream) {
  return TEXT_SUB_CODECS.has(s.codec_name);
}

export async function probe(ffprobePath: string, file: string): Promise<ProbeResult> {
  const { stdout } = await run(
    ffprobePath,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 },
  );
  const json = JSON.parse(stdout) as { format: Record<string, string>; streams: ProbeStream[] };
  const streams = json.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video' && !(s.disposition?.attached_pic === 1));
  const isHdr = Boolean(video && (video.color_transfer === 'smpte2084' || video.color_transfer === 'arib-std-b67' || video.color_primaries === 'bt2020'));
  const isDolbyVision = Boolean(video?.side_data_list?.some((d) => /dovi|dolby vision/i.test(String(d.side_data_type))));
  const fr = video?.avg_frame_rate ?? video?.r_frame_rate ?? '0/1';
  const [n, d] = fr.split('/').map(Number);
  return {
    path: file,
    durationSeconds: Number(json.format?.duration ?? 0),
    sizeBytes: Number(json.format?.size ?? 0),
    bitRate: Number(json.format?.bit_rate ?? 0),
    formatName: json.format?.format_name ?? '',
    streams,
    video,
    audio: streams.filter((s) => s.codec_type === 'audio'),
    subtitles: streams.filter((s) => s.codec_type === 'subtitle'),
    attachments: streams.filter((s) => s.codec_type === 'attachment'),
    isHdr,
    isDolbyVision,
    frameRate: d ? n / d : 0,
  };
}
