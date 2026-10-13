/**
 * Reading bitmap subtitles.
 *
 * A DVD, a Blu-ray and a DVB broadcast all carry their subtitles as pictures rather than words: dvd_subtitle,
 * hdmv_pgs_subtitle, dvb_subtitle, xsub. Nothing in FFmpeg turns a picture into text - its subtitle encoders go
 * text to text or bitmap to bitmap and say so - so a bitmap track cannot be converted by a codec switch, and
 * MP4 and WebM, which cannot carry bitmap subtitles at all, simply lose it.
 *
 * What FFmpeg will do is hand the pictures over. Used as a filter input, a bitmap subtitle stream becomes a
 * video stream that emits one frame each time the subtitle changes - one when a line appears, one when it
 * clears - and nothing in between. With `-fps_mode passthrough -frame_pts 1` every frame is written as a PNG
 * named after its own timestamp, so a feature film is a few thousand files rather than a few hundred thousand,
 * and each cue's start and end is read off the stream rather than sampled.
 *
 * `format=gray,negate` is what makes them readable. A subtitle is light text with a dark outline over nothing,
 * which flattens to white on black, and Tesseract wants the other way round. Negated, the fill becomes black
 * text while the outline and the empty background both go white - and the frames where the line has cleared
 * come out blank, which is how the end of a cue is known.
 *
 * Tesseract then reads the lot in one go: given a file listing the images it loads its model once and prints
 * the pages separated by form feeds, which is far faster than a process per cue.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);

/** Subtitle codecs that are pictures. Everything else is already text and needs none of this. */
const BITMAP_SUB_CODECS = new Set(['dvd_subtitle', 'hdmv_pgs_subtitle', 'dvb_subtitle', 'xsub', 'dvbsub', 'pgssub']);

export function isBitmapSubtitle(s: { codec_name: string }): boolean {
  return BITMAP_SUB_CODECS.has(s.codec_name);
}

/** Where Tesseract usually is, for when the setting is left empty. */
const CANDIDATES = [
  '/opt/homebrew/bin/tesseract',
  '/usr/local/bin/tesseract',
  '/usr/bin/tesseract',
  '/app/bin/tesseract',
  'C:\\Program Files\\Tesseract-OCR\\tesseract.exe',
  'C:\\Program Files (x86)\\Tesseract-OCR\\tesseract.exe',
];

export function resolveTesseract(configured: string): string {
  if (configured.trim()) return configured.trim();
  return CANDIDATES.find((c) => fsSync.existsSync(c)) ?? 'tesseract';
}

export interface TesseractInfo {
  available: boolean;
  path: string;
  version?: string;
  /** The models it has, as Tesseract names them (`eng`, `deu`, `chi_sim`). */
  languages: string[];
  error?: string;
}

let cached: { key: string; at: number; info: TesseractInfo } | null = null;

/** What Tesseract this machine has, if any. Cached, like the fre:ac check, since nothing asks it often. */
export async function tesseractInfo(configured: string, force = false): Promise<TesseractInfo> {
  const bin = resolveTesseract(configured);
  if (!force && cached && cached.key === bin && Date.now() - cached.at < 10 * 60_000) return cached.info;
  const version = await tesseractVersion(bin);
  const info: TesseractInfo = version
    ? { available: true, path: bin, version, languages: await tesseractLanguages(bin) }
    : { available: false, path: bin, languages: [], error: `${bin} could not be run – install Tesseract, or set its path in Settings` };
  cached = { key: bin, at: Date.now(), info };
  return info;
}

/**
 * ISO 639-2 to the name Tesseract gives its model. Tesseract uses 639-2/T where the two forms differ, and its
 * own names for the Chinese scripts. Anything not listed is passed through, since the codes mostly agree.
 */
const TESSERACT_LANGUAGE: Record<string, string> = {
  alb: 'sqi', arm: 'hye', baq: 'eus', bur: 'mya', chi: 'chi_sim', cze: 'ces', dut: 'nld', fre: 'fra', geo: 'kat',
  ger: 'deu', gre: 'ell', ice: 'isl', mac: 'mkd', mao: 'mri', may: 'msa', per: 'fas', rum: 'ron', slo: 'slk',
  tib: 'bod', wel: 'cym', zho: 'chi_sim', und: 'eng',
};

export function tesseractLanguage(iso6392: string): string {
  return TESSERACT_LANGUAGE[iso6392] ?? iso6392;
}

export interface SubtitleCue {
  /** Milliseconds from the start of the file. */
  startMs: number;
  endMs: number;
  text: string;
}

export interface OcrResult {
  cues: SubtitleCue[];
  /** How many pictures were read, the blank ones that end a cue included. */
  frames: number;
  warnings: string[];
}

export interface OcrOptions {
  ffmpegPath: string;
  tesseractPath: string;
  /** The track's position among the subtitle streams (FFmpeg's `s:N`), not its index in the file. */
  subtitleIndex: number;
  /** Tesseract model name, e.g. `eng`. Pass what `tesseractLanguage()` returned. */
  language: string;
  /** Give up after this long; an hour is generous for a feature film. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called as each of the two long steps starts, for the job log. */
  onStep?: (what: string) => void;
}

/** Which models this Tesseract has. Empty when it could not be asked. */
export async function tesseractLanguages(tesseractPath: string): Promise<string[]> {
  try {
    const { stdout, stderr } = await run(tesseractPath, ['--list-langs'], { timeout: 20_000 });
    // the header goes to stderr on some builds and stdout on others
    return `${stdout}\n${stderr}`.split('\n').map((l) => l.trim()).filter((l) => l && !l.includes(' '));
  } catch {
    return [];
  }
}

export async function tesseractVersion(tesseractPath: string): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await run(tesseractPath, ['--version'], { timeout: 20_000 });
    return `${stdout}${stderr}`.split('\n')[0]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** An SRT body, ready to be muxed into the encode or written beside it. */
export function toSrt(cues: SubtitleCue[]): string {
  const stamp = (ms: number) => {
    const t = Math.max(0, Math.round(ms));
    const h = Math.floor(t / 3_600_000);
    const m = Math.floor(t / 60_000) % 60;
    const s = Math.floor(t / 1000) % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(t % 1000).padStart(3, '0')}`;
  };
  return cues.map((c, i) => `${i + 1}\n${stamp(c.startMs)} --> ${stamp(c.endMs)}\n${c.text}\n`).join('\n');
}

/**
 * Tidy what Tesseract read. It is confident about letters and careless about what a subtitle is full of: a
 * lone bar where an I was, a space before a comma, the odd empty line.
 */
function tidy(raw: string): string {
  return raw
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').replace(/\s+([,.!?;:])/g, '$1').replace(/^\|\s*/, 'I ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

/** Cues that say the same thing back to back are one cue: a line redrawn is not a line repeated. */
function merge(cues: SubtitleCue[]): SubtitleCue[] {
  const out: SubtitleCue[] = [];
  for (const c of cues) {
    const last = out[out.length - 1];
    if (last && last.text === c.text && c.startMs - last.endMs <= 200) last.endMs = c.endMs;
    else out.push({ ...c });
  }
  return out;
}

/**
 * Read one bitmap subtitle track into cues. The caller decides what becomes of them - muxed into the encode,
 * written beside it, or both.
 */
export async function ocrSubtitleStream(input: string, opts: OcrOptions): Promise<OcrResult> {
  const warnings: string[] = [];
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rexarr-ocr-'));
  try {
    opts.onStep?.('extracting the subtitle pictures');
    await run(
      opts.ffmpegPath,
      [
        '-v', 'error', '-nostdin', '-y',
        '-i', input,
        '-filter_complex', `[0:s:${opts.subtitleIndex}]format=gray,negate[v]`,
        '-map', '[v]',
        '-fps_mode', 'passthrough',
        '-frame_pts', '1',
        path.join(dir, '%d.png'),
      ],
      { timeout: opts.timeoutMs ?? 3_600_000, signal: opts.signal, maxBuffer: 8 * 1024 * 1024 },
    );

    // the file names are the timestamps, in microseconds, so they sort into the order the lines appeared
    const frames = (await fs.readdir(dir))
      .filter((f) => f.endsWith('.png'))
      .map((f) => ({ file: path.join(dir, f), us: Number(f.slice(0, -4)) }))
      .filter((f) => Number.isFinite(f.us))
      .sort((a, b) => a.us - b.us);
    if (!frames.length) return { cues: [], frames: 0, warnings: ['the subtitle track held no pictures'] };

    opts.onStep?.(`reading ${frames.length} pictures with Tesseract`);
    const listFile = path.join(dir, 'images.txt');
    await fs.writeFile(listFile, frames.map((f) => f.file).join('\n'));
    const { stdout } = await run(
      opts.tesseractPath,
      [listFile, 'stdout', '-l', opts.language, '--psm', '6'],
      { timeout: opts.timeoutMs ?? 3_600_000, signal: opts.signal, maxBuffer: 64 * 1024 * 1024 },
    );
    // one page per image, in the order they were listed, separated by form feeds
    const pages = stdout.split('\f');
    if (pages.length < frames.length) warnings.push(`Tesseract read ${pages.length} of ${frames.length} pictures`);

    const cues: SubtitleCue[] = [];
    frames.forEach((f, i) => {
      const text = tidy(pages[i] ?? '');
      if (!text) return; // a blank picture is the line clearing, which is what ended the cue before it
      // the next picture is when this line goes away; the last one gets a sensible few seconds
      const end = frames[i + 1]?.us ?? f.us + 3_000_000;
      cues.push({ startMs: Math.round(f.us / 1000), endMs: Math.round(end / 1000), text });
    });
    return { cues: merge(cues), frames: frames.length, warnings };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
