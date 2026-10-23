import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cropdetectArgs, decideCrop, parseCropLine, parseCropOutput, samplePoints } from './crop.js';

const hd = { width: 1920, height: 1080 };
const box = (w: number, h: number, x = 0, y = 0) => ({ width: w, height: h, x, y });

test('cropdetect’s own output is read back', () => {
  assert.deepEqual(parseCropLine('[Parsed_cropdetect_1 @ 0x7f] x1:0 x2:1919 y1:140 y2:939 w:1920 h:800 x:0 y:140 crop=1920:800:0:140'), box(1920, 800, 0, 140));
  assert.equal(parseCropLine('frame=  100 fps=0.0 q=-0.0 size=N/A time=00:00:04.00'), null);
  // a crop with a negative offset is cropdetect saying it does not know
  assert.equal(parseCropLine('crop=1920:800:-1:140'), null);
  assert.equal(parseCropOutput('noise\ncrop=1920:800:0:140\nmore\ncrop=1920:802:0:139\n').length, 2);
});

test('letterboxing is cropped when the samples agree', () => {
  const d = decideCrop([box(1920, 800, 0, 140), box(1920, 800, 0, 140), box(1920, 802, 0, 139), box(1920, 800, 0, 140)], hd);
  assert.deepEqual(d.crop, box(1920, 800, 0, 140));
  assert.match(d.reason, /280px top and bottom/);
});

test('a picture that changes shape is left alone', () => {
  // an IMAX sequence: most of the film is 2.39:1 and some of it is not. Cropping to the common answer would cut
  // into the taller parts, which is the damage nobody notices until that scene arrives.
  const mixed = [box(1920, 800, 0, 140), box(1920, 800, 0, 140), box(1920, 1080), box(1920, 1080), box(1920, 800, 0, 140)];
  const d = decideCrop(mixed, hd);
  assert.equal(d.crop, undefined);
  assert.match(d.reason, /changes shape/);
});

test('a few pixels are not letterboxing', () => {
  const d = decideCrop([box(1920, 1076, 0, 2), box(1920, 1076, 0, 2), box(1920, 1076, 0, 2)], hd);
  assert.equal(d.crop, undefined);
  assert.match(d.reason, /nothing .*worth removing|no letterboxing/i);
});

test('a crop is always even, because 4:2:0 cannot do otherwise', () => {
  const d = decideCrop([box(1919, 801, 1, 139), box(1919, 801, 1, 139), box(1919, 801, 1, 139)], hd);
  assert.equal(d.crop!.width % 2, 0);
  assert.equal(d.crop!.height % 2, 0);
  assert.equal(d.crop!.x % 2, 0);
  assert.equal(d.crop!.y % 2, 0);
});

test('too little to go on is not a decision', () => {
  assert.equal(decideCrop([], hd).crop, undefined);
  assert.equal(decideCrop([box(1920, 800, 0, 140)], hd).crop, undefined, 'one sample is a guess, not a measurement');
  // and a measurement larger than the source is nonsense
  assert.equal(decideCrop([box(3840, 2160), box(3840, 2160), box(3840, 2160)], hd).crop, undefined);
});

test('samples are taken across the file, not from the credits', () => {
  const p = samplePoints(3600, 5);
  assert.equal(p.length, 5);
  assert.ok(p[0] >= 180, 'the first sample skips the logos');
  assert.ok(p[p.length - 1] <= 3240, 'the last sample skips the credits');
  assert.deepEqual([...p].sort((a, b) => a - b), p, 'in order');
  // a short file is not worth slicing up
  assert.deepEqual(samplePoints(20), [0]);
});

test('the detector is pointed at one span of the file', () => {
  const a = cropdetectArgs('/media/film.mkv', 300, 8);
  assert.deepEqual(a.slice(a.indexOf('-ss'), a.indexOf('-ss') + 2), ['-ss', '300']);
  assert.ok(a.includes('cropdetect=limit=24:round=2:reset=0') || a.some((x) => x.includes('cropdetect')));
  assert.equal(a[a.length - 1], '-');
});
