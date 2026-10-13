/**
 * The rules engine behind smart profiles. Pure: the server runs it on what FFprobe found, and the editor runs
 * the same code on made-up discs so a rule can be tried before it is saved.
 */
import type { AudioEncoder, AudioPerLanguage, Container, Profile, SmartAssignment, SmartCondition, SmartField, SmartOperator, SmartProfile, SmartRule, SmartSettingPath, SourceFacts, SubtitleMode, VideoEncoder, VideoTune } from './types.js';
import { AUDIO_ENCODER_INFO, CONTAINER_INFO, LANGUAGES, SMART_STOCK, VIDEO_ENCODER_INFO } from './presets.js';

export interface SmartFieldInfo {
  field: SmartField;
  label: string;
  /** Which heading it sits under in the dropdown. */
  group: 'Audio' | 'Video' | 'Subtitles' | 'Source' | 'What it is' | 'Output';
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

const LANGS = LANGUAGES.map((l) => ({ value: l.code, label: l.label }));

export const SMART_FIELDS: SmartFieldInfo[] = [
  { field: 'audio.maxChannels', group: 'Audio', label: 'Audio channels', kind: 'number', help: 'The widest audio track in the file: 2 for stereo, 6 for 5.1, 8 for 7.1.' },
  { field: 'audio.objectBased', group: 'Audio', label: 'Object audio (Atmos / DTS:X)', kind: 'boolean', help: 'Needs an FFmpeg that reports it in the stream profile; System → Status shows the version.' },
  { field: 'audio.lossless', group: 'Audio', label: 'Lossless audio', kind: 'boolean', help: 'TrueHD, DTS-HD MA, FLAC or PCM is present.' },
  { field: 'audio.codecs', group: 'Audio', label: 'Audio codec', kind: 'list', options: AUDIO_CODECS, help: 'Matches when any audio track in the file is one of these.' },
  { field: 'audio.languages', group: 'Audio', label: 'Audio language', kind: 'list', options: LANGS, help: 'Matches when the file carries a track in one of these.' },
  { field: 'audio.hasCommentary', group: 'Audio', label: 'Has a commentary track', kind: 'boolean' },
  { field: 'audio.trackCount', group: 'Audio', label: 'Audio tracks', kind: 'number' },
  { field: 'audio.maxBitrateKbps', group: 'Audio', label: 'Audio bitrate', kind: 'number', unit: 'kbps', help: 'The highest a track declares. Many lossless tracks declare nothing, so this reads 0.' },
  { field: 'video.height', group: 'Video', label: 'Video height', kind: 'number', unit: 'px', help: '1080 for 1080p, 2160 for 4K.' },
  { field: 'video.width', group: 'Video', label: 'Video width', kind: 'number', unit: 'px' },
  { field: 'video.codec', group: 'Video', label: 'Video codec', kind: 'list', options: VIDEO_CODECS },
  { field: 'video.hdr', group: 'Video', label: 'HDR', kind: 'boolean' },
  { field: 'video.dolbyVision', group: 'Video', label: 'Dolby Vision', kind: 'boolean' },
  { field: 'video.bitDepth', group: 'Video', label: 'Video bit depth', kind: 'number', unit: 'bit', help: '8, 10 or 12, read from the pixel format.' },
  { field: 'video.frameRate', group: 'Video', label: 'Frame rate', kind: 'number', unit: 'fps' },
  { field: 'video.interlaced', group: 'Video', label: 'Interlaced', kind: 'boolean', help: 'Field order says the picture is interlaced – usually a DVD or a broadcast recording.' },
  { field: 'subtitles.count', group: 'Subtitles', label: 'Subtitle tracks', kind: 'number' },
  { field: 'subtitles.languages', group: 'Subtitles', label: 'Subtitle language', kind: 'list', options: LANGS },
  { field: 'subtitles.hasForced', group: 'Subtitles', label: 'Has forced subtitles', kind: 'boolean' },
  { field: 'subtitles.hasText', group: 'Subtitles', label: 'Has text subtitles', kind: 'boolean', help: 'SRT, ASS and friends, as opposed to the bitmap subtitles a disc carries.' },
  { field: 'source.durationMinutes', group: 'Source', label: 'Running time', kind: 'number', unit: 'min' },
  { field: 'source.sizeGB', group: 'Source', label: 'File size', kind: 'number', unit: 'GB' },
  { field: 'source.bitrateMbps', group: 'Source', label: 'Bitrate', kind: 'number', unit: 'Mbps' },
  { field: 'source.container', group: 'Source', label: 'Source container', kind: 'list', options: [
    { value: 'mkv', label: 'MKV' },
    { value: 'mp4', label: 'MP4' },
    { value: 'mov', label: 'MOV' },
    { value: 'webm', label: 'WebM' },
  ] },
  { field: 'media.kind', group: 'What it is', label: 'This is a', kind: 'list', options: [
    { value: 'movie', label: 'Movie' },
    { value: 'series', label: 'Series' },
    { value: 'anime', label: 'Anime' },
  ] },
  { field: 'media.genres', group: 'What it is', label: 'Genre', kind: 'list', options: [
    { value: 'animation', label: 'Animation' },
    { value: 'documentary', label: 'Documentary' },
    { value: 'concert', label: 'Concert' },
    { value: 'action', label: 'Action' },
    { value: 'horror', label: 'Horror' },
    { value: 'comedy', label: 'Comedy' },
    { value: 'drama', label: 'Drama' },
    { value: 'family', label: 'Family' },
  ], help: 'Genres as Radarr or Sonarr have them, lower-cased. Looked up only when a branch asks.' },
  { field: 'media.year', group: 'What it is', label: 'Year', kind: 'number' },
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
    case 'audio.languages':
      return facts.audioExtra?.languages ?? [];
    case 'audio.hasCommentary':
      return facts.audioExtra?.hasCommentary ?? false;
    case 'audio.trackCount':
      return facts.audioExtra?.trackCount ?? 0;
    case 'audio.maxBitrateKbps':
      return facts.audioExtra?.maxBitrateKbps ?? 0;
    case 'video.height':
      return facts.video.height;
    case 'video.width':
      return facts.video.width;
    case 'video.codec':
      return facts.video.codec ? [facts.video.codec] : [];
    case 'video.hdr':
      return facts.video.hdr;
    case 'video.dolbyVision':
      return facts.video.dolbyVision;
    case 'video.bitDepth':
      return facts.video.bitDepth;
    case 'video.frameRate':
      return facts.video.frameRate;
    case 'video.interlaced':
      return facts.video.interlaced;
    case 'subtitles.count':
      return facts.subtitles?.count ?? 0;
    case 'subtitles.languages':
      return facts.subtitles?.languages ?? [];
    case 'subtitles.hasForced':
      return facts.subtitles?.hasForced ?? false;
    case 'subtitles.hasText':
      return facts.subtitles?.hasText ?? false;
    case 'source.durationMinutes':
      return facts.source.durationMinutes;
    case 'source.sizeGB':
      return facts.source.sizeGB;
    case 'source.bitrateMbps':
      return facts.source.bitrateMbps;
    case 'source.container':
      return facts.source.container ? [facts.source.container] : [];
    case 'media.kind':
      return [facts.media.kind];
    case 'media.genres':
      return facts.media.genres;
    case 'media.year':
      return facts.media.year ?? 0;
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

/** A branch with no conditions is unfinished, and one that is switched off is skipped; neither ever matches. */
export function ruleMatches(rule: SmartRule, facts: SourceFacts): boolean {
  if (rule.enabled === false || !rule.when.length) return false;
  return rule.match === 'any' ? rule.when.some((c) => conditionHolds(c, facts)) : rule.when.every((c) => conditionHolds(c, facts));
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
    case 'video.bitrate':
      profile.video.bitrate = Number(a.value);
      break;
    case 'video.hwMode':
      profile.video.hwMode = a.value as 'auto' | 'software';
      break;
    case 'video.extraArgs':
      profile.video.extraArgs = String(a.value);
      break;
    case 'audio.languages':
      profile.audio.languages = asList(a.value);
      break;
    case 'audio.perLanguage':
      profile.audio.perLanguage = a.value as AudioPerLanguage;
      break;
    // the boolean this replaced, kept so a smart profile saved before it existed still decides the same thing
    case 'audio.firstMatchOnly':
      profile.audio.perLanguage = a.value ? 'first' : 'all';
      break;
    case 'subtitles.mode':
      profile.subtitles.mode = a.value as SubtitleMode;
      break;
    case 'subtitles.languages':
      profile.subtitles.languages = asList(a.value);
      break;
    case 'subtitles.burnLanguage':
      profile.subtitles.burnLanguage = String(a.value);
      break;
    case 'subtitles.burnForcedOnly':
      profile.subtitles.burnForcedOnly = Boolean(a.value);
      break;
    case 'subtitles.keepFonts':
      profile.subtitles.keepFonts = Boolean(a.value);
      break;
    case 'output.suffix':
      profile.output.suffix = String(a.value);
      break;
    case 'output.directory':
      profile.output.directory = String(a.value);
      break;
    case 'output.replaceOriginal':
      profile.output.replaceOriginal = Boolean(a.value);
      break;
    case 'output.renameTokens':
      profile.output.renameTokens = Boolean(a.value);
      break;
    case 'output.cleanMetadata':
      profile.output.cleanMetadata = Boolean(a.value);
      break;
    case 'output.notifyArr':
      profile.output.notifyArr = Boolean(a.value);
      break;
  }
}

const asList = (v: SmartAssignment['value']): string[] => (Array.isArray(v) ? v : String(v ?? '').split(/[\s,]+/).filter(Boolean));

/**
 * What this smart profile comes to for one file: its own settings, then every branch that fits, in order. The
 * answer is an ordinary profile, so everything downstream – the ffmpeg command, the size estimate, the output
 * name – works on it without knowing a decision was made.
 */
/** The profile before any branch: what a file that matches nothing is encoded with. */
export function baseProfile(smart: SmartProfile): Profile {
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
  for (const a of smart.base ?? []) assign(profile, a);
  return profile;
}

export function decide(smart: SmartProfile, facts: SourceFacts): SmartDecision {
  const profile = baseProfile(smart);
  const from: SmartDecision['from'] = {};
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
  /** Which heading it sits under in the dropdown. */
  group: 'Audio' | 'Video' | 'Subtitles' | 'Source' | 'What it is' | 'Output';
  kind: 'select' | 'number' | 'boolean' | 'text' | 'languages';
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  unit?: string;
}

/** "HEVC (libx265)" is a fine name in a form and too long for a node: the bracket is the detail, not the name. */
const shortLabel = (label: string) => label.split(' (')[0];

export const SMART_SETTINGS: SmartSettingInfo[] = [
  { path: 'video.encoder', group: 'Video', label: 'Video encoder', kind: 'select', options: Object.entries(VIDEO_ENCODER_INFO).map(([value, v]) => ({ value, label: shortLabel(v.label) })) },
  { path: 'video.quality', group: 'Video', label: 'Video quality (CRF)', kind: 'number', min: 0, max: 63 },
  { path: 'video.preset', group: 'Video', label: 'Video preset', kind: 'select', options: [...new Set(Object.values(VIDEO_ENCODER_INFO).flatMap((v) => v.presets))].map((value) => ({ value, label: value })) },
  { path: 'video.tune', group: 'Video', label: 'Video tune', kind: 'select', options: ['none', 'animation', 'film', 'grain', 'fastdecode', 'zerolatency'].map((value) => ({ value, label: value })) },
  { path: 'video.maxHeight', group: 'Video', label: 'Downscale to at most', kind: 'number', min: 0, max: 4320, unit: 'px' },
  { path: 'video.pixelFormat', group: 'Video', label: 'Pixel format', kind: 'select', options: ['auto', 'yuv420p', 'yuv420p10le', 'p010le', 'nv12'].map((value) => ({ value, label: value })) },
  { path: 'video.hdrPassthrough', group: 'Video', label: 'Keep HDR metadata', kind: 'boolean' },
  { path: 'video.bitrate', group: 'Video', label: 'Video bitrate', kind: 'number', min: 0, max: 200000, unit: 'kbps' },
  { path: 'video.hwMode', group: 'Video', label: 'Hardware encoding', kind: 'select', options: [
    { value: 'auto', label: 'Follow the setting' },
    { value: 'software', label: 'Always on the CPU' },
  ] },
  { path: 'video.extraArgs', group: 'Video', label: 'Extra ffmpeg arguments', kind: 'text' },
  { path: 'audio.encoder', group: 'Audio', label: 'Audio encoder', kind: 'select', options: Object.entries(AUDIO_ENCODER_INFO).map(([value, v]) => ({ value, label: shortLabel(v.label) })) },
  { path: 'audio.bitrate', group: 'Audio', label: 'Audio bitrate', kind: 'number', min: 0, max: 3000, unit: 'kbps' },
  { path: 'audio.channels', group: 'Audio', label: 'Audio channels', kind: 'select', options: [
    { value: '0', label: 'Keep the source layout' },
    { value: '2', label: 'Stereo' },
    { value: '6', label: '5.1' },
    { value: '8', label: '7.1' },
  ] },
  { path: 'audio.languages', group: 'Audio', label: 'Keep audio languages', kind: 'languages' },
  { path: 'audio.perLanguage', group: 'Audio', label: 'Tracks per language', kind: 'select', options: [
    { value: 'all', label: 'Keep them all' },
    { value: 'best', label: 'Best only' },
    { value: 'smallest', label: 'Smallest only' },
    { value: 'first', label: 'First only' },
  ] },
  { path: 'audio.dropCommentary', group: 'Audio', label: 'Drop commentary tracks', kind: 'boolean' },
  { path: 'subtitles.mode', group: 'Subtitles', label: 'Subtitles', kind: 'select', options: [
    { value: 'copy', label: 'Copy' },
    { value: 'copy-text', label: 'Copy text only' },
    { value: 'burn', label: 'Burn in' },
    { value: 'none', label: 'Drop' },
  ] },
  { path: 'subtitles.languages', group: 'Subtitles', label: 'Keep subtitle languages', kind: 'languages' },
  { path: 'subtitles.burnLanguage', group: 'Subtitles', label: 'Burn in which language', kind: 'select', options: [{ value: '', label: 'The first subtitle track' }, ...LANGS] },
  { path: 'subtitles.burnForcedOnly', group: 'Subtitles', label: 'Burn forced subtitles only', kind: 'boolean' },
  { path: 'subtitles.keepFonts', group: 'Subtitles', label: 'Keep font attachments', kind: 'boolean' },
  { path: 'container', group: 'Output', label: 'Container', kind: 'select', options: Object.entries(CONTAINER_INFO).filter(([, v]) => !v.music).map(([value, v]) => ({ value, label: shortLabel(v.label) })) },
  { path: 'output.suffix', group: 'Output', label: 'File name suffix', kind: 'text' },
  { path: 'output.directory', group: 'Output', label: 'Output folder', kind: 'text' },
  { path: 'output.replaceOriginal', group: 'Output', label: 'Replace the original', kind: 'boolean' },
  { path: 'output.renameTokens', group: 'Output', label: 'Rename from the profile tokens', kind: 'boolean' },
  { path: 'output.cleanMetadata', group: 'Output', label: 'Clean metadata', kind: 'boolean' },
  { path: 'output.notifyArr', group: 'Output', label: 'Tell Radarr / Sonarr', kind: 'boolean' },
];

export const settingInfo = (path: SmartSettingPath) => SMART_SETTINGS.find((s) => s.path === path);

export function describeAssignment(a: SmartAssignment): string {
  const info = settingInfo(a.path);
  const label = info?.label ?? a.path;
  if (info?.kind === 'boolean') return `${label}: ${a.value ? 'yes' : 'no'}`;
  if (info?.kind === 'languages') {
    const list = asList(a.value);
    return `${label}: ${list.length ? list.join(', ') : 'all'}`;
  }
  if (info?.kind === 'text') return `${label}: ${a.value || '—'}`;
  const option = info?.options?.find((o) => o.value === String(a.value));
  return `${label}: ${option?.label ?? a.value}${info?.unit ? ` ${info.unit}` : ''}`;
}

/** One line for the job log: what was found, which branches fired, and what the encode ended up being. */
export function explainDecision(smart: SmartProfile, facts: SourceFacts, decision: SmartDecision): string {
  const audio = `${facts.audio.maxChannels}ch ${facts.audio.codecs.join('/') || 'no audio'}${facts.audio.objectBased ? ' (object audio)' : ''}`;
  const where = decision.applied.length
    ? decision.applied.map((a) => `#${a.index + 1} ${a.rule.label || a.rule.when.map(describeCondition).join(a.rule.match === 'any' ? ' or ' : ' and ')}`).join('; ')
    : 'no branch matched';
  const p = decision.profile;
  // a bitrate means nothing for a lossless encoder, so it is not quoted back as if it did
  const lossy = p.audio.encoder !== 'copy' && !AUDIO_ENCODER_INFO[p.audio.encoder]?.lossless;
  const result = `${p.video.encoder}${p.video.encoder !== 'copy' ? ` CRF ${p.video.quality}${p.video.tune !== 'none' ? ` tune ${p.video.tune}` : ''}` : ''} + ${p.audio.encoder}${lossy && p.audio.bitrate ? ` ${p.audio.bitrate}k` : ''}`;
  return `${smart.name}: ${audio}, ${facts.video.height || '?'}p${facts.video.hdr ? ' HDR' : ''} – ${where} → ${result}`;
}
