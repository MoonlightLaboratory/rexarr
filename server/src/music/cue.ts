/**
 * CUE sheet + single-file album images ("FLAC+CUE", "APE+CUE", "image+cue").
 *
 * Lidarr cannot import an album that is one long audio file with a cue sheet: it sees one track and blocks the
 * download. Rexarr finds such images in finished downloads, splits them into tracks with fre:ac (which reads cue
 * sheets natively and tags every track from it) and hands the split folder back to Lidarr.
 *
 * fre:ac only reads UTF-8 cue sheets whose FILE entries match the file on disk, so Rexarr first writes a normalised
 * copy: text decoded from Shift-JIS / GBK / Big5 / EUC-KR / Windows-1252 when it is not UTF-8, FILE entries resolved
 * to the real file (wrong extension, "CDImage.wav" next to a .flac, different case) as absolute paths.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runTool, type RunHooks } from './freac.js';

const run = promisify(execFile);

export const IMAGE_AUDIO_EXT = /\.(flac|ape|wv|wav|tta|aiff?|m4a|tak)$/i;

export interface CueTrack {
  number: number;
  title?: string;
  performer?: string;
  isrc?: string;
  /** INDEX 01 in CD frames (1/75 s). */
  start: number;
  /** INDEX 00 (pregap start) when present. */
  pregap?: number;
}

export interface CueFile {
  name: string;
  tracks: CueTrack[];
}

export interface CueSheet {
  title?: string;
  performer?: string;
  date?: string;
  genre?: string;
  discNumber?: number;
  totalDiscs?: number;
  catalog?: string;
  files: CueFile[];
}

/** Decode cue sheet bytes: BOMs, then strict UTF-8, then the legacy code pages rips commonly use. */
export function decodeCueText(buf: Buffer): { text: string; encoding: string } {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8' };
  if (buf[0] === 0xff && buf[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'utf-16le' };
  if (buf[0] === 0xfe && buf[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'utf-16be' };
  const tryDecode = (enc: string) => {
    try {
      return new TextDecoder(enc, { fatal: true }).decode(buf);
    } catch {
      return null;
    }
  };
  const utf8 = tryDecode('utf-8');
  if (utf8 !== null) return { text: utf8, encoding: 'utf-8' };
  // Shift-JIS first when it yields kana (GBK also decodes most Shift-JIS byte pairs, into nonsense)
  const sjis = tryDecode('shift_jis');
  if (sjis !== null && /[぀-ヿ]/.test(sjis)) return { text: sjis, encoding: 'shift_jis' };
  for (const enc of ['gbk', 'big5', 'euc-kr']) {
    const t = tryDecode(enc);
    if (t !== null) return { text: t, encoding: enc };
  }
  if (sjis !== null) return { text: sjis, encoding: 'shift_jis' };
  return { text: new TextDecoder('windows-1252').decode(buf), encoding: 'windows-1252' };
}

const unquote = (s: string) => {
  const t = s.trim();
  return t.startsWith('"') ? t.slice(1, t.lastIndexOf('"') > 0 ? t.lastIndexOf('"') : undefined) : t;
};

const frames = (mmssff: string) => {
  const [m, s, f] = mmssff.split(':').map(Number);
  return (m * 60 + s) * 75 + f;
};

export function parseCue(text: string): CueSheet {
  const sheet: CueSheet = { files: [] };
  let file: CueFile | null = null;
  let track: CueTrack | null = null;
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    const m = line.match(/^(\S+)\s*(.*)$/);
    if (!m) continue;
    const cmd = m[1].toUpperCase();
    const rest = m[2];
    if (cmd === 'FILE') {
      // FILE "name with spaces.flac" WAVE  (type is the last word)
      const name = rest.startsWith('"') ? unquote(rest) : rest.replace(/\s+\S+$/, '');
      file = { name, tracks: [] };
      sheet.files.push(file);
      track = null;
    } else if (cmd === 'TRACK') {
      const [num, type] = rest.split(/\s+/);
      if (!file || (type && type.toUpperCase() !== 'AUDIO')) {
        track = null;
        continue;
      }
      track = { number: Number(num), start: 0 };
      file.tracks.push(track);
    } else if (cmd === 'INDEX' && track) {
      const [n, t] = rest.split(/\s+/);
      if (Number(n) === 1) track.start = frames(t);
      else if (Number(n) === 0) track.pregap = frames(t);
    } else if (cmd === 'TITLE') {
      if (track) track.title = unquote(rest);
      else sheet.title = unquote(rest);
    } else if (cmd === 'PERFORMER') {
      if (track) track.performer = unquote(rest);
      else sheet.performer = unquote(rest);
    } else if (cmd === 'ISRC' && track) track.isrc = unquote(rest);
    else if (cmd === 'CATALOG') sheet.catalog = unquote(rest);
    else if (cmd === 'REM') {
      const r = rest.match(/^(\S+)\s+(.*)$/);
      if (!r) continue;
      const key = r[1].toUpperCase();
      const val = unquote(r[2]);
      if (key === 'DATE') sheet.date = val;
      else if (key === 'GENRE') sheet.genre = val;
      else if (key === 'DISCNUMBER') sheet.discNumber = Number(val) || undefined;
      else if (key === 'TOTALDISCS' || key === 'DISCTOTAL') sheet.totalDiscs = Number(val) || undefined;
    }
  }
  sheet.files = sheet.files.filter((f) => f.tracks.length);
  return sheet;
}

/** The audio file a cue FILE entry means: exact, case-insensitive, same name with another extension, or the only image. */
export function resolveCueFile(cueDir: string, name: string, cuePath?: string): string | null {
  const base = path.basename(name.replace(/\\/g, '/'));
  const exact = path.join(cueDir, base);
  if (fs.existsSync(exact) && IMAGE_AUDIO_EXT.test(exact)) return exact;
  let entries: string[];
  try {
    entries = fs.readdirSync(cueDir);
  } catch {
    return null;
  }
  const audio = entries.filter((e) => IMAGE_AUDIO_EXT.test(e));
  const lower = base.toLowerCase();
  const stem = (s: string) => s.replace(/\.[^.]+$/, '').toLowerCase();
  const hit = audio.find((e) => e.toLowerCase() === lower) ?? audio.find((e) => stem(e) === stem(base)) ?? (cuePath ? audio.find((e) => stem(e) === stem(path.basename(cuePath))) : undefined);
  if (hit) return path.join(cueDir, hit);
  return audio.length === 1 ? path.join(cueDir, audio[0]) : null;
}

export interface CueImage {
  cue: string;
  sheet: CueSheet;
  encoding: string;
  /** Resolved audio file per cue FILE entry. */
  audio: string[];
  trackCount: number;
}

/** Cue sheets that describe album images (a FILE holding several tracks) whose audio is present. */
export function findCueImages(dir: string, depth = 3): CueImage[] {
  const out: CueImage[] = [];
  const walk = (d: string, level: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (level < depth && !e.name.startsWith('.') && e.name !== SPLIT_DIR) walk(p, level + 1);
        continue;
      }
      if (!/\.cue$/i.test(e.name)) continue;
      try {
        const { text, encoding } = decodeCueText(fs.readFileSync(p));
        const sheet = parseCue(text);
        // already-split albums ship a cue with one FILE per track: nothing to do
        if (!sheet.files.some((f) => f.tracks.length > 1)) continue;
        const audio = sheet.files.map((f) => resolveCueFile(d, f.name, p));
        if (audio.some((a) => !a)) continue;
        const resolved = audio as string[];
        if (out.some((o) => o.audio.some((a) => resolved.includes(a)))) continue; // two cues for one image (e.g. .flac.cue + .cue)
        out.push({ cue: p, sheet, encoding, audio: resolved, trackCount: sheet.files.reduce((n, f) => n + f.tracks.length, 0) });
      } catch {
        /* unreadable cue */
      }
    }
  };
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) walk(dir, 0);
  else if (/\.cue$/i.test(dir) || IMAGE_AUDIO_EXT.test(dir)) walk(path.dirname(dir), depth);
  return out;
}

/** Folder (inside a download) that split tracks are written to. */
export const SPLIT_DIR = 'rexarr-split';

const quote = (s: string) => `"${s.replace(/"/g, "'")}"`;

/** UTF-8 cue sheet with absolute FILE paths, as fre:ac needs it. */
export function normalisedCue(img: CueImage): string {
  const s = img.sheet;
  const lines: string[] = [];
  if (s.genre) lines.push(`REM GENRE ${quote(s.genre)}`);
  if (s.date) lines.push(`REM DATE ${s.date}`);
  if (s.discNumber) lines.push(`REM DISCNUMBER ${s.discNumber}`);
  if (s.totalDiscs) lines.push(`REM TOTALDISCS ${s.totalDiscs}`);
  if (s.catalog) lines.push(`CATALOG ${s.catalog}`);
  if (s.performer) lines.push(`PERFORMER ${quote(s.performer)}`);
  if (s.title) lines.push(`TITLE ${quote(s.title)}`);
  const ff = (n: number) => `${String(Math.floor(n / 75 / 60)).padStart(2, '0')}:${String(Math.floor(n / 75) % 60).padStart(2, '0')}:${String(n % 75).padStart(2, '0')}`;
  s.files.forEach((f, i) => {
    lines.push(`FILE ${quote(img.audio[i])} WAVE`);
    for (const t of f.tracks) {
      lines.push(`  TRACK ${String(t.number).padStart(2, '0')} AUDIO`);
      if (t.title) lines.push(`    TITLE ${quote(t.title)}`);
      if (t.performer) lines.push(`    PERFORMER ${quote(t.performer)}`);
      if (t.isrc) lines.push(`    ISRC ${t.isrc}`);
      if (t.pregap !== undefined && t.pregap < t.start) lines.push(`    INDEX 00 ${ff(t.pregap)}`);
      lines.push(`    INDEX 01 ${ff(t.start)}`);
    }
  });
  return `${lines.join('\n')}\n`;
}

/** Output folder name for an image: the album folder's name, so Lidarr can parse artist / album from it too. */
export function splitFolderFor(img: CueImage, root: string, multiple: boolean): string {
  const albumDir = path.basename(path.dirname(img.cue));
  const disc = multiple ? ` (${img.sheet.discNumber ? `Disc ${img.sheet.discNumber}` : path.basename(img.cue, path.extname(img.cue))})` : '';
  return path.join(root, SPLIT_DIR, `${albumDir}${disc}`.replace(/[/\\:*?"<>|]/g, '_'));
}

/**
 * Split one image into FLAC tracks with fre:ac (lossless; bit depth and sample rate kept). Returns the track files.
 * Album artist and disc number are added afterwards (fre:ac does not write them from a cue sheet).
 */
export async function splitCueImage(opts: { freac: string; ffmpeg: string; image: CueImage; outDir: string; hooks: RunHooks }): Promise<string[]> {
  const { image, outDir, hooks } = opts;
  fs.mkdirSync(outDir, { recursive: true });
  const cueCopy = path.join(outDir, '.rexarr-source.cue');
  fs.writeFileSync(cueCopy, normalisedCue(image));
  const expectedBytes = image.audio.reduce((n, a) => n + fs.statSync(a).size, 0);
  try {
    hooks.onLog(`Splitting ${path.basename(image.cue)} (${image.encoding}, ${image.trackCount} tracks) with fre:ac`);
    const before = new Set(fs.readdirSync(outDir));
    // FLAC output is roughly the size of a lossless image; good enough for a progress estimate
    await runTool(opts.freac, ['-e', 'flac', '-d', outDir, '-p', '<track> - <title>', '--', '-c', '8', cueCopy], hooks, { file: outDir, expectedBytes, step: 'Splitting cue image', from: 0, to: 95 });
    const tracks = fs
      .readdirSync(outDir)
      .filter((f) => !before.has(f) && /\.flac$/i.test(f))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((f) => path.join(outDir, f));
    if (tracks.length !== image.trackCount) throw new Error(`fre:ac wrote ${tracks.length} of ${image.trackCount} tracks`);
    const extra: string[] = [];
    if (image.sheet.performer) extra.push('-metadata', `ALBUMARTIST=${image.sheet.performer}`);
    if (image.sheet.discNumber) extra.push('-metadata', `DISCNUMBER=${image.sheet.discNumber}`);
    if (image.sheet.totalDiscs) extra.push('-metadata', `DISCTOTAL=${image.sheet.totalDiscs}`);
    if (image.sheet.catalog) extra.push('-metadata', `CATALOGNUMBER=${image.sheet.catalog}`);
    const cover = findCover(path.dirname(image.cue));
    for (const t of tracks) {
      if (!extra.length && !cover) break;
      const tmp = `${t}.tag.flac`;
      const args = ['-v', 'error', '-y', '-i', t, ...(cover ? ['-i', cover] : []), '-map', '0:a', ...(cover ? ['-map', '1:v', '-c:v', 'copy', '-disposition:v', 'attached_pic', '-metadata:s:v', 'comment=Cover (front)'] : []), '-c:a', 'copy', '-map_metadata', '0', ...extra, tmp];
      await run(opts.ffmpeg, args, { timeout: 120_000 }).then(
        () => fs.renameSync(tmp, t),
        (e: Error) => {
          fs.rmSync(tmp, { force: true });
          hooks.onLog(`Tagging ${path.basename(t)} failed: ${e.message.split('\n')[0]}`);
        },
      );
    }
    // keep the cover next to the tracks for Lidarr / players
    if (cover) fs.copyFileSync(cover, path.join(outDir, `cover${path.extname(cover).toLowerCase()}`));
    hooks.onProgress(100, 'Split');
    return tracks;
  } finally {
    fs.rmSync(cueCopy, { force: true });
  }
}

function findCover(dir: string): string | undefined {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  const imgs = entries.filter((e) => /\.(jpe?g|png)$/i.test(e));
  return (
    ['cover', 'folder', 'front', 'albumart'].map((n) => imgs.find((e) => e.toLowerCase().startsWith(n))).find(Boolean) ??
    (imgs.length === 1 ? imgs[0] : undefined)
  )?.replace(/^/, `${dir}${path.sep}`);
}
