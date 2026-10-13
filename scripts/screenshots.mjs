#!/usr/bin/env node
/**
 * The documentation screenshots, taken from a running Rexarr.
 *
 *   node scripts/screenshots.mjs                        every shot, against http://127.0.0.1:3939
 *   node scripts/screenshots.mjs --url http://host:3939
 *   node scripts/screenshots.mjs --only smart-profile,profiles
 *   node scripts/screenshots.mjs --keep-png             leave the PNGs beside the webp files
 *
 * It drives a Chromium-family browser that is already installed (Brave, Chrome, Chromium, Edge) in headless
 * mode, writes docs/screenshots/<name>.webp at 1400x875 – the size the rest of the set uses – and converts with
 * cwebp. A few shots are not reachable by URL alone, because they are a dialog or need a disc in the drive or an
 * encode in flight; those are listed at the end to take by hand.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs/screenshots');
const WIDTH = 1400;
const HEIGHT = 875;

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? '') : fallback;
};
const base = (flag('url', 'http://127.0.0.1:3939') || '').replace(/\/+$/, '');
const only = flag('only', '').split(',').map((s) => s.trim()).filter(Boolean);
const keepPng = args.includes('--keep-png');

const BROWSERS = [
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/brave-browser',
];

/** Pages a URL can reach on its own. The rest need a dialog open or a disc in the drive. */
const SHOTS = [
  { name: 'series', path: '/series', caption: 'The series library' },
  { name: 'series-detail', path: (ids) => `/series/${ids.series}`, caption: 'A series, season by season', needs: 'series' },
  { name: 'movie', path: (ids) => `/movies/${ids.movie}`, caption: 'A film, with Audio only beside Transcode', needs: 'movie' },
  { name: 'music', path: '/music', caption: 'The music library' },
  { name: 'artist', path: (ids) => `/music/artist/${ids.artist}`, caption: 'An artist and their albums', needs: 'artist' },
  { name: 'local-files', path: (ids) => `/local/${ids.local}`, caption: 'Media no *arr app manages', needs: 'local' },
  { name: 'activity', path: '/activity', caption: 'The queue' },
  { name: 'discs', path: '/discs', caption: 'Discs and drives' },
  { name: 'profiles', path: '/profiles', caption: 'Profiles, and the smart profiles above them' },
  { name: 'smart-profile', path: '/profiles/smart/builtin-smart-lossless-audio', caption: 'A smart profile as a graph' },
  { name: 'search', path: (ids) => `/search?kind=movie&id=${ids.movie}`, caption: 'Search, scored and explained', needs: 'movie', wait: 20000 },
  { name: 'system', path: '/system', caption: 'System status' },
];

/** Needs a click, a disc, or an encode running: left to take by hand. */
const BY_HAND = [
  ['transcode', 'the Transcode dialog – open it from a film and tick Audio only'],
  ['header-search', 'the search popup in the header'],
  ['live-preview', 'Activity, while something is encoding'],
  ['compare', 'the before / after comparison on a finished encode'],
  ['disc-ready', 'a disc scanned and ready to rip'],
  ['disc-ripping', 'a rip in progress'],
];

async function browser() {
  const found = BROWSERS.find((b) => fs.existsSync(b));
  if (!found) throw new Error(`No Chromium-family browser found. Looked in:\n  ${BROWSERS.join('\n  ')}`);
  return found;
}

async function ids() {
  const get = async (p) => {
    const res = await fetch(`${base}${p}`);
    if (!res.ok) throw new Error(`${p}: HTTP ${res.status}`);
    return res.json();
  };
  const out = {};
  try {
    const movies = await get('/api/library/movies');
    out.movie = (movies.find((m) => m.file) ?? movies[0])?.id;
  } catch (err) {
    console.warn(`  could not read the movie library (${err.message})`);
  }
  try {
    const series = await get('/api/library/series');
    out.series = (series.find((s) => (s.seasons ?? []).length > 1) ?? series[0])?.id;
  } catch (err) {
    console.warn(`  could not read the series library (${err.message})`);
  }
  try {
    const artists = await get('/api/music/artists');
    out.artist = artists.find((a) => a.statistics?.trackFileCount)?.id ?? artists[0]?.id;
  } catch {
    /* Lidarr is optional */
  }
  try {
    const items = await get('/api/local/items');
    out.local = items[0]?.id;
  } catch {
    /* local media is optional */
  }
  return out;
}

async function capture(bin, url, png, wait) {
  const profile = path.join(process.env.TMPDIR ?? '/tmp', `rexarr-shots-${process.pid}`);
  await run(bin, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--force-device-scale-factor=1',
    `--user-data-dir=${profile}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    `--virtual-time-budget=${wait}`,
    `--screenshot=${png}`,
    url,
  ], { timeout: Math.max(60_000, wait + 30_000) });
}

async function toWebp(png, webp) {
  try {
    await run('cwebp', ['-quiet', '-q', '80', png, '-o', webp]);
    return true;
  } catch (err) {
    console.warn(`  cwebp failed (${err.message}); the PNG is kept instead`);
    return false;
  }
}

const main = async () => {
  const bin = await browser();
  console.log(`Browser: ${bin}`);
  console.log(`Rexarr:  ${base}`);
  const res = await fetch(`${base}/api/health`).catch(() => null);
  if (!res?.ok) throw new Error(`${base} is not answering – start Rexarr first, or pass --url`);
  fs.mkdirSync(OUT, { recursive: true });

  const found = await ids();
  let taken = 0;
  for (const shot of SHOTS) {
    if (only.length && !only.includes(shot.name)) continue;
    if (shot.needs && !found[shot.needs]) {
      console.log(`- ${shot.name}: skipped, nothing in the ${shot.needs} library`);
      continue;
    }
    const url = `${base}${typeof shot.path === 'function' ? shot.path(found) : shot.path}`;
    const png = path.join(OUT, `${shot.name}.png`);
    const webp = path.join(OUT, `${shot.name}.webp`);
    process.stdout.write(`- ${shot.name}: ${url} … `);
    try {
      await capture(bin, url, png, shot.wait ?? 9000);
      const ok = await toWebp(png, webp);
      if (ok && !keepPng) fs.rmSync(png, { force: true });
      console.log(`${Math.round(fs.statSync(ok ? webp : png).size / 1024)} KB`);
      taken++;
    } catch (err) {
      console.log(`failed: ${err.message}`);
    }
  }

  console.log(`\n${taken} screenshot(s) written to docs/screenshots.`);
  console.log('These need a click or a disc, so they stay as they are unless you retake them by hand:');
  for (const [name, what] of BY_HAND) console.log(`  ${name}.webp – ${what}`);
};

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
