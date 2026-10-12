import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SmartProfile } from '../../../shared/types.js';
import { BUILTIN_SMART_PROFILES } from '../../../shared/presets.js';
import { conditionHolds, decide, describeCondition, explainDecision, missingProfiles, ruleMatches, SAMPLE_SOURCES } from '../../../shared/smart.js';
import { audioCodecName, isObjectAudio, sourceFacts } from './facts.js';

const probeOf = (audio: { codec_name: string; profile?: string; channels?: number }[], video?: { codec_name: string; height: number }) => ({
  audio: audio.map((a, index) => ({ index, codec_type: 'audio' as const, ...a })),
  video: video ? { index: 99, codec_type: 'video' as const, ...video } : undefined,
  durationSeconds: 7200,
  sizeBytes: 50e9,
  bitRate: 55e6,
  isHdr: true,
  isDolbyVision: false,
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

test('the built-in smart profiles do what their names say', () => {
  const [stereoToFlac, keepObject] = BUILTIN_SMART_PROFILES;
  const of = (name: string) => SAMPLE_SOURCES.find((s) => s.name === name)!.facts;

  // lossless stereo is the only thing that becomes FLAC; surround is left alone
  assert.deepEqual(decide(stereoToFlac, of('Blu-ray, TrueHD 2.0 only')).outcome, { kind: 'profile', profileId: 'builtin-remux-flac' });
  assert.deepEqual(decide(stereoToFlac, of('Blu-ray, DTS-HD MA 5.1')).outcome, { kind: 'keep' });
  assert.deepEqual(decide(stereoToFlac, of('UHD, TrueHD 7.1 Atmos')).outcome, { kind: 'keep' });
  // a lossy stereo track is not worth re-encoding either
  assert.deepEqual(decide(stereoToFlac, of('DVD, AC-3 2.0')).outcome, { kind: 'keep' });

  // objects cannot survive an encode, so those discs are kept and everything else goes to FLAC
  assert.deepEqual(decide(keepObject, of('UHD, TrueHD 7.1 Atmos')).outcome, { kind: 'keep' });
  assert.deepEqual(decide(keepObject, of('UHD, DTS-HD MA 7.1 + DTS:X')).outcome, { kind: 'keep' });
  assert.deepEqual(decide(keepObject, of('Blu-ray, DTS-HD MA 5.1')).outcome, { kind: 'profile', profileId: 'builtin-remux-flac' });
  assert.deepEqual(decide(keepObject, of('Episode, AAC 5.1')).outcome, { kind: 'profile', profileId: 'builtin-remux-flac' });

  // both point at a profile that exists
  assert.deepEqual(missingProfiles(keepObject, [{ id: 'builtin-remux-flac' }]), []);
  assert.deepEqual(missingProfiles(keepObject, [{ id: 'something-else' }]), ['builtin-remux-flac']);
});

test('the first rule that matches decides, and the fallback catches the rest', () => {
  const smart: SmartProfile = {
    id: 's', name: 'Ladder', description: '', builtin: false, mediaType: 'any',
    rules: [
      { id: 'a', when: [{ field: 'video.height', op: 'atLeast', number: 2160 }], then: { kind: 'profile', profileId: 'uhd' } },
      { id: 'b', when: [{ field: 'video.height', op: 'atLeast', number: 1080 }], then: { kind: 'profile', profileId: 'hd' } },
    ],
    otherwise: { kind: 'profile', profileId: 'sd' },
    createdAt: '', updatedAt: '',
  };
  const at = (height: number) => ({ ...SAMPLE_SOURCES[0].facts, video: { ...SAMPLE_SOURCES[0].facts.video, height } });
  assert.equal(decide(smart, at(2160)).ruleIndex, 0);
  assert.equal(decide(smart, at(1080)).ruleIndex, 1);
  assert.deepEqual(decide(smart, at(576)), { ruleIndex: -1, outcome: { kind: 'profile', profileId: 'sd' } });
});

test('a decision explains itself in one line', () => {
  const facts = SAMPLE_SOURCES.find((s) => s.name === 'UHD, TrueHD 7.1 Atmos')!.facts;
  const smart = BUILTIN_SMART_PROFILES[1];
  const line = explainDecision(smart, facts, decide(smart, facts), (id) => (id === 'builtin-remux-flac' ? 'Remux · Keep video, FLAC audio' : undefined));
  assert.match(line, /8ch truehd\/ac3 \(object audio\)/);
  assert.match(line, /2160p HDR/);
  assert.match(line, /Leave the file as it is$/);
  assert.equal(describeCondition({ field: 'audio.maxChannels', op: 'atMost', number: 2 }), 'Audio channels is at most 2');
  assert.equal(describeCondition({ field: 'audio.codecs', op: 'anyOf', list: ['truehd', 'dts-hd-ma'] }), 'Audio codec is any of TrueHD, DTS-HD MA');
  assert.equal(describeCondition({ field: 'audio.objectBased', op: 'isFalse' }), 'no object audio (atmos / dts:x)');
});
