import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBitmapSubtitle, tesseractLanguage, toSrt } from './ocr.js';

test('the picture subtitle codecs are the ones a disc carries', () => {
  for (const codec_name of ['dvd_subtitle', 'hdmv_pgs_subtitle', 'dvb_subtitle', 'xsub']) assert.ok(isBitmapSubtitle({ codec_name }), codec_name);
  for (const codec_name of ['subrip', 'ass', 'mov_text', 'webvtt']) assert.ok(!isBitmapSubtitle({ codec_name }), codec_name);
});

test('a track language becomes the name Tesseract gives its model', () => {
  // the two ISO 639-2 forms disagree for exactly these, and Tesseract uses /T
  assert.equal(tesseractLanguage('ger'), 'deu');
  assert.equal(tesseractLanguage('fre'), 'fra');
  assert.equal(tesseractLanguage('chi'), 'chi_sim');
  // an untagged track is read as English rather than not read at all
  assert.equal(tesseractLanguage('und'), 'eng');
  // where they agree, it is passed straight through
  assert.equal(tesseractLanguage('eng'), 'eng');
  assert.equal(tesseractLanguage('jpn'), 'jpn');
});

test('cues come out as SRT a player will accept', () => {
  const srt = toSrt([
    { startMs: 500, endMs: 2001, text: 'Hello there, old friend.' },
    { startMs: 3_661_250, endMs: 3_662_000, text: 'Two lines\nat once.' },
  ]);
  assert.equal(
    srt,
    '1\n00:00:00,500 --> 00:00:02,001\nHello there, old friend.\n\n2\n01:01:01,250 --> 01:01:02,000\nTwo lines\nat once.\n',
  );
  assert.equal(toSrt([]), '');
});
