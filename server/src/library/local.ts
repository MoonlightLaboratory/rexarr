/**
 * Local media: titles on disk that Radarr / Sonarr / Lidarr do not manage.
 *
 * The local side of every path mapping (and any extra folders) is walked in the background. Video files become
 * movies or series episodes, audio files are grouped into albums per folder – from folder and file names, the way
 * the *arr apps name things ("Title (Year)", "Show/Season 01/Show - S01E05", "[Group] Show - 05", "Artist/Album
 * (Year)/01 - Track.flac"), with folder names like Movies / TV Shows / Anime / Music as hints. Titles whose folder
 * belongs to an *arr app are hidden so search only adds what the apps cannot show. The index is kept in
 * data/local-media.json and refreshed every few hours or on demand.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { LocalFile, LocalItem, LocalMediaFolder, LocalScanStatus } from '../../../shared/types.js';
import { DATA_DIR } from '../config.js';
import { store } from '../store.js';
import { arr } from '../arr/index.js';
import { toLocalPath } from '../paths.js';
import { isRemuxTitle } from '../arr/remux.js';
import { enrichLocal, metaFor, metaStatus } from './localMeta.js';

const VIDEO_EXT = /\.(mkv|mp4|m4v|avi|mov|wmv|ts|m2ts|webm|mpe?g|iso)$/i;
const AUDIO_EXT = /\.(flac|mp3|m4a|alac|ogg|opus|wv|ape|dsf|dff|wav|aiff?|tta)$/i;
/** Loose videos smaller than this are samples, trailers or extras. */
const MIN_VIDEO_BYTES = 30 * 1024 * 1024;
const POSTER_NAMES = ['poster.jpg', 'poster.png', 'folder.jpg', 'folder.png', 'cover.jpg', 'cover.png', 'front.jpg'];

const FILE = path.join(DATA_DIR, 'local-media.json');

interface Index {
  scannedAt?: string;
  durationMs?: number;
  items: LocalItem[];
  hiddenArr: number;
  errors: string[];
}

let index: Index = { items: [], hiddenArr: 0, errors: [] };
try {
  index = { ...index, ...(JSON.parse(fs.readFileSync(FILE, 'utf8')) as Index) };
} catch {
  /* first run */
}

let scanning: Promise<void> | null = null;
let progress: LocalScanStatus['progress'];

// ---------- name parsing ----------

const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 16);

/** "The.Matrix.1999.2160p.UHD.BluRay.REMUX" / "The Matrix (1999) {tmdb-603}" → { title, year }. */
export function cleanTitle(raw: string): { title: string; year?: number } {
  let s = raw.replace(/\.[a-z0-9]{2,4}$/i, '');
  s = s.replace(/^(\[[^\]]*\]\s*)+/, ''); // [Group] prefix
  s = s.replace(/[{[]\s*(tmdb|tvdb|imdb|anidb)(id)?[-= ][^}\]]*[}\]]/gi, '');
  // the last year-like number that is not the start of the title ("2001 A Space Odyssey (1968)")
  const yearMatch = [...s.matchAll(/(?:^|[\s.(_[-])((?:19|20)\d{2})(?=$|[\s.)_\]-])/g)].filter((m) => (m.index ?? 0) > 0).pop();
  let year: number | undefined;
  if (yearMatch && yearMatch.index !== undefined) {
    year = Number(yearMatch[1]);
    s = s.slice(0, yearMatch.index);
  } else {
    // no year: cut at the first release token
    const tok = s.search(/[\s._\-([](2160p|1080p|720p|576p|480p|4k|uhd|bluray|blu-ray|bdrip|brrip|web-?dl|webrip|hdtv|remux|x264|x265|h\.?26[45]|hevc|avc|dvdrip|flac|mp3|aac|10bit)(?=$|[\s._\-)\]])/i);
    if (tok > 0) s = s.slice(0, tok);
  }
  s = s.replace(/\s*(\[[^\]]*\]|\([^)]*\))\s*$/g, '').replace(/[._]+/g, ' ').replace(/\s*[[(]\s*$/, '').replace(/\s+-\s*$/, '').replace(/\s+/g, ' ').trim();
  return { title: s || raw.trim(), year };
}

/** Episode numbers from a file name. */
export function parseEpisode(name: string): { season?: number; episode?: number; absolute?: number } | null {
  const base = name.replace(/\.[a-z0-9]{2,4}$/i, '');
  let m = base.match(/\bS(\d{1,2})[ ._-]?E(\d{1,4})(?:[-E]\d{1,4})*\b/i);
  if (m) return { season: Number(m[1]), episode: Number(m[2]) };
  m = base.match(/\b(\d{1,2})x(\d{2,3})\b/);
  if (m) return { season: Number(m[1]), episode: Number(m[2]) };
  // anime: "[Group] Show - 05 [1080p]", "Show - 105v2"
  m = base.match(/\s-\s(\d{1,4})(?:v\d)?(?=$|[\s[(.])/);
  if (m && !/^(19|20)\d{2}$/.test(m[1])) return { absolute: Number(m[1]), episode: Number(m[1]) };
  m = base.match(/\b(?:ep?|episode)[ ._-]?(\d{1,4})\b/i);
  if (m) return { episode: Number(m[1]) };
  return null;
}

/** "01 - Title.flac", "1-03 Title.flac", "CD2/05.flac" → disc / track. */
export function parseTrack(name: string, folder: string): { disc?: number; track?: number } {
  const base = name.replace(/\.[a-z0-9]{2,4}$/i, '');
  let m = base.match(/^(\d)[-.](\d{1,2})\b/);
  if (m) return { disc: Number(m[1]), track: Number(m[2]) };
  m = base.match(/^(\d{1,3})(?=[\s._-]|$)/);
  const disc = folder.match(/^(?:cd|disc|disk)\s*(\d+)$/i);
  return { track: m ? Number(m[1]) : undefined, disc: disc ? Number(disc[1]) : undefined };
}

function videoQuality(name: string): Pick<LocalFile, 'resolution' | 'isRemux' | 'quality'> {
  const res = /\b(2160p|4k|uhd)\b/i.test(name) ? 2160 : /\b1080[pi]\b/i.test(name) ? 1080 : /\b720p\b/i.test(name) ? 720 : /\b(576|480)[pi]\b/i.test(name) ? 480 : undefined;
  const remux = isRemuxTitle(name);
  const source = remux ? 'Remux' : /\.iso$/i.test(name) ? 'Disc' : /blu-?ray|bdrip|brrip/i.test(name) ? 'Bluray' : /web-?(dl|rip)|\bweb\b/i.test(name) ? 'WEB' : /hdtv/i.test(name) ? 'HDTV' : /dvd/i.test(name) ? 'DVD' : undefined;
  return { resolution: res, isRemux: remux || undefined, quality: source ? `${source}${res ? `-${res}p` : ''}` : res ? `${res}p` : undefined };
}

const SEASON_DIR = /^(season|series|staffel|saison|temporada)[\s._-]*\d{1,2}$|^s\d{1,2}$|^specials$/i;
const DISC_DIR = /^(cd|disc|disk)\s*\d+$/i;

type Hint = 'movie' | 'series' | 'music' | undefined;

/** Kind hint from a folder name (Movies, Films, TV Shows, Series, Anime, Music…). */
export function hintFromName(name: string): Hint {
  const n = name.toLowerCase();
  if (/\b(anime[\s_-]*movies?|movies?|films?|kino|cinema)\b/.test(n)) return 'movie';
  if (/\b(tv|tv[\s_-]*shows?|shows?|series|anime|television|drama|cartoons?)\b/.test(n)) return 'series';
  if (/\b(music|albums?|flac|mp3|audio|lossless|hi-?res|soundtracks?|ost)\b/.test(n)) return 'music';
  return undefined;
}

// ---------- scanning ----------

interface Found {
  path: string;
  size: number;
  mtime: number;
  /** Directories between the root and the file. */
  dirs: string[];
  hint: Hint;
}

/**
 * macOS smbfs lists some names decomposed (NFD: "o" + combining diaeresis, kana + dakuten) but only opens them in the
 * composed form (NFC), or the other way round. Stat the name as listed, then the other normalisation forms, and
 * return the path that works – that is the one encodes must use.
 */
async function statAnyForm(p: string, retry: <T>(fn: () => Promise<T>) => Promise<T>): Promise<{ path: string; st: fs.Stats } | null> {
  const forms = [...new Set([p, p.normalize('NFC'), p.normalize('NFD')])];
  for (const [i, form] of forms.entries()) {
    try {
      return { path: form, st: await retry(() => fs.promises.stat(form)) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || i === forms.length - 1) throw err;
    }
  }
  return null;
}

async function walk(root: string, kind: LocalMediaFolder['kind'], exclude: Set<string>, out: Found[], errors: string[]) {
  const rootHint: Hint = kind === 'auto' ? hintFromName(path.basename(root)) : kind;
  const queue: { dir: string; dirs: string[]; hint: Hint }[] = [{ dir: root, dirs: [], hint: rootHint }];
  let active = 0;
  let failures = 0;
  const unreadable: string[] = [];
  // network shares occasionally fail a request under load (EAGAIN / ETIMEDOUT / EIO): retry before giving up
  const retry = async <T,>(fn: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (attempt >= 3 || code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'ENOTDIR') throw err;
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
      }
    }
  };
  const visit = async ({ dir, dirs, hint }: { dir: string; dirs: string[]; hint: Hint }) => {
    let entries: fs.Dirent[];
    try {
      entries = await retry(() => fs.promises.readdir(dir, { withFileTypes: true })).catch(async (err: NodeJS.ErrnoException) => {
        // same name-normalisation quirk as statAnyForm, for folders
        for (const form of [dir.normalize('NFC'), dir.normalize('NFD')]) if (err.code === 'ENOENT' && form !== dir) return await fs.promises.readdir(form, { withFileTypes: true }).catch(() => { throw err; });
        throw err;
      });
    } catch (err) {
      if (dirs.length === 0 || ++failures <= 5) errors.push(`${dir}: ${(err as Error).message}`);
      return;
    }
    progress = { folders: (progress?.folders ?? 0) + 1, files: (progress?.files ?? 0), current: dir };
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (exclude.has(e.name.toLowerCase()) || e.name.startsWith('.rexarr')) continue;
        // an explicit kind wins; below an auto root the first named folder sets the hint
        queue.push({ dir: p, dirs: [...dirs, e.name], hint: kind !== 'auto' ? kind : (hint ?? hintFromName(e.name)) });
      } else if (e.isFile() && (VIDEO_EXT.test(e.name) || AUDIO_EXT.test(e.name))) {
        try {
          const hit = await statAnyForm(p, retry);
          if (!hit) continue;
          const st = hit.st;
          out.push({ path: hit.path, size: st.size, mtime: st.mtimeMs, dirs, hint });
          if (progress) progress.files++;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') unreadable.push(p);
          else if (++failures <= 5) errors.push(`${p}: ${(err as Error).message}`);
        }
      }
    }
  };
  // several parallel readers: network shares are slow per request, not per byte
  await new Promise<void>((resolve) => {
    const pump = () => {
      while (active < 8 && queue.length) {
        active++;
        void visit(queue.shift()!).finally(() => {
          active--;
          if (!queue.length && active === 0) resolve();
          else pump();
        });
      }
    };
    pump();
    if (!queue.length && active === 0) resolve();
  });
  // listed but not openable: on SMB shares, names the server stores in a Unicode form the client cannot open
  if (unreadable.length) errors.push(`${unreadable.length} file(s) in ${root} are listed but cannot be opened (name encoding on the share – rename them on the server), e.g. ${path.relative(root, unreadable[0])}`);
}

/** Group scanned files into titles. */
export function groupFound(root: string, found: Found[]): LocalItem[] {
  const items = new Map<string, LocalItem>();
  const add = (key: string, make: () => Omit<LocalItem, 'files' | 'size' | 'id'>, file: LocalFile) => {
    let it = items.get(key);
    if (!it) {
      it = { id: hash(key), ...make(), files: [], size: 0 };
      items.set(key, it);
    }
    it.files.push(file);
    it.size += file.size;
  };
  for (const f of found) {
    const name = path.basename(f.path);
    const dirs = f.dirs;
    // folders that only say what is inside ("Movies", "TV Shows", "Anime") are not titles
    const titleDirs = dirs.filter((d) => !(hintFromName(d) && cleanTitle(d).title.split(' ').length <= 3 && !/\(\d{4}\)/.test(d)));
    const folder = path.dirname(f.path);

    if (AUDIO_EXT.test(name)) {
      if (f.hint && f.hint !== 'music' && !titleDirs.length) continue; // stray audio in a video folder
      let albumIdx = titleDirs.length - 1;
      const last = titleDirs[albumIdx];
      if (last && DISC_DIR.test(last)) albumIdx--;
      const albumDir = titleDirs[albumIdx];
      const artistDir = titleDirs[albumIdx - 1];
      const albumFolder = albumDir ? path.join(root, ...dirs.slice(0, dirs.indexOf(albumDir) + 1)) : folder;
      let artist = artistDir ? cleanTitle(artistDir).title : undefined;
      let album = albumDir ? albumDir : cleanTitle(name).title;
      // "Artist - Album (Year) [FLAC]"
      const dash = album.match(/^(.+?)\s+-\s+(.+)$/);
      if (albumIdx === 0 && titleDirs.length === 1 && !dash && f.hint === 'music') {
        // tracks straight inside a music library's artist folder
        artist = cleanTitle(albumDir!).title;
        album = 'Singles';
      } else if (dash && !artistDir) {
        artist = dash[1].trim();
        album = dash[2];
      } else if (dash && artist && dash[1].toLowerCase().includes(artist.toLowerCase())) album = dash[2];
      const { title, year } = cleanTitle(album.replace(/\s*[[(](flac|mp3|aac|alac|wav|ape|dsd|hi-?res|web|cd|vinyl|\d+\s*bit|\d+(\.\d+)?\s*khz)[^\])]*[\])]/gi, ''));
      const t = parseTrack(name, path.basename(folder));
      add(`album:${albumFolder}`, () => ({ kind: 'album', title, year, artist, folder: albumFolder, root }), { path: f.path, size: f.size, mtime: f.mtime, disc: t.disc, track: t.track });
      continue;
    }

    // video
    if (f.hint === 'music') continue;
    const iso = /\.iso$/i.test(name);
    if (f.size < MIN_VIDEO_BYTES && !iso) continue;
    const ep = parseEpisode(name);
    const q = videoQuality(`${dirs.slice(-1)[0] ?? ''} ${name}`);
    const inSeasonDir = titleDirs.length > 0 && SEASON_DIR.test(titleDirs[titleDirs.length - 1]);
    const seriesLike = f.hint === 'series' || inSeasonDir || (ep && (ep.season !== undefined || f.hint !== 'movie'));
    const anime = dirs.some((d) => /\banime\b/i.test(d)) || /^\[[^\]]+\]/.test(name);
    if (seriesLike && (ep || inSeasonDir)) {
      const showIdx = inSeasonDir ? titleDirs.length - 2 : titleDirs.length - 1;
      const showDir = titleDirs[showIdx];
      const seasonNum = inSeasonDir ? Number(titleDirs[titleDirs.length - 1].match(/\d+/)?.[0] ?? (/specials/i.test(titleDirs[titleDirs.length - 1]) ? 0 : NaN)) : undefined;
      const parsed = showDir ? cleanTitle(showDir) : cleanTitle(name.replace(/\bS\d{1,2}[ ._-]?E\d{1,4}.*$/i, '').replace(/\s-\s\d{1,4}(v\d)?\b.*$/, ''));
      const showFolder = showDir ? path.join(root, ...dirs.slice(0, dirs.lastIndexOf(showDir) + 1)) : folder;
      const key = showDir ? `series:${showFolder}` : `series:${folder}:${parsed.title.toLowerCase()}`;
      add(key, () => ({ kind: 'series', title: parsed.title, year: parsed.year, anime: anime || undefined, folder: showFolder, root }), {
        path: f.path,
        size: f.size,
        mtime: f.mtime,
        season: ep?.season ?? (Number.isFinite(seasonNum) ? seasonNum : undefined),
        episode: ep?.episode,
        absolute: ep?.absolute,
        ...q,
      });
      continue;
    }
    // movie: its own folder ("Title (Year)/Title (Year).mkv") or a loose file
    const movieDir = titleDirs[titleDirs.length - 1];
    const fromDir = movieDir ? cleanTitle(movieDir) : undefined;
    const fromFile = cleanTitle(name);
    const useDir = fromDir && (fromDir.year || !fromFile.year) && !DISC_DIR.test(movieDir!) && !/^(bdmv|stream|video_ts)$/i.test(movieDir!);
    const parsed = useDir ? fromDir! : fromFile;
    const movieFolder = useDir ? folder : folder;
    const key = useDir ? `movie:${folder}` : `movie:${folder}:${parsed.title.toLowerCase()}:${parsed.year ?? ''}`;
    add(key, () => ({ kind: 'movie', title: parsed.title, year: parsed.year, anime: anime || undefined, folder: movieFolder, root }), { path: f.path, size: f.size, mtime: f.mtime, ...q });
  }
  for (const it of items.values()) {
    it.files.sort((a, b) => (a.disc ?? 0) - (b.disc ?? 0) || (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? a.track ?? 0) - (b.episode ?? b.track ?? 0) || a.path.localeCompare(b.path, undefined, { numeric: true }));
    it.poster = POSTER_NAMES.some((n) => fs.existsSync(path.join(it.folder, n))) || undefined;
  }
  return [...items.values()];
}

let mountCache: { at: number; mounts: { source: string; target: string }[] } | null = null;

/** Network mounts from `mount`: "//user@host/Share%20Name on /Volumes/Share Name (smbfs…)" or "//host/share on /mnt/x type cifs". */
export function parseMounts(text: string): { source: string; target: string }[] {
  const out: { source: string; target: string }[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^(\/\/\S+)\s+on\s+(.+?)\s+(?:\(|type\s)/);
    if (m) out.push({ source: m[1], target: m[2] });
  }
  return out;
}

/**
 * "smb://192.168.1.20/Music Library/Anime" → the folder where that share is mounted
 * ("/Volumes/Music Library/Anime"). Plain paths are returned as they are.
 */
export function resolveFolder(input: string, mounts?: { source: string; target: string }[]): string {
  const raw = input.trim();
  const url = raw.match(/^(?:smb|cifs):\/\/(?:[^@/]+@)?([^/]+)\/([^/]+)(\/.*)?$/i);
  if (!url) return path.resolve(raw);
  const [, host, shareRaw, rest = ''] = url;
  const share = decodeURIComponent(shareRaw).toLowerCase();
  if (!mounts) {
    if (!mountCache || Date.now() - mountCache.at > 60_000) {
      let text = '';
      try {
        text = execFileSync('mount', [], { encoding: 'utf8', timeout: 5000 });
      } catch {
        /* no mount command */
      }
      mountCache = { at: Date.now(), mounts: parseMounts(text) };
    }
    mounts = mountCache.mounts;
  }
  const hit = mounts.find((m) => {
    const src = m.source.match(/^\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/);
    return src && src[1].toLowerCase() === host.toLowerCase() && decodeURIComponent(src[2]).toLowerCase() === share;
  });
  // not mounted: the conventional macOS mount point, reported as missing until the share is connected
  const base = hit ? hit.target : path.join('/Volumes', decodeURIComponent(shareRaw));
  return path.join(base, decodeURIComponent(rest));
}

/** Folders to scan: extra folders plus the local side of path mappings, without duplicates or nested repeats. */
export function scanRoots(): LocalScanStatus['roots'] {
  const s = store.settings.localMedia;
  const list: LocalScanStatus['roots'] = [];
  for (const f of s.folders) if (f.path.trim()) list.push({ path: resolveFolder(f.path), kind: f.kind, fromMapping: false, exists: false });
  if (s.usePathMappings) for (const m of store.settings.pathMappings) if (m.local.trim() && m.app !== 'slskd') list.push({ path: path.resolve(m.local.trim()), kind: 'auto', fromMapping: true, exists: false });
  const out: LocalScanStatus['roots'] = [];
  for (const r of list) {
    if (out.some((o) => o.path === r.path)) continue;
    // a folder inside another root is covered by it, unless it was added with an explicit kind
    const parent = out.find((o) => r.path.startsWith(`${o.path}${path.sep}`));
    if (parent && (r.fromMapping || r.kind === 'auto')) continue;
    out.push({ ...r, exists: fs.existsSync(r.path) && fs.statSync(r.path).isDirectory() });
  }
  return out;
}

async function arrFolders(): Promise<string[]> {
  const { radarr, sonarr, lidarr } = arr();
  const [movies, series, artists] = await Promise.all([
    radarr.configured ? radarr.movies().catch(() => []) : [],
    sonarr.configured ? sonarr.series().catch(() => []) : [],
    lidarr.configured ? lidarr.artists().catch(() => []) : [],
  ]);
  return [
    ...movies.map((m) => toLocalPath(m.path, 'radarr')),
    ...series.map((s) => toLocalPath(s.path, 'sonarr')),
    ...artists.map((a) => toLocalPath(a.path, 'lidarr')),
  ]
    .filter(Boolean)
    .map((p) => path.resolve(p));
}

export function scan(): Promise<void> {
  if (scanning) return scanning;
  scanning = (async () => {
    const started = Date.now();
    const s = store.settings.localMedia;
    const exclude = new Set(s.exclude.map((e) => e.toLowerCase()));
    const errors: string[] = [];
    const items: LocalItem[] = [];
    progress = { folders: 0, files: 0 };
    const roots = scanRoots();
    for (const r of roots) {
      if (!r.exists) {
        errors.push(`${r.path}: folder not found`);
        continue;
      }
      const found: Found[] = [];
      await walk(r.path, r.kind, exclude, found, errors);
      items.push(...groupFound(r.path, found));
    }
    let hiddenArr = 0;
    let visible = items;
    if (s.hideArrManaged) {
      const managed = await arrFolders();
      const isManaged = (folder: string) => managed.some((m) => folder === m || folder.startsWith(`${m}${path.sep}`));
      visible = items.filter((it) => {
        const hide = isManaged(it.folder) || (it.kind === 'album' && isManaged(path.dirname(it.folder)));
        if (hide) hiddenArr++;
        return !hide;
      });
    }
    index = { scannedAt: new Date().toISOString(), durationMs: Date.now() - started, items: visible, hiddenArr, errors };
    try {
      const tmp = `${FILE}.${process.pid}.tmp`;
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(index));
      fs.renameSync(tmp, FILE);
    } catch (err) {
      console.error('[local] could not save index', err);
    }
    void enrichLocal(visible).catch((err: Error) => console.error('[local-meta] failed', err.message));
    console.log(`[local] scanned ${roots.length} folder(s) in ${Math.round(index.durationMs! / 1000)} s: ${visible.length} titles outside the *arr apps (${hiddenArr} managed by them)`);
  })().finally(() => {
    scanning = null;
    progress = undefined;
  });
  return scanning;
}

export function localStatus(): LocalScanStatus {
  const counts = { movie: 0, series: 0, album: 0, files: 0, hiddenArr: index.hiddenArr };
  for (const it of index.items) {
    counts[it.kind]++;
    counts.files += it.files.length;
  }
  return { scanning: Boolean(scanning), scannedAt: index.scannedAt, durationMs: index.durationMs, roots: scanRoots(), counts, progress, errors: index.errors, metadata: store.settings.localMedia.metadata ? metaStatus() : undefined };
}

export function localItems(): LocalItem[] {
  return store.settings.localMedia.enabled ? index.items.map(withMeta) : [];
}

export function localItem(id: string): LocalItem | undefined {
  const it = index.items.find((i) => i.id === id);
  return it && withMeta(it);
}

function withMeta(it: LocalItem): LocalItem {
  const meta = store.settings.localMedia.metadata ? metaFor(it.id) : undefined;
  return meta ? { ...it, meta } : it;
}

/** Match metadata for titles that have none yet (e.g. after metadata was switched on). */
export function refreshLocalMetadata(force = false) {
  return enrichLocal(index.items, { force });
}

export function localPoster(it: LocalItem): string | undefined {
  for (const n of POSTER_NAMES) {
    const p = path.join(it.folder, n);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

/** Scan on start when the index is stale, then on the configured interval. */
export function startLocalMedia() {
  const tick = () => {
    const s = store.settings.localMedia;
    if (!s.enabled || scanning) return;
    const age = index.scannedAt ? Date.now() - new Date(index.scannedAt).getTime() : Infinity;
    if (!index.scannedAt || (s.rescanHours > 0 && age > s.rescanHours * 3600_000)) void scan().catch((err: Error) => console.error('[local] scan failed', err));
    else void enrichLocal(index.items).catch((err: Error) => console.error('[local-meta] failed', err.message));
  };
  setTimeout(tick, 15_000).unref();
  setInterval(tick, 10 * 60_000).unref();
}
