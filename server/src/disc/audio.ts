/**
 * Picking audio tracks for a disc rip. A disc often carries the same language several times (DTS 5.1, AC3 5.1,
 * AC3 stereo); "best" keeps the highest quality one per language, which is what most people want.
 */
import type { DiscAudioTrack, DiscTitle } from '../../../shared/types.js';

/** Rough quality order of the codecs a disc can carry. */
const CODEC_RANK: [RegExp, number, boolean][] = [
  [/truehd|dolby\s*true/i, 100, true],
  [/dts[-\s]?hd\s*ma|dts[-\s]?hd\s*master/i, 95, true],
  [/flac/i, 90, true],
  [/lpcm|pcm/i, 85, true],
  [/dts[-\s]?hd(\s*hra?)?|dts[-\s]?x/i, 70, false],
  [/dts[-\s]?es/i, 65, false],
  [/\bdts\b/i, 60, false],
  [/e[-\s]?ac[-\s]?3|dd\s*plus|ddp|eac3/i, 50, false],
  [/ac[-\s]?3|dolby\s*digital|\bdd\b/i, 40, false],
  [/aac/i, 30, false],
  [/mp3|mp2|mpeg\s*audio/i, 20, false],
];

export function codecRank(codec: string): { rank: number; lossless: boolean } {
  for (const [re, rank, lossless] of CODEC_RANK) if (re.test(codec)) return { rank, lossless };
  return { rank: 10, lossless: false };
}

/** Higher is better: codec first, then channels, then bitrate. Commentary tracks rank last. */
export function audioQuality(t: Pick<DiscAudioTrack, 'codec' | 'channels' | 'bitrateKbps' | 'label' | 'name'>): number {
  const { rank } = codecRank(t.codec);
  // a commentary track is never the automatic pick, however good it sounds
  const commentary = /comment|director|descriptive|narration/i.test(`${t.label ?? ''} ${t.name ?? ''}`);
  return (commentary ? -1_000_000 : 0) + rank * 1000 + Math.min(8, t.channels ?? 2) * 100 + Math.min(99, Math.round((t.bitrateKbps ?? 0) / 100));
}

/** The best track per language (unknown languages count as one group), in track order. */
export function bestAudioPerLanguage(tracks: DiscAudioTrack[]): number[] {
  const best = new Map<string, DiscAudioTrack>();
  for (const t of tracks) {
    const key = (t.language || 'und').toLowerCase();
    const current = best.get(key);
    if (!current || audioQuality(t) > audioQuality(current)) best.set(key, t);
  }
  return [...best.values()].map((t) => t.index).sort((a, b) => a - b);
}

/** Track indices to keep for one title. */
export function audioSelectionFor(title: DiscTitle, mode: 'best' | 'all' | 'custom', custom?: number[]): number[] {
  const tracks = title.audioTracks ?? [];
  if (!tracks.length) return [];
  if (mode === 'all') return tracks.map((t) => t.index);
  if (mode === 'custom') {
    const wanted = (custom ?? []).filter((i) => tracks.some((t) => t.index === i));
    return wanted.length ? [...wanted].sort((a, b) => a - b) : bestAudioPerLanguage(tracks);
  }
  return bestAudioPerLanguage(tracks);
}

export function describeTracks(title: DiscTitle, indices: number[]): string {
  const tracks = title.audioTracks ?? [];
  return indices.map((i) => tracks.find((t) => t.index === i)?.label ?? `track ${i + 1}`).join(', ');
}
