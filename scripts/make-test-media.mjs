#!/usr/bin/env node
/**
 * Builds a self-contained test bench for rexarr:
 *
 *   test-media/
 *     Movies/Test Movie (2024)/Test.Movie.2024.1080p.BluRay.REMUX.mkv   h264 + FLAC eng/jpn + SRT + chapters
 *     TV/Test Show/Season 01/Test Show - S01E01 - Bluray-1080p Remux.mkv (+ E02)
 *     hdr/Test.HDR.2160p.REMUX.mkv                                        10-bit BT.2020 / PQ tagged sample
 *     discs/TEST_DVD.iso                                                  real DVD-Video image (needs dvdauthor)
 *     discs/TEST_DVD_FOLDER/VIDEO_TS                                      same disc as a folder
 *
 * Point Settings → Disc ripping → "Virtual drives folder" at test-media/discs and rexarr will treat the
 * image as an inserted disc and rip it with MakeMKV. Point a path mapping or Radarr root at Movies/ to
 * test transcoding from the library, or queue the files directly from a job with a file path.
 *
 *   node scripts/make-test-media.mjs [outdir] [--seconds 10] [--force]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const outDir = path.resolve(args.find((a) => !a.startsWith('--')) ?? 'test-media');
const seconds = Number(args[args.indexOf('--seconds') + 1] || 10) || 10;
const force = args.includes('--force');

const which = (bin) => {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim().split('\n')[0] : null;
};
const run = (bin, a, opts = {}) => execFileSync(bin, a, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const log = (m) => console.log(`[36m▸[0m ${m}`);
const warn = (m) => console.log(`[33m![0m ${m}`);

const ffmpeg = process.env.FFMPEG ?? which('ffmpeg');
if (!ffmpeg) {
  console.error('ffmpeg not found on PATH (set FFMPEG=/path/to/ffmpeg)');
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rexarr-test-media-'));

const subs = (lines) => lines.map((t, i) => `${i + 1}\n00:00:0${i * 2 + 1},000 --> 00:00:0${i * 2 + 2},500\n${t}\n`).join('\n');
fs.writeFileSync(path.join(tmp, 'eng.srt'), subs(['Hello from rexarr', 'Second line', 'Third line']));
fs.writeFileSync(path.join(tmp, 'jpn.srt'), subs(['rexarr からこんにちは', '二行目', '三行目']));
fs.writeFileSync(path.join(tmp, 'chapters.txt'), `;FFMETADATA1\ntitle=rexarr test\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=${Math.floor((seconds * 1000) / 2)}\ntitle=Opening\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=${Math.floor((seconds * 1000) / 2)}\nEND=${seconds * 1000}\ntitle=Ending\n`);

/** A 1080p "remux-like" MKV: h264 video, two FLAC audio tracks (eng/jpn), two SRT subtitle tracks, chapters. */
function makeRemux(dest, { label, width = 1920, height = 1080, pattern = 'testsrc2' }) {
  if (fs.existsSync(dest) && !force) return log(`exists   ${path.relative(outDir, dest)}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `${pattern}=size=${width}x${height}:rate=24:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=660:duration=${seconds}`,
    '-i', path.join(tmp, 'eng.srt'), '-i', path.join(tmp, 'jpn.srt'), '-i', path.join(tmp, 'chapters.txt'),
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s', '-map', '4:s', '-map_metadata', '5',
    '-vf', `drawtext=text='${label}':fontsize=64:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=black@0.5`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'flac', '-c:s', 'srt',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:0', 'title=English 2.0',
    '-metadata:s:a:1', 'language=jpn', '-metadata:s:a:1', 'title=Japanese 2.0',
    '-metadata:s:s:0', 'language=eng', '-metadata:s:s:1', 'language=jpn',
    dest,
  ]);
  log(`created  ${path.relative(outDir, dest)}`);
}

/** 10-bit sample tagged as BT.2020 / PQ so HDR passthrough code paths are exercised. */
function makeHdr(dest) {
  if (fs.existsSync(dest) && !force) return log(`exists   ${path.relative(outDir, dest)}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    run(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc2=size=3840x2160:rate=24:duration=${Math.min(seconds, 6)}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${Math.min(seconds, 6)}`,
      '-map', '0:v', '-map', '1:a',
      '-c:v', 'libx265', '-preset', 'ultrafast', '-crf', '24', '-pix_fmt', 'yuv420p10le',
      '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc',
      '-x265-params', 'hdr10=1:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):max-cll=1000,400',
      '-c:a', 'flac', '-metadata:s:a:0', 'language=eng',
      dest,
    ]);
    log(`created  ${path.relative(outDir, dest)}`);
  } catch (e) {
    warn(`HDR sample skipped (needs libx265 in ffmpeg): ${String(e.stderr ?? e.message).trim().split('\n').pop()}`);
  }
}

/** A real DVD-Video: MPEG-2 PS via ffmpeg, IFO/VOB structure via dvdauthor, then an ISO. */
function makeDvd() {
  const iso = path.join(outDir, 'discs', 'TEST_DVD.iso');
  const folder = path.join(outDir, 'discs', 'TEST_DVD_FOLDER');
  if (fs.existsSync(iso) && fs.existsSync(path.join(folder, 'VIDEO_TS')) && !force) return log(`exists   discs/TEST_DVD.iso + TEST_DVD_FOLDER`);
  const dvdauthor = which('dvdauthor');
  if (!dvdauthor) {
    warn('dvdauthor not found: skipping the DVD image. Install it (brew install dvdauthor / apt install dvdauthor) and re-run.');
    return;
  }
  fs.mkdirSync(path.join(outDir, 'discs'), { recursive: true });
  const mpg = path.join(tmp, 'title.mpg');
  const extra = path.join(tmp, 'extra.mpg');
  const dvdArgs = (label, dur) => [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=720x576:rate=25:duration=${dur}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${dur}`,
    '-f', 'lavfi', '-i', `sine=frequency=660:duration=${dur}`,
    '-map', '0:v', '-map', '1:a', '-map', '2:a',
    '-vf', `drawtext=text='${label}':fontsize=40:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=black@0.5`,
    '-target', 'pal-dvd', '-c:a', 'ac3', '-b:a', '192k',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=jpn',
  ];
  run(ffmpeg, [...dvdArgs('TEST DVD - MAIN FEATURE', seconds), mpg]);
  run(ffmpeg, [...dvdArgs('TEST DVD - EXTRA', Math.max(3, Math.floor(seconds / 2))), extra]);
  fs.rmSync(folder, { recursive: true, force: true });
  fs.mkdirSync(folder, { recursive: true });
  const xml = `<dvdauthor dest="${folder}">
  <vmgm />
  <titleset>
    <titles>
      <video format="pal" aspect="4:3" />
      <audio lang="en" /><audio lang="ja" />
      <pgc><vob file="${mpg}" chapters="0,0:00:${String(Math.floor(seconds / 2)).padStart(2, '0')}" /></pgc>
      <pgc><vob file="${extra}" /></pgc>
    </titles>
  </titleset>
</dvdauthor>
`;
  const xmlPath = path.join(tmp, 'dvd.xml');
  fs.writeFileSync(xmlPath, xml);
  run(dvdauthor, ['-x', xmlPath], { env: { ...process.env, VIDEO_FORMAT: 'PAL' } });
  log(`created  discs/TEST_DVD_FOLDER/VIDEO_TS`);

  // ISO: hdiutil on macOS; genisoimage / mkisofs / xorriso on Linux.
  if (fs.existsSync(iso)) fs.rmSync(iso);
  if (process.platform === 'darwin') {
    run('hdiutil', ['makehybrid', '-udf', '-udf-volume-name', 'TEST_DVD', '-iso', '-joliet', '-default-volume-name', 'TEST_DVD', '-o', iso, folder]);
  } else {
    const tool = which('genisoimage') ?? which('mkisofs') ?? which('xorriso');
    if (!tool) return warn('No genisoimage / mkisofs / xorriso found: ISO skipped, but TEST_DVD_FOLDER works as a virtual drive too.');
    if (tool.endsWith('xorriso')) run(tool, ['-as', 'mkisofs', '-dvd-video', '-V', 'TEST_DVD', '-o', iso, folder]);
    else run(tool, ['-dvd-video', '-V', 'TEST_DVD', '-o', iso, folder]);
  }
  log(`created  discs/TEST_DVD.iso (${(fs.statSync(iso).size / 1e6).toFixed(1)} MB)`);
}

makeRemux(path.join(outDir, 'Movies', 'Test Movie (2024)', 'Test.Movie.2024.1080p.BluRay.REMUX.mkv'), { label: 'TEST MOVIE' });
makeRemux(path.join(outDir, 'TV', 'Test Show', 'Season 01', 'Test Show - S01E01 - Bluray-1080p Remux.mkv'), { label: 'TEST SHOW S01E01' });
makeRemux(path.join(outDir, 'TV', 'Test Show', 'Season 01', 'Test Show - S01E02 - Bluray-1080p Remux.mkv'), { label: 'TEST SHOW S01E02', pattern: 'smptehdbars' });
makeHdr(path.join(outDir, 'hdr', 'Test.HDR.2160p.BluRay.REMUX.mkv'));
makeDvd();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`
Test media ready in ${outDir}

  Transcoding : queue any file under Movies/, TV/ or hdr/ (Activity → or POST /api/jobs with source.localPath),
                or add Movies/ as a Radarr root folder and use the library pages.
  Disc ripping: Settings → Disc ripping → Virtual drives folder = ${path.join(outDir, 'discs')}
                then enable disc ripping (or press "Detect disc") – TEST_DVD appears as a loaded drive.
`);
