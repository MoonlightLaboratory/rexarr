/**
 * Thin wrapper around `makemkvcon -r` (robot mode). Output is line based:
 *   DRV:index,state,enabled,flags,"drive name","disc label","/dev/path"
 *   CINFO:code,flags,"value"              disc attributes
 *   TINFO:title,code,flags,"value"        title attributes
 *   SINFO:title,stream,code,flags,"value" stream attributes
 *   PRGC/PRGT:code,id,"name"              current / total progress step names
 *   PRGV:current,total,max                progress values
 *   MSG:code,flags,count,"message",...
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import type { DiscDrive, DiscTitle, DriveState, MakemkvInfo } from '../../../shared/types.js';

const run = promisify(execFile);

// Attribute codes from MakeMKV's apdefs.h
const A = { type: 1, name: 2, langCode: 3, codecShort: 6, codecLong: 7, chapters: 8, duration: 9, sizeBytes: 11, channels: 14, sourceFile: 16, videoSize: 19, frameRate: 21, outputFile: 27, volumeName: 32 } as const;

const KNOWN_PATHS = ['/Applications/MakeMKV.app/Contents/MacOS/makemkvcon', '/usr/bin/makemkvcon', '/usr/local/bin/makemkvcon', 'C:\\Program Files (x86)\\MakeMKV\\makemkvcon64.exe', 'C:\\Program Files (x86)\\MakeMKV\\makemkvcon.exe'];

/** Resolve the makemkvcon binary: configured value first, then well-known install locations. */
export function resolveMakemkv(configured: string): string {
  if (configured && (configured.includes('/') || configured.includes('\\')) && fs.existsSync(configured)) return configured;
  for (const p of KNOWN_PATHS) if (fs.existsSync(p)) return p;
  return configured || 'makemkvcon';
}

let infoCache: { path: string; at: number; info: MakemkvInfo } | null = null;
export async function makemkvInfo(configured: string, force = false): Promise<MakemkvInfo> {
  const path = resolveMakemkv(configured);
  if (!force && infoCache && infoCache.path === path && Date.now() - infoCache.at < 5 * 60_000) return infoCache.info;
  let info: MakemkvInfo;
  try {
    // "info" with an invalid source still prints the version banner in robot mode.
    const { stdout } = await run(path, ['-r', '--cache=1', 'info', 'disc:9999'], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }).catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? '' }));
    const ver = stdout.match(/MakeMKV v?([\d.]+)/)?.[1];
    info = { available: true, path, version: ver };
  } catch (err) {
    info = { available: false, path, error: (err as Error).message };
  }
  infoCache = { path, at: Date.now(), info };
  return info;
}

/** Split a robot-mode CSV line into fields, honouring quotes. */
export function splitRobot(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function driveState(n: number): DriveState {
  switch (n) {
    case 0:
      return 'empty';
    case 1:
      return 'open';
    case 2:
      return 'loaded';
    case 3:
      return 'loading';
    default:
      return 'unknown';
  }
}

export function parseDrives(stdout: string): DiscDrive[] {
  const drives: DiscDrive[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('DRV:')) continue;
    const f = splitRobot(line.slice(4));
    const state = Number(f[1]);
    if (state === 256 || !f[6]) continue; // no drive
    drives.push({ index: Number(f[0]), state: driveState(state), name: f[4], discLabel: f[5] || undefined, path: f[6], source: `disc:${Number(f[0])}` });
  }
  return drives;
}

export async function listDrives(makemkv: string): Promise<DiscDrive[]> {
  const { stdout } = await run(makemkv, ['-r', '--cache=1', 'info', 'disc:9999'], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }).catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? '' }));
  return parseDrives(stdout);
}

export function parseDurationSeconds(s: string): number {
  const p = s.split(':').map(Number);
  if (p.some((n) => Number.isNaN(n))) return 0;
  return p.reduce((acc, n) => acc * 60 + n, 0);
}

export interface DiscInfo {
  type: 'bluray' | 'dvd' | 'unknown';
  name: string;
  volumeName: string;
  titles: DiscTitle[];
}

export function parseDiscInfo(stdout: string): DiscInfo {
  const disc: Record<number, string> = {};
  const titles = new Map<number, Record<number, string>>();
  const streams = new Map<number, Map<number, Record<number, string>>>();
  for (const line of stdout.split('\n')) {
    if (line.startsWith('CINFO:')) {
      const f = splitRobot(line.slice(6));
      disc[Number(f[0])] = f[2];
    } else if (line.startsWith('TINFO:')) {
      const f = splitRobot(line.slice(6));
      const t = Number(f[0]);
      if (!titles.has(t)) titles.set(t, {});
      titles.get(t)![Number(f[1])] = f[3];
    } else if (line.startsWith('SINFO:')) {
      const f = splitRobot(line.slice(6));
      const t = Number(f[0]);
      const sIdx = Number(f[1]);
      if (!streams.has(t)) streams.set(t, new Map());
      const ts = streams.get(t)!;
      if (!ts.has(sIdx)) ts.set(sIdx, {});
      ts.get(sIdx)![Number(f[2])] = f[4];
    }
  }
  const typeStr = (disc[A.type] ?? '').toLowerCase();
  const type = typeStr.includes('blu') ? 'bluray' : typeStr.includes('dvd') ? 'dvd' : 'unknown';
  const out: DiscTitle[] = [];
  for (const [id, t] of titles) {
    const ts = streams.get(id) ?? new Map();
    const audio: string[] = [];
    const subs: string[] = [];
    let videoCodec: string | undefined;
    let resolution: string | undefined;
    let frameRate: string | undefined;
    for (const s of ts.values()) {
      const kind = (s[A.type] ?? '').toLowerCase();
      if (kind === 'video') {
        videoCodec = s[A.codecShort];
        resolution = s[A.videoSize];
        frameRate = s[A.frameRate];
      } else if (kind === 'audio') audio.push([s[A.codecShort], s[A.channels] ? `${s[A.channels]}ch` : '', s[A.langCode]].filter(Boolean).join(' '));
      else if (kind === 'subtitles') subs.push([s[A.codecShort], s[A.langCode]].filter(Boolean).join(' '));
    }
    out.push({
      id,
      name: t[A.name] ?? `Title ${id}`,
      durationSeconds: parseDurationSeconds(t[A.duration] ?? '0'),
      sizeBytes: Number(t[A.sizeBytes] ?? 0),
      chapters: Number(t[A.chapters] ?? 0),
      fileName: t[A.outputFile] ?? `title_t${String(id).padStart(2, '0')}.mkv`,
      sourceFile: t[A.sourceFile],
      videoCodec,
      resolution,
      frameRate,
      audio,
      subtitles: subs,
    });
  }
  return { type, name: disc[A.name] ?? disc[A.volumeName] ?? '', volumeName: disc[A.volumeName] ?? '', titles: out.sort((a, b) => a.id - b.id) };
}

export async function readDisc(makemkv: string, source: string, minLengthSeconds: number): Promise<DiscInfo> {
  const { stdout } = await run(makemkv, ['-r', '--cache=1', `--minlength=${Math.max(0, Math.floor(minLengthSeconds))}`, 'info', source], { timeout: 15 * 60_000, maxBuffer: 64 * 1024 * 1024 }).catch((e: { stdout?: string; message?: string }) => {
    if (e.stdout) return { stdout: e.stdout };
    throw new Error(e.message ?? 'makemkvcon failed');
  });
  return parseDiscInfo(stdout);
}

export interface RipHandle {
  process: ChildProcess;
  done: Promise<number | null>;
  cancel: () => void;
}

/** Rip one title to a directory, streaming progress (0-100) and step names. */
export function ripTitle(
  makemkv: string,
  source: string,
  titleId: number,
  outDir: string,
  minLengthSeconds: number,
  onProgress: (percent: number, step: string) => void,
  onLog: (line: string) => void,
): RipHandle {
  const child = spawn(makemkv, ['-r', '--progress=-same', '--messages=-stdout', `--minlength=${Math.max(0, Math.floor(minLengthSeconds))}`, 'mkv', source, String(titleId), outDir], { stdio: ['ignore', 'pipe', 'pipe'] });
  let cancelled = false;
  let step = '';
  let buf = '';
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line.startsWith('PRGV:')) {
        const [, total, max] = line.slice(5).split(',').map(Number);
        if (max > 0) onProgress(Math.min(100, (total / max) * 100), step);
      } else if (line.startsWith('PRGC:') || line.startsWith('PRGT:')) {
        const f = splitRobot(line.slice(5));
        if (line.startsWith('PRGC:')) step = f[2];
        onLog(`${line.slice(0, 4)} ${f[2]}`);
      } else if (line.startsWith('MSG:')) {
        const f = splitRobot(line.slice(4));
        onLog(f[3]);
      }
    }
  });
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (d: string) => d.split('\n').filter(Boolean).forEach((l) => onLog(l.trim())));
  const done = new Promise<number | null>((resolve) => {
    child.on('error', (e) => {
      onLog(`spawn error: ${e.message}`);
      resolve(-1);
    });
    child.on('close', (code) => resolve(cancelled ? null : code));
  });
  return {
    process: child,
    done,
    cancel: () => {
      cancelled = true;
      child.kill('SIGTERM');
      setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 5000).unref();
    },
  };
}

/**
 * Virtual drives for testing: every .iso/.img file or DVD/Blu-ray folder (VIDEO_TS / BDMV) inside `dir`
 * is presented as a loaded drive. makemkvcon reads them through its iso: / file: sources.
 */
export function listVirtualDrives(dir: string): DiscDrive[] {
  if (!dir || !fs.existsSync(dir)) return [];
  const out: DiscDrive[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = `${dir.replace(/[\\/]+$/, '')}/${e.name}`;
    let source: string | null = null;
    if (e.isFile() && /\.(iso|img)$/i.test(e.name)) source = `iso:${full}`;
    else if (e.isDirectory() && (fs.existsSync(`${full}/VIDEO_TS`) || fs.existsSync(`${full}/BDMV`))) source = `file:${full}`;
    if (!source) continue;
    out.push({ index: 1000 + out.length, name: 'Virtual drive', path: full, state: 'loaded', discLabel: e.name.replace(/\.(iso|img)$/i, ''), source, virtual: true });
  }
  return out;
}

/** Describe a single image file or disc folder as a virtual drive, or null if it is not one. */
export function virtualDriveForPath(p: string, index = 2000, label?: string, virtualId?: string): DiscDrive | null {
  if (!p) return null;
  if (!fs.existsSync(p)) {
    // Linked drive whose image is gone (unmounted share, deleted file): show it as an empty tray.
    if (!virtualId) return null;
    const n = p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p;
    return { index, name: 'Virtual drive', path: p, state: 'empty', discLabel: label || n.replace(/\.(iso|img)$/i, ''), source: '', virtual: true, virtualId, available: false };
  }
  const st = fs.statSync(p);
  const name = p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p;
  const disp = label || name.replace(/\.(iso|img)$/i, '');
  if (st.isFile() && /\.(iso|img)$/i.test(name)) return { index, name: virtualId ? 'Virtual drive' : 'Disc image', path: p, state: 'loaded', discLabel: disp, source: `iso:${p}`, virtual: true, virtualId, available: true };
  if (st.isDirectory() && (fs.existsSync(`${p}/VIDEO_TS`) || fs.existsSync(`${p}/BDMV`))) return { index, name: virtualId ? 'Virtual drive' : 'Disc folder', path: p, state: 'loaded', discLabel: disp, source: `file:${p}`, virtual: true, virtualId, available: true };
  // A BDMV / VIDEO_TS folder itself was linked: use its parent as the disc root.
  if (st.isDirectory() && /^(BDMV|VIDEO_TS)$/i.test(name)) return virtualDriveForPath(p.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]+$/, ''), index, label, virtualId);
  return null;
}

/**
 * Disc images inside a finished download: .iso / .img files and disc folders (anything holding BDMV or VIDEO_TS),
 * searched a few levels deep. A download that is itself an image or disc folder returns just that.
 */
export function findDiscImages(p: string, depth = 3): string[] {
  if (!p || !fs.existsSync(p)) return [];
  const self = virtualDriveForPath(p, 0);
  if (self) return [self.path];
  const out: string[] = [];
  const walk = (dir: string, level: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const e of entries) {
      if (e.name.startsWith('.') || /^(sample|samples|extras?|featurettes)$/i.test(e.name)) continue;
      const full = `${dir.replace(/[\/]+$/, '')}/${e.name}`;
      if (e.isFile() && /\.(iso|img)$/i.test(e.name)) {
        // Skip samples and tiny images; real DVD images are gigabytes, Blu-rays far more.
        try {
          if (/sample/i.test(e.name) || fs.statSync(full).size < 5 * 1024 * 1024) continue;
        } catch {
          continue;
        }
        out.push(full);
      } else if (e.isDirectory()) {
        if (/^(BDMV|VIDEO_TS)$/i.test(e.name)) {
          if (!out.includes(dir)) out.push(dir);
        } else if (fs.existsSync(`${full}/BDMV`) || fs.existsSync(`${full}/VIDEO_TS`)) out.push(full);
        else if (level < depth) walk(full, level + 1);
      }
    }
  };
  if (fs.statSync(p).isDirectory()) walk(p, 1);
  return out;
}

/** Eject a drive using the platform tool. */
export async function ejectDrive(drivePath: string): Promise<void> {
  if (process.platform === 'darwin') {
    // a specific device (added by path) ejects by its disk node; otherwise the default drive
    if (/^\/dev\/r?disk\d+$/.test(drivePath)) await run('diskutil', ['eject', drivePath.replace('/dev/rdisk', '/dev/disk')], { timeout: 60_000 }).catch(() => run('drutil', ['eject'], { timeout: 60_000 }));
    else await run('drutil', ['eject'], { timeout: 60_000 });
  } else if (process.platform === 'win32') {
    await run('powershell', ['-NoProfile', '-Command', `(New-Object -comObject Shell.Application).Namespace(17).ParseName('${drivePath}').InvokeVerb('Eject')`], { timeout: 60_000 });
  } else {
    await run('eject', [drivePath], { timeout: 60_000 });
  }
}

/** Turn a disc label like "BLADE_RUNNER_2049" or "THE.OFFICE.S1.D2" into a search term. */
export function labelToTitle(label: string): { title: string; year?: number; season?: number; disc?: number } {
  let s = label.replace(/[_.]+/g, ' ').replace(/\s+/g, ' ').trim();
  let season: number | undefined;
  let disc: number | undefined;
  const sm = s.match(/\b(?:S|SEASON|SERIES)\s?(\d{1,2})\b/i);
  if (sm) season = Number(sm[1]);
  const dm = s.match(/\b(?:D|DISC|DISK)\s?(\d{1,2})\b/i);
  if (dm) disc = Number(dm[1]);
  s = s.replace(/\b(?:S|SEASON|SERIES)\s?\d{1,2}\b/gi, '').replace(/\b(?:D|DISC|DISK)\s?\d{1,2}\b/gi, '');
  s = s.replace(/\b(BLU-?RAY|BD|UHD|4K|DVD|WS|FS|NTSC|PAL|REGION\s?\w|SPECIAL EDITION|EXTENDED|DIRECTORS? CUT|VOL(UME)?\s?\d+)\b/gi, '');
  let year: number | undefined;
  const ym = s.match(/\b(19|20)\d{2}\b/);
  if (ym && Number(ym[0]) >= 1900 && Number(ym[0]) <= new Date().getFullYear() + 1) {
    year = Number(ym[0]);
    s = s.replace(ym[0], '');
  }
  // separators left behind by the removed parts ("Peach Girl – Disc 1", "Show - Season 2")
  s = s.replace(/(\s[-–—:,|]+)+(?=\s|$)/g, ' ').replace(/^[\s\-–—:,|]+|[\s\-–—:,|]+$/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  const title = s
    .toLowerCase()
    .split(' ')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
  return { title, year, season, disc };
}
