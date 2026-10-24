import { test } from 'node:test';
import assert from 'node:assert/strict';
import { titleFromName, versionLabel, versionPath } from './versions.js';
import type { EncodeDescription } from './naming.js';

const d = (o: Partial<EncodeDescription>): EncodeDescription => ({ resolution: '1080p', videoCodec: 'x265', videoCodecName: 'HEVC', videoCopied: false, tenBit: true, hdr: false, ...o }) as EncodeDescription;

test('the title is recovered from a name with the encode written all over it', () => {
  // a year is where a title reliably ends
  assert.equal(titleFromName('Blade Runner 2049 (2017) Bluray-2160p Remux HDR'), 'Blade Runner 2049 (2017)');
  assert.equal(titleFromName('Arrival (2016) Bluray-1080p'), 'Arrival (2016)');
  // scene names use dots and still have a year
  assert.equal(titleFromName('Dune.Part.Two.2024.2160p.UHD.BluRay.x265-GROUP'), 'Dune Part Two 2024');

  // without a year, the tokens go and what is left is the title
  assert.equal(titleFromName('Some Film 1080p x264 DTS'), 'Some Film');
  assert.equal(titleFromName('Spirited Away BluRay 1080p HEVC'), 'Spirited Away');
});

test('a name that is nothing but tokens is left alone', () => {
  // stripping to nothing would file the encode under a heading of its own, which is the opposite of the point
  assert.equal(titleFromName('1080p x265'), '1080p x265');
  assert.equal(titleFromName(''), '');
});

test('the version is what a person would call it', () => {
  assert.equal(versionLabel(d({ resolution: '2160p', videoCodec: 'x265' })), '2160p HEVC');
  assert.equal(versionLabel(d({ resolution: '1080p', videoCodec: 'libx264' })), '1080p H.264');
  assert.equal(versionLabel(d({ resolution: '1080p', videoCodec: 'av1' })), '1080p AV1');
});

test('two encodes of one film land beside each other under one title', () => {
  const uhd = versionPath('Blade Runner 2049 (2017) Bluray-2160p Remux', d({ resolution: '2160p', videoCodec: 'x265' }));
  const hd = versionPath('Blade Runner 2049 (2017) Bluray-1080p', d({ resolution: '1080p', videoCodec: 'x265' }));
  assert.equal(uhd!.folder, hd!.folder, 'the same folder is what makes them versions rather than two films');
  assert.equal(uhd!.folder, 'Blade Runner 2049 (2017)');
  assert.equal(uhd!.name, 'Blade Runner 2049 (2017) - 2160p HEVC');
  assert.equal(hd!.name, 'Blade Runner 2049 (2017) - 1080p HEVC');
  assert.notEqual(uhd!.name, hd!.name, 'and different names are what keeps one from overwriting the other');
});
