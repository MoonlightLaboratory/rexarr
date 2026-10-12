/**
 * The rules engine behind smart profiles. Pure: the server runs it on what FFprobe found, and the editor runs
 * the same code on made-up discs so a rule can be tried before it is saved.
 */
import type { Profile, SmartCondition, SmartField, SmartOperator, SmartOutcome, SmartProfile, SmartRule, SourceFacts } from './types.js';

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
  /** Index of the rule that decided, or -1 for the fallback. */
  ruleIndex: number;
  rule?: SmartRule;
  outcome: SmartOutcome;
}

export function decide(smart: SmartProfile, facts: SourceFacts): SmartDecision {
  const ruleIndex = smart.rules.findIndex((r) => ruleMatches(r, facts));
  if (ruleIndex < 0) return { ruleIndex: -1, outcome: smart.otherwise };
  return { ruleIndex, rule: smart.rules[ruleIndex], outcome: smart.rules[ruleIndex].then };
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

export function describeOutcome(outcome: SmartOutcome, profileName?: (id: string) => string | undefined): string {
  if (outcome.kind === 'keep') return 'Leave the file as it is';
  return profileName?.(outcome.profileId) ?? outcome.profileId;
}

/** One line for the job log: what was found, which rule caught it, and what happens now. */
export function explainDecision(smart: SmartProfile, facts: SourceFacts, decision: SmartDecision, profileName?: (id: string) => string | undefined): string {
  const audio = `${facts.audio.maxChannels}ch ${facts.audio.codecs.join('/') || 'no audio'}${facts.audio.objectBased ? ' (object audio)' : ''}`;
  const why = decision.rule ? decision.rule.when.map(describeCondition).join(' and ') : 'nothing matched';
  return `${smart.name}: ${audio}, ${facts.video.height || '?'}p${facts.video.hdr ? ' HDR' : ''} – ${why} → ${describeOutcome(decision.outcome, profileName)}`;
}

/** Profiles a smart profile points at, so the UI can warn about one that was deleted. */
export function referencedProfileIds(smart: SmartProfile): string[] {
  const ids = [...smart.rules.map((r) => r.then), smart.otherwise].filter((o): o is { kind: 'profile'; profileId: string } => o.kind === 'profile').map((o) => o.profileId);
  return [...new Set(ids)];
}

export function missingProfiles(smart: SmartProfile, profiles: Pick<Profile, 'id'>[]): string[] {
  return referencedProfileIds(smart).filter((id) => !profiles.some((p) => p.id === id));
}

// ---------------------------------------------------------------- trying one out

/** Discs to try a rule against in the editor, covering the cases these rules exist for. */
export const SAMPLE_SOURCES: { name: string; facts: SourceFacts }[] = [
  { name: 'UHD, TrueHD 7.1 Atmos', facts: { audio: { maxChannels: 8, codecs: ['truehd', 'ac3'], objectBased: true, lossless: true, profiles: ['Dolby TrueHD + Dolby Atmos'] }, video: { height: 2160, codec: 'hevc', hdr: true, dolbyVision: false }, source: { durationMinutes: 130, sizeGB: 58, bitrateMbps: 60 } } },
  { name: 'UHD, DTS-HD MA 7.1 + DTS:X', facts: { audio: { maxChannels: 8, codecs: ['dts-hd-ma'], objectBased: true, lossless: true, profiles: ['DTS-HD MA + DTS:X'] }, video: { height: 2160, codec: 'hevc', hdr: true, dolbyVision: true }, source: { durationMinutes: 115, sizeGB: 54, bitrateMbps: 62 } } },
  { name: 'Blu-ray, DTS-HD MA 5.1', facts: { audio: { maxChannels: 6, codecs: ['dts-hd-ma', 'ac3'], objectBased: false, lossless: true, profiles: ['DTS-HD MA'] }, video: { height: 1080, codec: 'h264', hdr: false, dolbyVision: false }, source: { durationMinutes: 105, sizeGB: 24, bitrateMbps: 30 } } },
  { name: 'Blu-ray, TrueHD 2.0 only', facts: { audio: { maxChannels: 2, codecs: ['truehd'], objectBased: false, lossless: true, profiles: ['Dolby TrueHD'] }, video: { height: 1080, codec: 'h264', hdr: false, dolbyVision: false }, source: { durationMinutes: 96, sizeGB: 18, bitrateMbps: 25 } } },
  { name: 'DVD, AC-3 2.0', facts: { audio: { maxChannels: 2, codecs: ['ac3'], objectBased: false, lossless: false, profiles: [] }, video: { height: 576, codec: 'mpeg2video', hdr: false, dolbyVision: false }, source: { durationMinutes: 92, sizeGB: 4, bitrateMbps: 6 } } },
  { name: 'Episode, AAC 5.1', facts: { audio: { maxChannels: 6, codecs: ['aac'], objectBased: false, lossless: false, profiles: [] }, video: { height: 1080, codec: 'h264', hdr: false, dolbyVision: false }, source: { durationMinutes: 42, sizeGB: 2, bitrateMbps: 7 } } },
];
