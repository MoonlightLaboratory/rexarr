import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SmartProfile, SmartRule } from '../../../shared/types.js';
import { BUILTIN_SMART_PROFILES } from '../../../shared/presets.js';
import { conditionHolds, decide, describeAssignment, describeCondition, explainDecision, isPassThrough, ruleMatches } from '../../../shared/smart.js';
import { audioCodecName, isObjectAudio, sourceFacts } from './facts.js';
import type { SourceFacts } from '../../../shared/types.js';

/** Discs to try the rules against: one of each case these profiles exist for. */
export const SAMPLE_SOURCES: { name: string; facts: SourceFacts }[] = [
  sample('UHD, TrueHD 7.1 Atmos', {
    audio: { maxChannels: 8, codecs: ['truehd', 'ac3'], objectBased: true, lossless: true, profiles: ['Dolby TrueHD + Dolby Atmos'] },
    audioExtra: { languages: ['eng', 'fre'], hasCommentary: true, trackCount: 4, maxBitrateKbps: 640 },
    video: { height: 2160, width: 3840, codec: 'hevc', hdr: true, dolbyVision: false, bitDepth: 10, frameRate: 23.976, interlaced: false },
    subtitles: { count: 12, languages: ['eng', 'fre', 'ger'], hasForced: true, hasText: false },
    source: { durationMinutes: 130, sizeGB: 58, bitrateMbps: 60, container: 'mkv' },
    media: { kind: 'movie', genres: ['action'], year: 2019 },
  }),
  sample('UHD, DTS-HD MA 7.1 + DTS:X', {
    audio: { maxChannels: 8, codecs: ['dts-hd-ma'], objectBased: true, lossless: true, profiles: ['DTS-HD MA + DTS:X'] },
    audioExtra: { languages: ['eng'], hasCommentary: false, trackCount: 2, maxBitrateKbps: 0 },
    video: { height: 2160, width: 3840, codec: 'hevc', hdr: true, dolbyVision: true, bitDepth: 10, frameRate: 24, interlaced: false },
    subtitles: { count: 6, languages: ['eng', 'spa'], hasForced: true, hasText: false },
    source: { durationMinutes: 115, sizeGB: 54, bitrateMbps: 62, container: 'mkv' },
    media: { kind: 'movie', genres: ['science fiction'], year: 2021 },
  }),
  sample('Blu-ray, DTS-HD MA 5.1', {
    audio: { maxChannels: 6, codecs: ['dts-hd-ma', 'ac3'], objectBased: false, lossless: true, profiles: ['DTS-HD MA'] },
    audioExtra: { languages: ['eng', 'jpn'], hasCommentary: true, trackCount: 3, maxBitrateKbps: 448 },
    video: { height: 1080, width: 1920, codec: 'h264', hdr: false, dolbyVision: false, bitDepth: 8, frameRate: 23.976, interlaced: false },
    subtitles: { count: 4, languages: ['eng'], hasForced: false, hasText: false },
    source: { durationMinutes: 105, sizeGB: 24, bitrateMbps: 30, container: 'mkv' },
    media: { kind: 'movie', genres: ['drama'], year: 2009 },
  }),
  sample('Blu-ray, TrueHD 2.0 only', {
    audio: { maxChannels: 2, codecs: ['truehd'], objectBased: false, lossless: true, profiles: ['Dolby TrueHD'] },
    audioExtra: { languages: ['eng'], hasCommentary: false, trackCount: 1, maxBitrateKbps: 0 },
    video: { height: 1080, width: 1920, codec: 'h264', hdr: false, dolbyVision: false, bitDepth: 8, frameRate: 23.976, interlaced: false },
    subtitles: { count: 2, languages: ['eng'], hasForced: false, hasText: false },
    source: { durationMinutes: 96, sizeGB: 18, bitrateMbps: 25, container: 'mkv' },
    media: { kind: 'movie', genres: ['documentary'], year: 1974 },
  }),
  sample('DVD, AC-3 2.0, interlaced', {
    audio: { maxChannels: 2, codecs: ['ac3'], objectBased: false, lossless: false, profiles: [] },
    audioExtra: { languages: ['eng'], hasCommentary: false, trackCount: 1, maxBitrateKbps: 192 },
    video: { height: 576, width: 720, codec: 'mpeg2video', hdr: false, dolbyVision: false, bitDepth: 8, frameRate: 25, interlaced: true },
    subtitles: { count: 3, languages: ['eng', 'dut'], hasForced: false, hasText: false },
    source: { durationMinutes: 92, sizeGB: 4, bitrateMbps: 6, container: 'mkv' },
    media: { kind: 'movie', genres: ['comedy'], year: 1988 },
  }),
  sample('Anime episode, AAC 5.1', {
    audio: { maxChannels: 6, codecs: ['aac'], objectBased: false, lossless: false, profiles: [] },
    audioExtra: { languages: ['jpn', 'eng'], hasCommentary: false, trackCount: 2, maxBitrateKbps: 320 },
    video: { height: 1080, width: 1920, codec: 'h264', hdr: false, dolbyVision: false, bitDepth: 8, frameRate: 23.976, interlaced: false },
    subtitles: { count: 2, languages: ['eng'], hasForced: false, hasText: true },
    source: { durationMinutes: 24, sizeGB: 1.4, bitrateMbps: 7, container: 'mkv' },
    media: { kind: 'anime', genres: ['animation'], year: 2023 },
  }),
];

function sample(name: string, facts: SourceFacts): { name: string; facts: SourceFacts } {
  return { name, facts };
}


const probeOf = (audio: { codec_name: string; profile?: string; channels?: number }[], video?: { codec_name: string; height: number }) => ({
  audio: audio.map((a, index) => ({ index, codec_type: 'audio' as const, ...a })),
  video: video ? { index: 99, codec_type: 'video' as const, ...video } : undefined,
  durationSeconds: 7200,
  sizeBytes: 50e9,
  bitRate: 55e6,
  isHdr: true,
  isDolbyVision: false,
  formatName: 'matroska,webm',
});

test('FFmpeg profile strings are where object audio is named', () => {
  // the four FFmpeg can report; nothing else in the file says a track carries objects
  assert.equal(isObjectAudio({ profile: 'Dolby TrueHD + Dolby Atmos' }), true);
  assert.equal(isObjectAudio({ profile: 'Dolby Digital Plus + Dolby Atmos' }), true);
  assert.equal(isObjectAudio({ profile: 'DTS-HD MA + DTS:X' }), true);
  assert.equal(isObjectAudio({ profile: 'DTS-HD MA + DTS:X IMAX' }), true);
  // a 7.1 TrueHD track is not Atmos, and an FFmpeg too old to say so reports no profile at all
  assert.equal(isObjectAudio({ profile: 'Dolby TrueHD' }), false);
  assert.equal(isObjectAudio({}), false);
  // DTS is one codec with several profiles, and they are not the same thing
  assert.equal(audioCodecName({ codec_name: 'dts', profile: 'DTS-HD MA' }), 'dts-hd-ma');
  assert.equal(audioCodecName({ codec_name: 'dts', profile: 'DTS-HD MA + DTS:X' }), 'dts-hd-ma');
  assert.equal(audioCodecName({ codec_name: 'dts', profile: 'DTS-HD HRA' }), 'dts-hd-hra');
  assert.equal(audioCodecName({ codec_name: 'dts' }), 'dts');
  assert.equal(audioCodecName({ codec_name: 'pcm_bluray' }), 'pcm');
  assert.equal(audioCodecName({ codec_name: 'truehd', profile: 'Dolby TrueHD + Dolby Atmos' }), 'truehd');
});

test('what the rules see of a file', () => {
  const facts = sourceFacts(probeOf([
    { codec_name: 'truehd', profile: 'Dolby TrueHD + Dolby Atmos', channels: 8 },
    { codec_name: 'ac3', channels: 6 },
    { codec_name: 'ac3', channels: 2 },
  ], { codec_name: 'hevc', height: 2160 }));
  assert.deepEqual(facts.audio.codecs, ['truehd', 'ac3']);
  assert.equal(facts.audio.maxChannels, 8);
  assert.equal(facts.audio.objectBased, true);
  assert.equal(facts.audio.lossless, true);
  assert.deepEqual([facts.video.height, facts.video.codec, facts.video.hdr], [2160, 'hevc', true]);
  assert.deepEqual([facts.source.durationMinutes, facts.source.sizeGB, facts.source.bitrateMbps], [120, 50, 55]);

  // lossy only, and a commentary track does not drag the channel count down
  const lossy = sourceFacts(probeOf([{ codec_name: 'eac3', channels: 6 }, { codec_name: 'aac', channels: 2 }]));
  assert.equal(lossy.audio.lossless, false);
  assert.equal(lossy.audio.maxChannels, 6);
  // no audio at all is not a crash
  assert.deepEqual(sourceFacts(probeOf([])).audio, { maxChannels: 0, codecs: [], objectBased: false, lossless: false, profiles: [] });
});

test('conditions over numbers, lists and flags', () => {
  const facts = SAMPLE_SOURCES.find((s) => s.name.includes('DTS-HD MA 5.1'))!.facts;
  assert.equal(conditionHolds({ field: 'audio.maxChannels', op: 'atLeast', number: 6 }, facts), true);
  assert.equal(conditionHolds({ field: 'audio.maxChannels', op: 'atMost', number: 2 }, facts), false);
  assert.equal(conditionHolds({ field: 'audio.codecs', op: 'anyOf', list: ['dts-hd-ma', 'truehd'] }, facts), true);
  assert.equal(conditionHolds({ field: 'audio.codecs', op: 'noneOf', list: ['truehd'] }, facts), true);
  assert.equal(conditionHolds({ field: 'audio.objectBased', op: 'isTrue' }, facts), false);
  assert.equal(conditionHolds({ field: 'audio.objectBased', op: 'isFalse' }, facts), true);
  assert.equal(conditionHolds({ field: 'video.codec', op: 'anyOf', list: ['h264'] }, facts), true);
  // a rule with no conditions is half-written, and must not catch everything
  assert.equal(ruleMatches({ id: 'x', when: [], then: { kind: 'keep' } }, facts), false);
  // every condition has to hold
  assert.equal(ruleMatches({ id: 'x', when: [{ field: 'audio.lossless', op: 'isTrue' }, { field: 'audio.maxChannels', op: 'atMost', number: 2 }], then: { kind: 'keep' } }, facts), false);
});

test('the built-in smart profiles encode what their names say', () => {
  const [lossless, animation] = BUILTIN_SMART_PROFILES;
  const of = (name: string) => SAMPLE_SOURCES.find((s) => s.name === name)!.facts;

  // lossless stereo is the only thing that becomes FLAC; everything else is copied through
  const stereo = decide(lossless, of('Blu-ray, TrueHD 2.0 only'));
  assert.deepEqual([stereo.profile.video.encoder, stereo.profile.audio.encoder], ['copy', 'flac']);
  assert.equal(stereo.profile.audio.channels, 0, 'the source layout is kept');
  assert.deepEqual(stereo.applied.map((a) => a.rule.id), ['stereo']);

  for (const disc of ['Blu-ray, DTS-HD MA 5.1', 'UHD, TrueHD 7.1 Atmos', 'DVD, AC-3 2.0, interlaced']) {
    const d = decide(lossless, of(disc));
    assert.deepEqual([d.profile.video.encoder, d.profile.audio.encoder], ['copy', 'copy'], disc);
    assert.equal(d.applied.length, 0, disc);
    // nothing would be re-encoded, so there is no point running ffmpeg over it at all
    assert.equal(isPassThrough(d.profile, 'mkv'), true, disc);
  }
  assert.equal(isPassThrough(stereo.profile, 'mkv'), false, 'the audio is being encoded');

  // animation gets the tune and a lower CRF; film keeps the defaults
  const film = decide(animation, of('Blu-ray, DTS-HD MA 5.1'));
  assert.deepEqual([film.profile.video.encoder, film.profile.video.quality, film.profile.video.tune], ['libx265', 20, 'none']);

  const cartoon = decide(animation, { ...of('Blu-ray, DTS-HD MA 5.1'), media: { kind: 'movie', genres: ['animation', 'family'], year: 2004 } });
  assert.deepEqual([cartoon.profile.video.quality, cartoon.profile.video.tune], [18, 'animation']);
  assert.deepEqual(cartoon.applied.map((a) => a.rule.id), ['animation']);

  // a series Sonarr calls anime takes the anime branch, 10-bit and all
  const anime = decide(animation, of('Anime episode, AAC 5.1'));
  assert.deepEqual([anime.profile.video.quality, anime.profile.video.tune, anime.profile.video.pixelFormat], [18, 'animation', 'yuv420p10le']);
  // both the genre branch and the anime branch fit, and they agree
  assert.deepEqual(anime.applied.map((a) => a.rule.id), ['animation', 'anime']);
});

test('a later branch wins where two touch the same setting, and each one says what it set', () => {
  const smart: SmartProfile = {
    id: 's', name: 'Ladder', description: '', builtin: false, mediaType: 'any', container: 'mkv',
    base: [{ path: 'video.encoder', value: 'libx265' }, { path: 'video.quality', value: 22 }],
    rules: [
      { id: 'hd', when: [{ field: 'video.height', op: 'atLeast', number: 1080 }], set: [{ path: 'video.quality', value: 20 }] },
      { id: 'uhd', when: [{ field: 'video.height', op: 'atLeast', number: 2160 }], set: [{ path: 'video.quality', value: 18 }, { path: 'video.pixelFormat', value: 'yuv420p10le' }] },
    ],
    createdAt: '', updatedAt: '',
  };
  const at = (height: number) => ({ ...SAMPLE_SOURCES[0].facts, video: { ...SAMPLE_SOURCES[0].facts.video, height } });

  assert.equal(decide(smart, at(720)).profile.video.quality, 22, 'neither branch fits, so the base stands');
  assert.equal(decide(smart, at(1080)).profile.video.quality, 20);
  const uhd = decide(smart, at(2160));
  // both fit; the lower one down wins the setting they share
  assert.deepEqual(uhd.applied.map((a) => a.rule.id), ['hd', 'uhd']);
  assert.equal(uhd.profile.video.quality, 18);
  assert.deepEqual([uhd.from['video.quality'], uhd.from['video.pixelFormat']], [1, 1]);
  // what it resolves to is an ordinary profile, which is what the encoder is handed
  assert.equal(uhd.profile.container, 'mkv');
  assert.equal(uhd.profile.name, 'Ladder');
});

test('a decision explains itself in one line', () => {
  const facts = SAMPLE_SOURCES.find((s) => s.name === 'UHD, TrueHD 7.1 Atmos')!.facts;
  const smart = BUILTIN_SMART_PROFILES[1];
  const line = explainDecision(smart, facts, decide(smart, facts));
  assert.match(line, /8ch truehd\/ac3 \(object audio\)/);
  assert.match(line, /2160p HDR/);
  assert.match(line, /libx265 CRF 20/);
  assert.equal(describeCondition({ field: 'audio.maxChannels', op: 'atMost', number: 2 }), 'Audio channels is at most 2');
  assert.equal(describeCondition({ field: 'media.genres', op: 'anyOf', list: ['animation'] }), 'Genre is any of Animation');
  assert.equal(describeAssignment({ path: 'video.tune', value: 'animation' }), 'Video tune: animation');
  assert.equal(describeAssignment({ path: 'audio.channels', value: 0 }), 'Audio channels: Keep the source layout');
});

test('a branch can want any of its conditions, be named, or be switched off', () => {
  const dvd = SAMPLE_SOURCES.find((s) => s.name.startsWith('DVD'))!.facts;
  const uhd = SAMPLE_SOURCES.find((s) => s.name.startsWith('UHD, TrueHD'))!.facts;
  const rule = (extra: Partial<SmartRule>): SmartRule => ({
    id: 'r',
    when: [
      { field: 'video.interlaced', op: 'isTrue' },
      { field: 'video.height', op: 'atLeast', number: 2160 },
    ],
    set: [{ path: 'video.quality', value: 19 }],
    ...extra,
  });
  // all of: a DVD is interlaced but not 2160p, so neither disc fits
  assert.equal(ruleMatches(rule({}), dvd), false);
  assert.equal(ruleMatches(rule({}), uhd), false);
  // any of: each disc satisfies one of the two
  assert.equal(ruleMatches(rule({ match: 'any' }), dvd), true);
  assert.equal(ruleMatches(rule({ match: 'any' }), uhd), true);
  // switched off stays off whatever it would have matched
  assert.equal(ruleMatches(rule({ match: 'any', enabled: false }), dvd), false);
  // the name is what the job log calls it
  const smart: SmartProfile = { id: 's', name: 'N', description: '', builtin: false, mediaType: 'any', container: 'mkv', base: [], rules: [rule({ match: 'any', label: 'Odd sources' })], createdAt: '', updatedAt: '' };
  assert.match(explainDecision(smart, dvd, decide(smart, dvd)), /#1 Odd sources/);
});

test('the wider facts a branch can ask about', () => {
  const info = {
    audio: [
      { index: 0, codec_type: 'audio' as const, codec_name: 'dts', profile: 'DTS-HD MA', channels: 6, bit_rate: '3000000', tags: { language: 'eng' } },
      { index: 1, codec_type: 'audio' as const, codec_name: 'ac3', channels: 2, tags: { language: 'jpn', title: "Director's commentary" } },
    ],
    video: { index: 2, codec_type: 'video' as const, codec_name: 'h264', width: 1920, height: 1080, pix_fmt: 'yuv420p10le', field_order: 'tt' },
    subtitles: [
      { index: 3, codec_type: 'subtitle' as const, codec_name: 'subrip', tags: { language: 'eng' }, disposition: { forced: 1 } },
      { index: 4, codec_type: 'subtitle' as const, codec_name: 'hdmv_pgs_subtitle', tags: { language: 'jpn' } },
    ],
    durationSeconds: 3600,
    sizeBytes: 10e9,
    bitRate: 22e6,
    isHdr: false,
    isDolbyVision: false,
    formatName: 'matroska,webm',
    frameRate: 23.976023,
  };
  const facts = sourceFacts(info, { kind: 'series', genres: ['animation'], year: 2012 });
  assert.deepEqual(facts.audioExtra, { languages: ['eng', 'jpn'], hasCommentary: true, trackCount: 2, maxBitrateKbps: 3000 });
  assert.deepEqual([facts.video.width, facts.video.bitDepth, facts.video.frameRate, facts.video.interlaced], [1920, 10, 23.976, true]);
  assert.deepEqual(facts.subtitles, { count: 2, languages: ['eng', 'jpn'], hasForced: true, hasText: true });
  assert.equal(facts.source.container, 'mkv');

  // and reading each of them back through a condition
  assert.equal(conditionHolds({ field: 'audio.languages', op: 'anyOf', list: ['jpn'] }, facts), true);
  assert.equal(conditionHolds({ field: 'audio.languages', op: 'noneOf', list: ['fre'] }, facts), true);
  assert.equal(conditionHolds({ field: 'audio.hasCommentary', op: 'isTrue' }, facts), true);
  assert.equal(conditionHolds({ field: 'video.bitDepth', op: 'atLeast', number: 10 }, facts), true);
  assert.equal(conditionHolds({ field: 'video.interlaced', op: 'isTrue' }, facts), true);
  assert.equal(conditionHolds({ field: 'subtitles.hasForced', op: 'isTrue' }, facts), true);
  assert.equal(conditionHolds({ field: 'subtitles.count', op: 'atLeast', number: 2 }, facts), true);
  assert.equal(conditionHolds({ field: 'source.container', op: 'anyOf', list: ['mkv'] }, facts), true);
  assert.equal(conditionHolds({ field: 'media.year', op: 'atMost', number: 2015 }, facts), true);
  // an 8-bit source reports 8, not nothing
  assert.equal(sourceFacts({ ...info, video: { ...info.video, pix_fmt: 'yuv420p' } }).video.bitDepth, 8);
});

test('the wider settings a branch can change', () => {
  const smart: SmartProfile = {
    id: 's', name: 'Everything', description: '', builtin: false, mediaType: 'any', container: 'mkv',
    base: [{ path: 'video.encoder', value: 'libx265' }],
    rules: [
      {
        id: 'r',
        when: [{ field: 'video.height', op: 'atLeast', number: 1 }],
        set: [
          { path: 'audio.languages', value: ['eng', 'jpn'] },
          { path: 'audio.firstMatchOnly', value: true },
          { path: 'subtitles.languages', value: ['eng'] },
          { path: 'subtitles.burnForcedOnly', value: true },
          { path: 'video.extraArgs', value: '-x265-params aq-mode=3' },
          { path: 'video.hwMode', value: 'software' },
          { path: 'output.suffix', value: ' [rexarr]' },
          { path: 'output.replaceOriginal', value: true },
        ],
      },
    ],
    createdAt: '', updatedAt: '',
  };
  const { profile } = decide(smart, SAMPLE_SOURCES[0].facts);
  assert.deepEqual(profile.audio.languages, ['eng', 'jpn']);
  assert.equal(profile.audio.firstMatchOnly, true);
  assert.deepEqual(profile.subtitles.languages, ['eng']);
  assert.equal(profile.subtitles.burnForcedOnly, true);
  assert.equal(profile.video.extraArgs, '-x265-params aq-mode=3');
  assert.equal(profile.video.hwMode, 'software');
  assert.deepEqual([profile.output.suffix, profile.output.replaceOriginal], [' [rexarr]', true]);
  // a language list typed as text is taken apart the same way
  const typed = decide({ ...smart, rules: [{ ...smart.rules[0], set: [{ path: 'audio.languages', value: 'eng, jpn fre' }] }] }, SAMPLE_SOURCES[0].facts);
  assert.deepEqual(typed.profile.audio.languages, ['eng', 'jpn', 'fre']);
  assert.equal(describeAssignment({ path: 'audio.languages', value: ['eng', 'jpn'] }), 'Keep audio languages: eng, jpn');
  assert.equal(describeAssignment({ path: 'audio.languages', value: [] }), 'Keep audio languages: all');
});
