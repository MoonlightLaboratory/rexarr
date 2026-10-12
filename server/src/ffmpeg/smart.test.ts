import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SmartProfile } from '../../../shared/types.js';
import { BUILTIN_SMART_PROFILES } from '../../../shared/presets.js';
import { conditionHolds, decide, describeAssignment, describeCondition, explainDecision, isPassThrough, ruleMatches, SAMPLE_SOURCES } from '../../../shared/smart.js';
import { audioCodecName, isObjectAudio, sourceFacts } from './facts.js';

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

  for (const disc of ['Blu-ray, DTS-HD MA 5.1', 'UHD, TrueHD 7.1 Atmos', 'DVD, AC-3 2.0']) {
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

  const cartoon = decide(animation, { ...of('Blu-ray, DTS-HD MA 5.1'), media: { kind: 'movie', genres: ['animation', 'family'] } });
  assert.deepEqual([cartoon.profile.video.quality, cartoon.profile.video.tune], [18, 'animation']);
  assert.deepEqual(cartoon.applied.map((a) => a.rule.id), ['animation']);

  // a series Sonarr calls anime takes the anime branch, 10-bit and all
  const anime = decide(animation, { ...of('Episode, AAC 5.1'), media: { kind: 'anime', genres: ['animation'] } });
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
