/**
 * fre:ac (freaccmd) – the audio backend for music profiles and CD ripping.
 *
 * Only open-source fre:ac encoders are used: libFLAC, LAME, libopus, libvorbis, WavPack and Monkey's Audio
 * (never Core Audio / FDK-AAC). fre:ac copies tags and cover art from the input file. What its command line cannot
 * do is done around it with FFmpeg:
 *
 *   1. resample / reduce bit depth (soxr + triangular dither) into an intermediate FLAC, only when the profile asks
 *   2. freaccmd -e <encoder> -o <out> -- <encoder options> <input>
 *   3. ReplayGain tags (fre:ac drops them) written by a stream-copy remux – no re-encode
 *
 * CD tracks are read by fre:ac's paranoia reader through its device://cdda:<drive>/<track> input.
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Profile } from '../../../shared/types.js';

const run = promisify(execFile);

export interface FreacInfo {
  available: boolean;
  path: string;
  version?: string;
  encoders: string[];
  error?: string;
}

/** Encoders rexarr will use: all open source. */
export const OPEN_ENCODERS = ['flac', 'lame', 'opus', 'vorbis', 'wv', 'mac'] as const;

const CANDIDATES = ['/Applications/freac.app/Contents/MacOS/freaccmd', '/usr/bin/freaccmd', '/usr/local/bin/freaccmd', '/opt/freac/freaccmd', '/app/bin/freaccmd', 'freaccmd'];

let cached: { key: string; at: number; info: FreacInfo } | null = null;

export function resolveFreac(configured: string): string {
  if (configured.trim()) return configured.trim();
  return CANDIDATES.find((c) => c.includes('/') && fs.existsSync(c)) ?? 'freaccmd';
}

export async function freacInfo(configured: string, force = false): Promise<FreacInfo> {
  const bin = resolveFreac(configured);
  if (!force && cached && cached.key === bin && Date.now() - cached.at < 10 * 60_000) return cached.info;
  let info: FreacInfo;
  try {
    // --help exits non-zero; its text is what we need
    const out = await run(bin, ['--help'], { timeout: 20_000, maxBuffer: 1024 * 1024 }).then(
      (r) => `${r.stdout}${r.stderr}`,
      (e: { stdout?: string; stderr?: string; code?: string }) => {
        if (e.code === 'ENOENT') throw new Error(`freaccmd not found at "${bin}"`);
        return `${e.stdout ?? ''}${e.stderr ?? ''}`;
      },
    );
    const version = out.match(/fre:ac[^\n]*?v(\d+\.\d+(?:\.\d+)?)/)?.[1];
    const list = out.match(/Encoder <id> can be one of:\s*([\s\S]+?)(?:\n\s*\n|$)/)?.[1] ?? '';
    const encoders = list.split(/[,\s]+/).map((e) => e.trim()).filter(Boolean);
    info = version ? { available: true, path: bin, version, encoders } : { available: false, path: bin, encoders: [], error: 'freaccmd did not identify itself' };
  } catch (err) {
    info = { available: false, path: bin, encoders: [], error: (err as Error).message };
  }
  cached = { key: bin, at: Date.now(), info };
  return info;
}

/** fre:ac encoder id and options for a music profile. */
export function freacEncoderArgs(profile: Profile): { encoder: string; options: string[]; ext: string } {
  const a = profile.audio;
  switch (a.encoder) {
    case 'flac':
      return { encoder: 'flac', options: ['-c', String(Math.min(8, Math.max(0, a.compressionLevel ?? 8)))], ext: 'flac' };
    case 'libmp3lame':
      if (a.vbrQuality !== undefined && a.vbrQuality !== null) return { encoder: 'lame', options: ['-m', 'VBR', '-q', String(Math.min(9, Math.max(0, a.vbrQuality)))], ext: 'mp3' };
      return { encoder: 'lame', options: ['-m', 'CBR', '-b', String(Math.min(320, Math.max(8, a.bitrate || 320)))], ext: 'mp3' };
    case 'libopus':
      return { encoder: 'opus', options: ['--bitrate', String(Math.min(510, Math.max(6, a.bitrate || 160))), '--comp', String(Math.min(10, Math.max(0, a.opusComplexity ?? 10)))], ext: 'opus' };
    case 'libvorbis':
      // fre:ac's Vorbis quality is 0–100; profiles use the familiar -q 0–10 scale
      if (a.vbrQuality !== undefined && a.vbrQuality !== null) return { encoder: 'vorbis', options: ['-q', String(Math.min(100, Math.max(0, Math.round(a.vbrQuality * 10))))], ext: 'ogg' };
      return { encoder: 'vorbis', options: ['-b', String(Math.min(500, Math.max(45, a.bitrate || 192)))], ext: 'ogg' };
    case 'wavpack':
      return { encoder: 'wv', options: [], ext: 'wv' }; // default: high quality mode
    case 'ape':
      return { encoder: 'mac', options: ['-m', 'high'], ext: 'ape' };
    default:
      throw new Error(`${a.encoder} is not a fre:ac encoder; music profiles use FLAC, MP3 (LAME), Opus, Vorbis, WavPack or Monkey's Audio`);
  }
}

export interface AudioProbe {
  codec: string;
  sampleRate: number;
  bitDepth: number;
  channels: number;
  durationSeconds: number;
  lossless: boolean;
  hasCover: boolean;
  tags: Record<string, string>;
}

export async function probeAudio(ffprobe: string, file: string): Promise<AudioProbe> {
  const { stdout } = await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  const j = JSON.parse(stdout) as { format?: { duration?: string; tags?: Record<string, string> }; streams?: { codec_type: string; codec_name: string; sample_rate?: string; bits_per_raw_sample?: string; bits_per_sample?: number; sample_fmt?: string; channels?: number; disposition?: { attached_pic?: number }; tags?: Record<string, string> }[] };
  const a = j.streams?.find((s) => s.codec_type === 'audio');
  if (!a) throw new Error('No audio stream');
  const depth = Number(a.bits_per_raw_sample) || a.bits_per_sample || (a.sample_fmt?.startsWith('s16') ? 16 : a.sample_fmt?.startsWith('s32') ? 24 : 0);
  const tags = { ...(a.tags ?? {}), ...(j.format?.tags ?? {}) };
  return {
    codec: a.codec_name,
    sampleRate: Number(a.sample_rate) || 44100,
    bitDepth: depth,
    channels: a.channels ?? 2,
    durationSeconds: Number(j.format?.duration) || 0,
    lossless: ['flac', 'alac', 'wavpack', 'ape', 'tta', 'mlp', 'truehd', 'wmalossless', 'shorten'].includes(a.codec_name) || a.codec_name.startsWith('pcm_'),
    hasCover: Boolean(j.streams?.some((s) => s.disposition?.attached_pic === 1)),
    tags,
  };
}

let soxrAvailable: boolean | null = null;
async function hasSoxr(ffmpeg: string) {
  if (soxrAvailable === null) soxrAvailable = await run(ffmpeg, ['-hide_banner', '-buildconf'], { timeout: 10_000 }).then((r) => /enable-libsoxr/.test(r.stdout + r.stderr), () => false);
  return soxrAvailable;
}

/** Loudness scan with FFmpeg's replaygain filter. */
export async function replayGain(ffmpeg: string, file: string): Promise<{ gain: string; peak: string } | null> {
  return new Promise((resolve) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-i', file, '-map', '0:a:0', '-af', 'replaygain', '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const gain = err.match(/track_gain = ([+-]?\d+(?:\.\d+)?) dB/)?.[1];
      const peak = err.match(/track_peak = (\d+(?:\.\d+)?)/)?.[1];
      resolve(gain && peak ? { gain: `${Number(gain) >= 0 ? '+' : ''}${Number(gain).toFixed(2)} dB`, peak: Number(peak).toFixed(6) } : null);
    });
  });
}

export interface RunHooks {
  onLog: (line: string) => void;
  /** 0–100 */
  onProgress: (percent: number, step: string) => void;
  signal?: { cancelled: boolean; kill?: () => void };
}

/** A fre:ac run that reported every file as done and then died from a segfault on exit. */
export function crashedAfterDone(bin: string, code: number | null, signal: NodeJS.Signals | null, output: string): boolean {
  if (!/freac/i.test(path.basename(bin))) return false;
  if (signal !== 'SIGSEGV' && code !== 139) return false;
  // output arrives in chunks, so "...done." may have landed on its own line
  const started = output.match(/Processing file: /g)?.length ?? 0;
  const done = output.match(/\.\.\.\s*done\./g)?.length ?? 0;
  return started > 0 && done >= started && !/\.\.\.\s*failed|^\s*(error\b|could not|file not found|aborted\.)/im.test(output);
}

export function runTool(bin: string, args: string[], hooks: RunHooks, estimate?: { file: string; expectedBytes: number; step: string; from: number; to: number }): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    if (hooks.signal) hooks.signal.kill = () => child.kill('SIGTERM');
    let tail = '';
    const onData = (d: Buffer) => {
      for (const line of d.toString().split(/\r?\n/)) {
        const l = line.trim();
        if (!l || l.startsWith('++ WARN: cdio_get_default_device')) continue;
        tail = `${tail}\n${l}`.slice(-2000);
        hooks.onLog(l);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    // fre:ac prints no percentage: estimate from the growing output file
    const timer = estimate
      ? setInterval(() => {
          try {
            const st = fs.statSync(estimate.file);
            // a directory (cue split): everything written into it so far
            const size = st.isDirectory() ? fs.readdirSync(estimate.file).reduce((n, f) => n + (fs.statSync(path.join(estimate.file, f)).size || 0), 0) : st.size;
            const frac = Math.min(0.97, size / Math.max(1, estimate.expectedBytes));
            hooks.onProgress(estimate.from + (estimate.to - estimate.from) * frac, estimate.step);
          } catch {
            /* not created yet */
          }
        }, 1000)
      : null;
    child.on('error', (e) => {
      if (timer) clearInterval(timer);
      reject(e);
    });
    child.on('close', (code, signal) => {
      if (timer) clearInterval(timer);
      if (hooks.signal?.cancelled) return reject(new Error('cancelled'));
      if (code === 0) resolve();
      // fre:ac on musl (the Alpine Docker image) segfaults in a component destructor after finishing its work
      else if (crashedAfterDone(bin, code, signal, tail)) {
        hooks.onLog(`${path.basename(bin)} crashed on exit after finishing (${signal ?? code}); output kept`);
        resolve();
      }
      else reject(new Error(`${path.basename(bin)} ${code === null ? `was killed (${signal})` : `exited with ${code}`}${tail ? `: ${tail.trim().split('\n').slice(-2).join(' ')}` : ''}`));
    });
  });
}

export interface MusicEncodeResult {
  /** Encoded file (temporary path passed in). */
  output: string;
  steps: string[];
  replayGain?: { gain: string; peak: string };
}

/**
 * Encode one music file with fre:ac according to a music profile.
 * `output` must end with the profile's extension; intermediates go next to it.
 */
export async function encodeMusic(opts: { freac: string; ffmpeg: string; ffprobe: string; profile: Profile; input: string; output: string; info: AudioProbe; preserveBitPerfect: boolean; hooks: RunHooks }): Promise<MusicEncodeResult> {
  const { profile, input, output, info, hooks } = opts;
  const a = profile.audio;
  const steps: string[] = [];
  const enc = freacEncoderArgs(profile);
  const work: string[] = [];
  let source = input;
  try {
    // 1. DSP (FFmpeg): only when the profile needs a lower rate / depth and the source is not to be kept bit-perfect
    // Opus only takes 8–48 kHz rates: resample here with soxr rather than rely on fre:ac's resampler component,
    // which some builds (Alpine, so the Docker image) do not include
    const opusRate = a.encoder === 'libopus' && ![8000, 12000, 16000, 24000, 48000].includes(info.sampleRate) ? 48000 : 0;
    const wantRate = opusRate || (a.maxSampleRate && info.sampleRate > a.maxSampleRate ? a.maxSampleRate : 0);
    const wantDepth = a.bitDepth && info.bitDepth > a.bitDepth ? a.bitDepth : 0;
    const lossyTarget = !['flac', 'wavpack', 'ape'].includes(a.encoder);
    const needsDsp = Boolean(opusRate) || (!opts.preserveBitPerfect && (wantRate || (wantDepth && !lossyTarget)));
    if (needsDsp) {
      const soxr = await hasSoxr(opts.ffmpeg);
      const filters: string[] = [];
      if (wantRate || wantDepth) filters.push(`aresample=${wantRate ? `osr=${wantRate}:` : ''}${soxr ? 'resampler=soxr:precision=28:' : 'filter_size=64:cutoff=0.97:'}dither_method=triangular`);
      const tmp = `${output}.dsp.flac`;
      work.push(tmp);
      const sampleFmt = (wantDepth || info.bitDepth) === 16 ? 's16' : 's32';
      const args = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-i', input, '-map', '0:a:0', '-map', '0:v?', '-c:v', 'copy', '-af', filters.join(','), '-sample_fmt', sampleFmt, '-c:a', 'flac', '-compression_level', '0', '-map_metadata', '0'];
      if (sampleFmt === 's32') args.push('-bits_per_raw_sample', '24');
      args.push(tmp);
      const label = `${wantRate ? `${info.sampleRate / 1000} → ${wantRate / 1000} kHz` : ''}${wantRate && wantDepth ? ', ' : ''}${wantDepth ? `${info.bitDepth} → ${wantDepth} bit (dithered)` : ''}`;
      hooks.onProgress(2, `Resampling ${label}`);
      await runTool(opts.ffmpeg, args, hooks);
      steps.push(`FFmpeg ${soxr ? 'soxr' : 'swr'}: ${label}`);
      source = tmp;
    }

    // 2. fre:ac
    const cover = a.embedCover === false ? ['--ignore-coverart'] : [];
    const expected = lossyTarget ? ((a.bitrate || 245) * 1000 * info.durationSeconds) / 8 : fs.statSync(source).size * 0.6;
    await runTool(opts.freac, ['-e', enc.encoder, ...cover, '-o', output, '--', ...enc.options, source], hooks, { file: output, expectedBytes: expected, step: `fre:ac ${enc.encoder}`, from: needsDsp ? 20 : 3, to: 92 });
    steps.push(`fre:ac ${enc.encoder} ${enc.options.join(' ')}`);
    if (!fs.existsSync(output) || !fs.statSync(output).size) throw new Error('fre:ac produced no output');

    // 3. ReplayGain + cover fix-up (FFmpeg scan, then a stream-copy remux – audio is never re-encoded)
    let rg: { gain: string; peak: string } | undefined;
    const canRetag = ['flac', 'mp3', 'opus'].includes(enc.ext); // FFmpeg cannot rewrite WavPack, APE or Vorbis-with-artwork tags without dropping the artwork
    if (a.replayGain && canRetag) {
      hooks.onProgress(94, 'ReplayGain');
      rg = (await replayGain(opts.ffmpeg, output)) ?? undefined;
    } else if (a.replayGain) steps.push(`ReplayGain tags are not written to .${enc.ext} files (would drop the embedded artwork)`);
    // fre:ac's MP3 picture frame has no MIME type, which FFmpeg and some players ignore: re-embed the source cover
    const fixCover = enc.ext === 'mp3' && a.embedCover !== false && info.hasCover;
    if (rg || fixCover) {
      const tagged = `${output}.tag.${enc.ext}`;
      work.push(tagged);
      const withCover = a.embedCover !== false && info.hasCover && enc.ext !== 'opus';
      const args = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-i', output];
      if (withCover) args.push('-i', input, '-map', '0:a', '-map', '1:v:0', '-disposition:v:0', 'attached_pic');
      else args.push('-map', '0:a');
      args.push('-c', 'copy', '-map_metadata', '0');
      if (rg) args.push('-metadata', `REPLAYGAIN_TRACK_GAIN=${rg.gain}`, '-metadata', `REPLAYGAIN_TRACK_PEAK=${rg.peak}`);
      if (enc.ext === 'mp3') args.push('-id3v2_version', '3', '-write_id3v1', '1');
      args.push('-f', enc.ext, tagged);
      await runTool(opts.ffmpeg, args, hooks);
      fs.renameSync(tagged, output);
      if (rg) steps.push(`ReplayGain ${rg.gain}, peak ${rg.peak}`);
      if (fixCover) steps.push('Cover art re-embedded (ID3v2.3 APIC)');
    }
    hooks.onProgress(100, 'Done');
    return { output, steps, replayGain: rg };
  } finally {
    for (const f of work) fs.rmSync(f, { force: true });
  }
}

/** Rip one CD track to FLAC with fre:ac's paranoia reader. */
export function ripCdTrack(opts: { freac: string; driveIndex: number; track: number; output: string; compressionLevel: number; expectedBytes: number; hooks: RunHooks }) {
  return runTool(opts.freac, ['-e', 'flac', '-o', opts.output, '--', '-c', String(Math.min(8, Math.max(0, opts.compressionLevel))), `device://cdda:${opts.driveIndex}/${opts.track}`], opts.hooks, {
    file: opts.output,
    expectedBytes: opts.expectedBytes,
    step: `Reading track ${opts.track}`,
    from: 0,
    to: 97,
  });
}
