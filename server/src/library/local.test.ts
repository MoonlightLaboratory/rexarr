import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cleanTitle, groupFound, hintFromName, parseEpisode } from './local.js';

const GB = 1024 ** 3;
const root = '/media';
const found = (rel: string, size = 2 * GB, hint?: 'movie' | 'series' | 'music') => {
  const parts = rel.split('/');
  const file = parts.pop()!;
  return { path: path.join(root, ...parts, file), size, mtime: 0, dirs: parts, hint: hint ?? hintFromName(parts[0] ?? '') };
};

test('title and episode parsing', () => {
  assert.deepEqual(cleanTitle('The.Matrix.1999.2160p.UHD.BluRay.REMUX.HDR.HEVC.Atmos-GROUP.mkv'), { title: 'The Matrix', year: 1999 });
  assert.deepEqual(cleanTitle('Dune Part Two (2024) {tmdb-693134}'), { title: 'Dune Part Two', year: 2024 });
  assert.deepEqual(cleanTitle('[SubsPlease] Frieren - 05 (1080p) [ABCD1234].mkv').title, 'Frieren - 05');
  assert.equal(cleanTitle('2001 A Space Odyssey (1968)').year, 1968);
  assert.deepEqual(parseEpisode('Show.Name.S02E05.1080p.WEB-DL.mkv'), { season: 2, episode: 5 });
  assert.deepEqual(parseEpisode('[SubsPlease] Frieren - 05 (1080p).mkv'), { absolute: 5, episode: 5 });
  assert.equal(parseEpisode('Blade Runner 2049 (2017).mkv'), null);
});

test('files are grouped into movies, series and albums; category folders are not titles', () => {
  const items = groupFound(root, [
    found('Movies/Blade Runner 2049 (2017)/Blade Runner 2049 (2017) Remux-2160p.mkv', 60 * GB),
    found('Movies/Blade Runner 2049 (2017)/sample.mkv', 10 * 1024 * 1024),
    found('Movies/Akira.1988.1080p.BluRay.x265.mkv'),
    found('TV Shows/Mushishi/Season 01/Mushishi - S01E01.mkv'),
    found('TV Shows/Mushishi/Season 01/Mushishi - S01E02.mkv'),
    found('Anime/[SubsPlease] Frieren - 05 (1080p).mkv', GB),
    found('Anime/[SubsPlease] Frieren - 06 (1080p).mkv', GB),
    found('Anime Movies/Your Name (2016)/Your Name (2016).mkv'),
    found('Music/supercell/Today Is A Beautiful Day (2011) [FLAC]/01. Owarihemukau Hajimarinouta.flac', 30e6),
    found('Music/supercell/Today Is A Beautiful Day (2011) [FLAC]/02. Kimino Shiranai Monogatari.flac', 30e6),
    found('Music/Utada Hikaru - HEART STATION (2008)/CD1/01 Fight The Blues.flac', 30e6),
    found('ATLUS Sound Team/Aria of the Soul.flac', 30e6, 'music'),
    found('Music/Utada Hikaru - HEART STATION (2008)/CD2/01 Bonus.flac', 30e6),
  ]);
  const by = (kind: string, title: string) => items.find((i) => i.kind === kind && i.title === title);
  const br = by('movie', 'Blade Runner 2049');
  assert.ok(br, JSON.stringify(items.map((i) => [i.kind, i.title])));
  assert.equal(br.files.length, 1, 'sample skipped');
  assert.equal(br.files[0].isRemux, true, 'remux');
  assert.equal(br.files[0].resolution, 2160);
  assert.equal(by('movie', 'Akira')?.year, 1988);
  assert.equal(by('series', 'Mushishi')?.files.length, 2);
  assert.equal(by('series', 'Mushishi')?.files[1].season, 1);
  const frieren = by('series', 'Frieren');
  assert.equal(frieren?.files.length, 2);
  assert.equal(frieren?.anime, true, 'frieren anime');
  assert.equal(by('movie', 'Your Name')?.anime, true, 'your name anime');
  const album = by('album', 'Today Is A Beautiful Day');
  assert.equal(album?.artist, 'supercell');
  assert.equal(album?.year, 2011);
  assert.equal(album?.files[0].track, 1);
  const hs = by('album', 'HEART STATION');
  assert.equal(hs?.artist, 'Utada Hikaru');
  assert.equal(hs?.files.length, 2, 'CD1 + CD2 are one album');
  assert.deepEqual(hs?.files.map((f) => f.disc), [1, 2]);
  assert.ok(!items.some((i) => ['Movies', 'TV Shows', 'Anime', 'Music'].includes(i.title)));
  assert.equal(by('album', 'Singles')?.artist, 'ATLUS Sound Team');
});

test('smb:// folders resolve to where the share is mounted', async () => {
  const { parseMounts, resolveFolder } = await import('./local.js');
  const mounts = parseMounts('//user@192.168.1.20/Music%20Library on /Volumes/Music Library (smbfs, nodev, nosuid, mounted by user)\n//nas/music on /mnt/music type cifs (rw)\n/dev/disk3s1 on / (apfs)');
  assert.equal(mounts.length, 2);
  assert.equal(resolveFolder('smb://192.168.1.20/Music Library', mounts), '/Volumes/Music Library');
  assert.equal(resolveFolder('smb://192.168.1.20/Music%20Library/Some Artist', mounts), '/Volumes/Music Library/Some Artist');
  assert.equal(resolveFolder('smb://nas/Music', mounts), '/mnt/music');
  assert.equal(resolveFolder('smb://192.168.1.20/Soundtracks', mounts), '/Volumes/Soundtracks');
  assert.equal(resolveFolder('/data/media/', mounts), '/data/media');
});

test('metadata match scores: title, year and MusicBrainz artist aliases', async () => {
  const { matchScore } = await import('./localMeta.js');
  const movie = { kind: 'movie' as const, title: 'Suzume', year: 2022 };
  assert.ok(matchScore(movie, { source: 'tmdb', externalId: '916224', title: 'Suzume', year: 2022 }) >= 90);
  assert.ok(matchScore(movie, { source: 'tmdb', externalId: '1', title: 'Suzume', year: 1998 }) < 72, 'wrong year');
  assert.ok(matchScore({ kind: 'movie', title: 'Your Name', year: 2016 }, { source: 'tmdb', externalId: '372058', title: 'Your Name.', originalTitle: '君の名は。', year: 2016 }) >= 72);
  const album = { kind: 'album' as const, title: 'BAD MODE', artist: 'Hikaru Utada' };
  assert.ok(matchScore(album, { source: 'musicbrainz', externalId: 'x', title: 'BAD MODE', artist: '宇多田ヒカル', score: 100, artistVerified: true }) >= 72, 'artist resolved by MusicBrainz alias');
  assert.ok(matchScore(album, { source: 'musicbrainz', externalId: 'z', title: 'BAD MODE', artist: 'A Cover Band', score: 100 }) < 72, 'same title, other artist');
  const { artistNames } = await import('./localMeta.js');
  assert.ok(artistNames({ name: '宇多田ヒカル', 'sort-name': 'Utada, Hikaru', aliases: [{ name: 'Hikaru Utada' }] }).includes('Hikaru Utada'));
  assert.ok(matchScore(album, { source: 'musicbrainz', externalId: 'y', title: 'BAD MODE', artist: 'Someone Else', score: 60 }) < 72, 'other artist');
});
