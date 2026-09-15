import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectDisc, isRemux, isRemuxQuality, isRemuxTitle, resolutionFromQuality } from './remux.js';

test('detects remux qualities from Radarr and Sonarr', () => {
  assert.equal(isRemuxQuality('Remux-2160p'), true);
  assert.equal(isRemuxQuality('Bluray-1080p Remux'), true);
  assert.equal(isRemuxQuality('Bluray-1080p'), false);
  assert.equal(isRemuxQuality('WEBDL-2160p'), false);
  assert.equal(isRemuxQuality(undefined), false);
});

test('detects remux release titles', () => {
  assert.equal(isRemuxTitle('Blade.Runner.2049.2017.UHD.BluRay.2160p.TrueHD.Atmos.7.1.HEVC.REMUX-FraMeSToR'), true);
  assert.equal(isRemuxTitle('Some.Movie.2020.1080p.BDRemux.AVC.DTS-HD.MA'), true);
  assert.equal(isRemuxTitle('Some.Movie.2020.1080p.BD-Remux'), true);
  assert.equal(isRemuxTitle('Some.Movie.2020.1080p.BluRay.x264-GROUP'), false);
  assert.equal(isRemuxTitle('Premux.Show.S01E01.1080p'), false);
});

test('combined check and resolution parsing', () => {
  assert.equal(isRemux('Some.Title.1080p.x265', 'Remux-1080p'), true);
  assert.equal(isRemux('Some.Title.REMUX', 'Bluray-1080p'), true);
  assert.equal(resolutionFromQuality('Remux-2160p'), 2160);
  assert.equal(resolutionFromQuality('Bluray-1080p Remux'), 1080);
  assert.equal(resolutionFromQuality('Unknown', 0), 0);
});

test('detects full-disc releases (ISO / BDMV / VIDEO_TS)', () => {
  const disc = (t: string, q = '') => detectDisc(t, q);
  assert.deepEqual(disc('Blade.Runner.2049.2017.COMPLETE.UHD.BLURAY-TERMiNAL'), { isDisc: true, format: 'uhd' });
  assert.deepEqual(disc('Akira.1988.COMPLETE.BLURAY-UNTOUCHED'), { isDisc: true, format: 'bluray' });
  assert.deepEqual(disc('Some.Movie.2020.1080p.BD50.AVC.DTS-HD.MA'), { isDisc: true, format: 'bluray' });
  assert.deepEqual(disc('Some Movie 2020 BluRay ISO'), { isDisc: true, format: 'bluray' });
  assert.deepEqual(disc('Some.Movie.2020.2160p.BD-ISO.HEVC'), { isDisc: true, format: 'uhd' });
  assert.deepEqual(disc('Show.S01.1080p.Blu-ray.BDMV.AVC.LPCM'), { isDisc: true, format: 'bluray' });
  assert.deepEqual(disc('Anything', 'BR-DISK'), { isDisc: true, format: 'bluray' });
  assert.deepEqual(disc('Old.Film.1962.PAL.DVD9'), { isDisc: true, format: 'dvd' });
  assert.deepEqual(disc('Old Film 1962 DVD ISO'), { isDisc: true, format: 'dvd' });
  assert.deepEqual(disc('Old.Film.1962.NTSC.DVDR-GROUP'), { isDisc: true, format: 'dvd' });
  // not discs
  assert.equal(disc('Old.Film.1962.DVDRip.x264').isDisc, false);
  assert.equal(disc('Some.Movie.2020.1080p.BluRay.x264').isDisc, false);
  assert.equal(disc('Some.Movie.2020.2160p.BluRay.REMUX.HEVC').isDisc, false);
  assert.equal(disc('Some.Movie.2020.1080p.BDRip.x265').isDisc, false);
  assert.equal(disc('Some.Movie.2020.2160p.WEB-DL.DV').isDisc, false);
  assert.equal(disc('Isolation.2005.1080p.BluRay.x264').isDisc, false);
});
