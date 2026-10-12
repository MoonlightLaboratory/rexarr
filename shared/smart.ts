/**
 * The rules engine behind smart profiles. Pure: the server runs it on what FFprobe found, and the editor runs
 * the same code on made-up discs so a rule can be tried before it is saved.
 */
import type { AudioEncoder, Container, Profile, SmartAssignment, SmartCondition, SmartField, SmartOperator, SmartProfile, SmartRule, SmartSettingPath, SourceFacts, SubtitleMode, VideoEncoder, VideoTune } from './types.js';
import { AUDIO_ENCODER_INFO, CONTAINER_INFO, SMART_STOCK, VIDEO_ENCODER_INFO } from './presets.js';

export interface SmartFieldInfo {
  field: SmartField;
  label: string;
  /** Which operators make sense, and what the value looks like. */
  kind: 'number' | 'list' | 'boolean';
  unit?: string;
  options?: { value: string; label: string }[];
  help?: string;
}

export const AUDIO_CODECS = [
  { value: 'truehd', label: 'TrueHD' },
  { value: 'dts-hd-ma', label: 'DTS-HD MA' },
  { value: 'dts-hd-hra', label: 'DTS-HD HRA' },
  { value: 'dts', label: 'DTS' },
  { value: 'eac3', label: 'E-AC-3 (DD+)' },
  { value: 'ac3', label: 'AC-3 (Dolby Digital)' },
  { value: 'flac', label: 'FLAC' },
  { value: 'pcm', label: 'PCM' },
  { value: 'aac', label: 'AAC' },
  { value: 'opus', label: 'Opus' },
  { value: 'mp3', label: 'MP3' },
];

const VIDEO_CODECS = [
  { value: 'h264', label: 'H.264' },
  { value: 'hevc', label: 'HEVC / H.265' },
  { value: 'av1', label: 'AV1' },
  { value: 'vc1', label: 'VC-1' },
  { value: 'mpeg2video', label: 'MPEG-2' },
  { value: 'vp9', label: 'VP9' },
];

export const SMART_FIELDS: SmartFieldInfo[] = [
  { field: 'audio.maxChannels', label: 'Audio channels', kind: 'number', help: 'The widest audio track in the file: 2 for stereo, 6 for 5.1, 8 for 7.1.' },
  { field: 'audio.objectBased', label: 'Object audio (Atmos / DTS:X)', kind: 'boolean', help: 'Needs an FFmpeg that reports it in the stream profile; System → Status shows the version.' },
  { field: 'audio.lossless', label: 'Lossless audio', kind: 'boolean', help: 'TrueHD, DTS-HD MA, FLAC or PCM is present.' },
  { field: 'audio.codecs', label: 'Audio codec', kind: 'list', options: AUDIO_CODECS, help: 'Matches when any audio track in the file is one of these.' },
  { field: 'video.height', label: 'Video height', kind: 'number', unit: 'px', help: '1080 for 1080p, 2160 for 4K.' },
  { field: 'video.codec', label: 'Video codec', kind: 'list', options: VIDEO_CODECS },
  { field: 'video.hdr', label: 'HDR', kind: 'boolean' },
  { field: 'video.dolbyVision', label: 'Dolby Vision', kind: 'boolean' },
  { field: 'source.durationMinutes', label: 'Running time', kind: 'number', unit: 'min' },
  { field: 'source.sizeGB', label: 'File size', kind: 'number', unit: 'GB' },
  { field: 'source.bitrateMbps', label: 'Bitrate', kind: 'number', unit: 'Mbps' },
  { field: 'media.kind', label: 'This is a', kind: 'list', options: [
    { value: 'movie', label: 'Movie' },
    { value: 'series', label: 'Series' },
    { value: 'anime', label: 'Anime' },
  ] },
  { field: 'media.genres', label: 'Genre', kind: 'list', options: [
    { value: 'animation', label: 'Animation' },
    { value: 'documentary', label: 'Documentary' },
    { value: 'concert', label: 'Concert' },
    { value: 'action', label: 'Action' },
    { value: 'horror', label: 'Horror' },
    { value: 'comedy', label: 'Comedy' },
    { value: 'drama', label: 'Drama' },
    { value: 'family', label: 'Family' },
  ], help: 'Genres as Radarr or Sonarr have them, lower-cased. Looked up only when a branch asks.' },
];

export const fieldInfo = (field: SmartField): SmartFieldInfo | undefined => SMART_FIELDS.find((f) => f.field === field);

export function operatorsFor(kind: SmartFieldInfo['kind']): SmartOperator[] {
  if (kind === 'number') return ['atLeast', 'atMost', 'equals'];
  if (kind === 'list') return ['anyOf', 'noneOf'];
  return ['isTrue', 'isFalse'];
}

export const OPERATOR_LABELS: Record<SmartOperator, string> = {
  atLeast: 'is at least',
  atMost: 'is at most',
  equals: 'is exactly',
  anyOf: 'is any of',
  noneOf: 'is none of',
  isTrue: 'yes',
  isFalse: 'no',
};

/** The value of a field for one file. Numbers for numeric fields, string lists for codecs, booleans for flags. */
export function factValue(field: SmartField, facts: SourceFacts): number | boolean | string[] {
  switch (field) {
    case 'audio.maxChannels':
      return facts.audio.maxChannels;
    case 'audio.codecs':
      return facts.audio.codecs;
    case 'audio.objectBased':
      return facts.audio.objectBased;
    case 'audio.lossless':
      return facts.audio.lossless;
    case 'video.height':
      return facts.video.height;
    case 'video.codec':
      return facts.video.codec ? [facts.video.codec] : [];
    case 'video.hdr':
      return facts.video.hdr;
    case 'video.dolbyVision':
      return facts.video.dolbyVision;
    case 'source.durationMinutes':
      return facts.source.durationMinutes;
    case 'source.sizeGB':
      return facts.source.sizeGB;
    case 'source.bitrateMbps':
      return facts.source.bitrateMbps;
    case 'media.kind':
      return [facts.media.kind];
    case 'media.genres':
      return facts.media.genres;
  }
}

export function conditionHolds(c: SmartCondition, facts: SourceFacts): boolean {
  const value = factValue(c.field, facts);
  switch (c.op) {
    case 'atLeast':
      return typeof value === 'number' && value >= (c.number ?? 0);
    case 'atMost':
      return typeof value === 'number' && value <= (c.number ?? 0);
    case 'equals':
      return typeof value === 'number' && value === (c.number ?? 0);
    case 'anyOf':
      return Array.isArray(value) && value.some((v) => (c.list ?? []).includes(v));
    case 'noneOf':
      return Array.isArray(value) && !value.some((v) => (c.list ?? []).includes(v));
    case 'isTrue':
      return value === true;
    case 'isFalse':
      return value === false;
  }
}

/** A rule needs every one of its conditions. One with none is unfinished, and never matches. */
export function ruleMatches(rule: SmartRule, facts: SourceFacts): boolean {
  return rule.when.length > 0 && rule.when.every((c) => conditionHolds(c, facts));
}

export interface SmartDecision {
  /** Every rule that fits, in order. A later one wins where two touch the same setting. */
  applied: { index: number; rule: SmartRule }[];
  /** The settings the encode ends up with. */
  profile: Profile;
  /** Which rule set each path, for showing where a value came from. */
  from: Partial<Record<SmartSettingPath, number>>;
}

/** The settings a smart profile starts from before its own base. */
export function stockBase(): Pick<Profile, 'video' | 'audio' | 'subtitles' | 'output'> {
  return {
    video: { ...SMART_STOCK.video },
    audio: { ...SMART_STOCK.audio },
    subtitles: { ...SMART_STOCK.subtitles },
    output: { ...SMART_STOCK.output },
  };
}

/** Apply one assignment to a profile being built. Unknown paths are ignored rather than throwing. */
export function assign(profile: Profile, a: SmartAssignment): void {
  switch (a.path) {
    case 'container':
      profile.container = a.value as Container;
      break;
    case 'video.encoder':
      profile.video.encoder = a.value as VideoEncoder;
      break;
    case 'video.quality':
      profile.video.quality = Number(a.value);
      break;
    case 'video.preset':
      profile.video.preset = String(a.value);
      break;
    case 'video.tune':
      profile.video.tune = a.value as VideoTune;
      break;
    case 'video.maxHeight':
      profile.video.maxHeight = Number(a.value);
      break;
    case 'video.pixelFormat':
      profile.video.pixelFormat = a.value as Profile['video']['pixelFormat'];
      break;
    case 'video.hdrPassthrough':
      profile.video.hdrPassthrough = Boolean(a.value);
      break;
    case 'audio.encoder':
      profile.audio.encoder = a.value as AudioEncoder;
      break;
    case 'audio.bitrate':
      profile.audio.bitrate = Number(a.value);
      break;
    case 'audio.channels':
      profile.audio.channels = Number(a.value);
      break;
    case 'audio.dropCommentary':
      profile.audio.dropCommentary = Boolean(a.value);
      break;
    case 'subtitles.mode':
      profile.subtitles.mode = a.value as SubtitleMode;
      break;
  }
}

/**
 * What this smart profile comes to for one file: its own settings, then every branch that fits, in order. The
 * answer is an ordinary profile, so everything downstream – the ffmpeg command, the size estimate, the output
 * name – works on it without knowing a decision was made.
 */
export function decide(smart: SmartProfile, facts: SourceFacts): SmartDecision {
  const stock = stockBase();
  const profile: Profile = {
    id: smart.id,
    name: smart.name,
    description: smart.description,
    builtin: false,
    mediaType: smart.mediaType,
    container: smart.container ?? 'mkv',
    video: stock.video,
    audio: stock.audio,
    subtitles: stock.subtitles,
    output: stock.output,
    createdAt: smart.createdAt,
    updatedAt: smart.updatedAt,
  };
  const from: SmartDecision['from'] = {};
  for (const a of smart.base ?? []) assign(profile, a);
  const applied: SmartDecision['applied'] = [];
  smart.rules.forEach((rule, index) => {
    if (!ruleMatches(rule, facts)) return;
    applied.push({ index, rule });
    for (const a of rule.set ?? []) {
      assign(profile, a);
      from[a.path] = index;
    }
  });
  return { applied, profile, from };
}

/** Nothing is re-encoded and the container is unchanged: there is no point running ffmpeg over the file. */
export function isPassThrough(profile: Profile, sourceContainer?: string): boolean {
  return (
    profile.video.encoder === 'copy' &&
    profile.audio.encoder === 'copy' &&
    profile.subtitles.mode === 'copy' &&
    profile.video.maxHeight === 0 &&
    (!sourceContainer || sourceContainer === profile.container)
  );
}

// ---------------------------------------------------------------- wording

export function describeCondition(c: SmartCondition): string {
  const info = fieldInfo(c.field);
  const label = info?.label ?? c.field;
  if (c.op === 'isTrue') return label;
  if (c.op === 'isFalse') return `no ${label.toLowerCase()}`;
  if (c.op === 'anyOf' || c.op === 'noneOf') {
    const names = (c.list ?? []).map((v) => info?.options?.find((o) => o.value === v)?.label ?? v);
    return `${label} ${OPERATOR_LABELS[c.op]} ${names.join(', ') || '…'}`;
  }
  return `${label} ${OPERATOR_LABELS[c.op]} ${c.number ?? 0}${info?.unit ? ` ${info.unit}` : ''}`;
}

export interface SmartSettingInfo {
  path: SmartSettingPath;
  label: string;
  kind: 'select' | 'number' | 'boolean';
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  unit?: string;
}

export const SMART_SETTINGS: SmartSettingInfo[] = [
  { path: 'video.encoder', label: 'Video encoder', kind: 'select', options: Object.entries(VIDEO_ENCODER_INFO).map(([value, v]) => ({ value, label: v.label })) },
  { path: 'video.quality', label: 'Video quality (CRF)', kind: 'number', min: 0, max: 63 },
  { path: 'video.preset', label: 'Video preset', kind: 'select', options: [...new Set(Object.values(VIDEO_ENCODER_INFO).flatMap((v) => v.presets))].map((value) => ({ value, label: value })) },
  { path: 'video.tune', label: 'Video tune', kind: 'select', options: ['none', 'animation', 'film', 'grain', 'fastdecode', 'zerolatency'].map((value) => ({ value, label: value })) },
  { path: 'video.maxHeight', label: 'Downscale to at most', kind: 'number', min: 0, max: 4320, unit: 'px' },
  { path: 'video.pixelFormat', label: 'Pixel format', kind: 'select', options: ['auto', 'yuv420p', 'yuv420p10le', 'p010le', 'nv12'].map((value) => ({ value, label: value })) },
  { path: 'video.hdrPassthrough', label: 'Keep HDR metadata', kind: 'boolean' },
  { path: 'audio.encoder', label: 'Audio encoder', kind: 'select', options: Object.entries(AUDIO_ENCODER_INFO).map(([value, v]) => ({ value, label: v.label })) },
  { path: 'audio.bitrate', label: 'Audio bitrate', kind: 'number', min: 0, max: 3000, unit: 'kbps' },
  { path: 'audio.channels', label: 'Audio channels', kind: 'select', options: [
    { value: '0', label: 'Keep the source layout' },
    { value: '2', label: 'Stereo' },
    { value: '6', label: '5.1' },
    { value: '8', label: '7.1' },
  ] },
  { path: 'audio.dropCommentary', label: 'Drop commentary tracks', kind: 'boolean' },
  { path: 'subtitles.mode', label: 'Subtitles', kind: 'select', options: [
    { value: 'copy', label: 'Copy' },
    { value: 'copy-text', label: 'Copy text only' },
    { value: 'burn', label: 'Burn in' },
    { value: 'none', label: 'Drop' },
  ] },
  { path: 'container', label: 'Container', kind: 'select', options: Object.entries(CONTAINER_INFO).filter(([, v]) => !v.music).map(([value, v]) => ({ value, label: v.label })) },
];

export const settingInfo = (path: SmartSettingPath) => SMART_SETTINGS.find((s) => s.path === path);

export function describeAssignment(a: SmartAssignment): string {
  const info = settingInfo(a.path);
  const label = info?.label ?? a.path;
  if (info?.kind === 'boolean') return `${label}: ${a.value ? 'yes' : 'no'}`;
  const option = info?.options?.find((o) => o.value === String(a.value));
  return `${label}: ${option?.label ?? a.value}${info?.unit ? ` ${info.unit}` : ''}`;
}

/** One line for the job log: what was found, which branches fired, and what the encode ended up being. */
export function explainDecision(smart: SmartProfile, facts: SourceFacts, decision: SmartDecision): string {
  const audio = `${facts.audio.maxChannels}ch ${facts.audio.codecs.join('/') || 'no audio'}${facts.audio.objectBased ? ' (object audio)' : ''}`;
  const where = decision.applied.length ? decision.applied.map((a) => `#${a.index + 1} ${a.rule.when.map(describeCondition).join(' and ')}`).join('; ') : 'no branch matched';
  const p = decision.profile;
  // a bitrate means nothing for a lossless encoder, so it is not quoted back as if it did
  const lossy = p.audio.encoder !== 'copy' && !AUDIO_ENCODER_INFO[p.audio.encoder]?.lossless;
  const result = `${p.video.encoder}${p.video.encoder !== 'copy' ? ` CRF ${p.video.quality}${p.video.tune !== 'none' ? ` tune ${p.video.tune}` : ''}` : ''} + ${p.audio.encoder}${lossy && p.audio.bitrate ? ` ${p.audio.bitrate}k` : ''}`;
  return `${smart.name}: ${audio}, ${facts.video.height || '?'}p${facts.video.hdr ? ' HDR' : ''} – ${where} → ${result}`;
}

// ---------------------------------------------------------------- trying one out

/** Discs to try a rule against in the editor, covering the cases these rules exist for. */
export const SAMPLE_SOURCES: { name: string; facts: SourceFacts }[] = [
  { name: 'UHD, TrueHD 7.1 Atmos', facts: { audio: { maxChannels: 8, codecs: ['truehd', 'ac3'], objectBased: true, lossless: true, profiles: ['Dolby TrueHD + Dolby Atmos'] }, video: { height: 2160, codec: 'hevc', hdr: true, dolbyVision: false }, source: { durationMinutes: 130, sizeGB: 58, bitrateMbps: 60 }, media: { kind: 'movie', genres: [] } } },
  { name: 'UHD, DTS-HD MA 7.1 + DTS:X', facts: { audio: { maxChannels: 8, codecs: ['dts-hd-ma'], objectBased: true, lossless: true, profiles: ['DTS-HD MA + DTS:X'] }, video: { height: 2160, codec: 'hevc', hdr: true, dolbyVision: true }, source: { durationMinutes: 115, sizeGB: 54, bitrateMbps: 62 }, media: { kind: 'movie', genres: [] } } },
  { name: 'Blu-ray, DTS-HD MA 5.1', facts: { audio: { maxChannels: 6, codecs: ['dts-hd-ma', 'ac3'], objectBased: false, lossless: true, profiles: ['DTS-HD MA'] }, video: { height: 1080, codec: 'h264', hdr: false, dolbyVision: false }, source: { durationMinutes: 105, sizeGB: 24, bitrateMbps: 30 }, media: { kind: 'movie', genres: [] } } },
  { name: 'Blu-ray, TrueHD 2.0 only', facts: { audio: { maxChannels: 2, codecs: ['truehd'], objectBased: false, lossless: true, profiles: ['Dolby TrueHD'] }, video: { height: 1080, codec: 'h264', hdr: false, dolbyVision: false }, source: { durationMinutes: 96, sizeGB: 18, bitrateMbps: 25 }, media: { kind: 'movie', genres: [] } } },
  { name: 'DVD, AC-3 2.0', facts: { audio: { maxChannels: 2, codecs: ['ac3'], objectBased: false, lossless: false, profiles: [] }, video: { height: 576, codec: 'mpeg2video', hdr: false, dolbyVision: false }, source: { durationMinutes: 92, sizeGB: 4, bitrateMbps: 6 }, media: { kind: 'movie', genres: [] } } },
  { name: 'Episode, AAC 5.1', facts: { audio: { maxChannels: 6, codecs: ['aac'], objectBased: false, lossless: false, profiles: [] }, video: { height: 1080, codec: 'h264', hdr: false, dolbyVision: false }, source: { durationMinutes: 42, sizeGB: 2, bitrateMbps: 7 }, media: { kind: 'movie', genres: [] } } },
];
