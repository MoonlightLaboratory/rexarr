/**
 * Music release / file format parsing: "FLAC 24bit", "[FLAC 24-96]", "Hi-Res", "MQA", "MP3 320", "V0", "WEB", "CD", "Vinyl".
 */
import type { ReleaseCategory } from '../../../shared/types.js';

export interface MusicFormat {
  format?: string;
  bitDepth?: number;
  sampleRate?: number;
  bitrate?: number;
  lossless: boolean;
  mqa: boolean;
  source?: 'CD' | 'WEB' | 'Vinyl' | 'SACD' | 'DVD-A' | 'Blu-ray';
}

const LOSSLESS = /\b(flac|alac|wav|aiff?|ape|wv|wavpack|dsd|dsf|lossless|pcm)\b/i;

export function musicFormatFromText(text: string): MusicFormat {
  const t = text.replace(/_/g, ' ');
  const out: MusicFormat = { lossless: LOSSLESS.test(t), mqa: /\bmqa\b/i.test(t) };
  const fmt = t.match(/\b(FLAC|ALAC|WAV|AIFF|APE|WavPack|DSD|DSF|MP3|AAC|OGG|Vorbis|Opus|M4A)\b/i)?.[1];
  if (fmt) out.format = fmt.toUpperCase().replace('WAVPACK', 'WavPack').replace('VORBIS', 'Vorbis').replace('OPUS', 'Opus');
  // "24bit", "24-bit", "24 bit", "24-96", "24/96", "24B-96kHz", "96kHz"
  const depthRate = t.match(/\b(16|24|32)\s*(?:bit|b)?\s*[-/ ]\s*(44(?:[.,]1)?|48|88(?:[.,]2)?|96|176(?:[.,]4)?|192|352(?:[.,]8)?|384)\s*(?:k(?:hz)?)?\b/i);
  if (depthRate) {
    out.bitDepth = Number(depthRate[1]);
    out.sampleRate = Math.round(parseFloat(depthRate[2].replace(',', '.')) * 1000);
  }
  out.bitDepth ??= Number(t.match(/\b(16|24|32)[\s-]?bits?\b/i)?.[1]) || undefined;
  if (!out.sampleRate) {
    const khz = t.match(/\b(44[.,]1|48|88[.,]2|96|176[.,]4|192|352[.,]8|384)\s*khz\b/i)?.[1];
    if (khz) out.sampleRate = Math.round(parseFloat(khz.replace(',', '.')) * 1000);
  }
  if (/\bhi[\s-]?res\b/i.test(t)) out.bitDepth ??= 24;
  const kbps = t.match(/\b(96|128|160|192|224|256|320)\s*(?:kbps|k)?\b/i);
  if (kbps && /mp3|aac|ogg|opus|vorbis|m4a|kbps/i.test(t)) out.bitrate = Number(kbps[1]);
  if (/\bV0\b/.test(t)) out.bitrate ??= 245;
  if (out.bitrate && !fmt) out.format = 'MP3';
  if (/\bvinyl\b|\bLP\b|\b24[- ]?192\b.*vinyl/i.test(t)) out.source = 'Vinyl';
  else if (/\bSACD\b/i.test(t)) out.source = 'SACD';
  else if (/\bDVD-?A\b/i.test(t)) out.source = 'DVD-A';
  else if (/\bWEB\b/i.test(t)) out.source = 'WEB';
  else if (/\bCD\b|\bCDDA\b/.test(t)) out.source = 'CD';
  if (out.format && !['FLAC', 'ALAC', 'WAV', 'AIFF', 'APE', 'WavPack', 'DSD', 'DSF'].includes(out.format)) out.lossless = false;
  return out;
}

/** Category for music releases: MQA, hi-res lossless (> 16 bit or > 48 kHz), CD-quality lossless, lossy. */
export function musicCategory(f: MusicFormat): ReleaseCategory {
  if (f.mqa) return 'mqa';
  if (f.lossless && ((f.bitDepth ?? 16) > 16 || (f.sampleRate ?? 44100) > 48000)) return 'hires';
  if (f.lossless) return 'cd';
  return f.format || f.bitrate ? 'lossy' : 'other';
}

/** "FLAC 24/96", "MP3 320", "FLAC 16/44.1". */
export function formatLabel(f: Pick<MusicFormat, 'format' | 'bitDepth' | 'sampleRate' | 'bitrate'>): string {
  const rate = f.sampleRate ? `${(f.sampleRate / 1000).toString().replace(/\.0$/, '')}` : '';
  if (f.bitDepth || rate) return `${f.format ?? 'Lossless'} ${f.bitDepth ?? ''}${f.bitDepth && rate ? '/' : ''}${rate}`.trim();
  if (f.bitrate) return `${f.format ?? 'MP3'} ${f.bitrate}`;
  return f.format ?? 'Unknown';
}
