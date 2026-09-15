import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { HwAccel, HwDevices, HwTestResult, Profile, VideoEncoder } from '../../../shared/types.js';
import { BUILTIN_PROFILES, HW_ACCEL_INFO } from '../../../shared/presets.js';
import { PATHS } from '../config.js';
import { store } from '../store.js';
import { ffmpegCapabilities } from '../ffmpeg/capabilities.js';
import { buildFfmpegArgs } from '../ffmpeg/args.js';
import { runFfmpeg } from '../ffmpeg/runner.js';
import type { ProbeResult } from '../ffmpeg/probe.js';

const run = promisify(execFile);
const VENDORS: Record<string, string> = { '0x8086': 'Intel', '0x1002': 'AMD', '0x10de': 'NVIDIA', '0x1af4': 'VirtIO' };
const METHODS = Object.keys(HW_ACCEL_INFO) as HwAccel[];

async function detectDevices(): Promise<HwDevices> {
  const caps = await ffmpegCapabilities(store.settings.ffmpegPath);
  const renderNodes: HwDevices['renderNodes'] = [];
  if (process.platform === 'linux' && fs.existsSync('/dev/dri')) {
    for (const name of fs.readdirSync('/dev/dri').filter((n) => n.startsWith('renderD')).sort()) {
      const sys = `/sys/class/drm/${name}/device`;
      let driver: string | undefined;
      let vendor: string | undefined;
      try {
        driver = path.basename(fs.readlinkSync(`${sys}/driver`));
      } catch {
        /* not exposed (common in containers) */
      }
      try {
        const id = fs.readFileSync(`${sys}/vendor`, 'utf8').trim();
        vendor = VENDORS[id] ?? id;
      } catch {
        /* ignore */
      }
      renderNodes.push({ path: `/dev/dri/${name}`, driver, vendor });
    }
  }
  const nvidiaGpus: HwDevices['nvidiaGpus'] = [];
  try {
    const { stdout } = await run('nvidia-smi', ['-L'], { timeout: 5000 });
    for (const line of stdout.split('\n')) {
      const m = line.match(/^GPU (\d+): (.+?)(?: \(UUID|$)/);
      if (m) nvidiaGpus.push({ index: Number(m[1]), name: m[2] });
    }
  } catch {
    /* no NVIDIA driver */
  }
  const encoders = Object.fromEntries(METHODS.map((m) => [m, Object.values(HW_ACCEL_INFO[m].encoders).filter((e) => caps.videoEncoders.includes(e as VideoEncoder)) as VideoEncoder[]])) as Record<HwAccel, VideoEncoder[]>;
  return { platform: process.platform, renderNodes, nvidiaGpus, encoders };
}

/** Synthetic 1080p H.264 source used to exercise the encoder without a real file. */
function testProbe(): ProbeResult {
  const video = { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, pix_fmt: 'yuv420p', tags: {} } as ProbeResult['streams'][number];
  return { path: 'testsrc2', durationSeconds: 3, sizeBytes: 0, bitRate: 0, formatName: 'lavfi', streams: [video], video, audio: [], subtitles: [], attachments: [], isHdr: false, isDolbyVision: false, frameRate: 24 };
}

async function testEncode(t: { hardwareAcceleration: HwAccel; device: string; hardwareDecoding: boolean }): Promise<HwTestResult> {
  const settings = store.settings;
  const caps = await ffmpegCapabilities(settings.ffmpegPath);
  const base = BUILTIN_PROFILES.find((p) => p.id === 'builtin-movie-1080p')!;
  // HEVC 10-bit at a fast preset: representative of real profiles but quick to run.
  const profile: Profile = { ...base, video: { ...base.video, preset: 'fast', maxHeight: 0, extraArgs: '' }, subtitles: { ...base.subtitles, mode: 'none' } };
  fs.mkdirSync(PATHS.transcodes, { recursive: true });
  const log: string[] = [];
  let durationMs = 0;
  let fps = 0;
  let last: { ok: boolean; encoder?: string; command: string; error?: string } = { ok: false, command: '' };
  let note: string | undefined;
  // Same retry as real jobs: VideoToolbox on some Macs / ffmpeg builds rejects constant-quality mode.
  for (const forceBitrate of [undefined, 0] as (number | undefined)[]) {
    const out = path.join(PATHS.transcodes, `hwtest-${Date.now()}.mkv`);
    const built = buildFfmpegArgs(profile, testProbe(), 'testsrc2', out, { hardware: { ...t, fallbackToSoftware: false }, availableEncoders: caps.available ? caps.videoEncoders : undefined, lavfiSeconds: 3, forceBitrate });
    const command = [settings.ffmpegPath, ...built.args].join(' ');
    log.push(...built.warnings.map((w) => `Warning: ${w}`), ...built.summary);
    if (t.hardwareAcceleration !== 'none' && !built.hardware) {
      return { ok: false, method: t.hardwareAcceleration, encoder: built.videoEncoder, durationMs: 0, command, error: built.warnings[0] ?? 'Hardware encoding could not be used', log };
    }
    const started = Date.now();
    let rejected = false;
    const handle = runFfmpeg(settings.ffmpegPath, built.args, 3, (p) => (fps = p.fps || fps), (line) => {
      if (/qscale not available|not available for encoder/i.test(line)) rejected = true;
      log.push(line);
    });
    const timer = setTimeout(() => handle.cancel(), 60_000);
    const { code } = await handle.done;
    clearTimeout(timer);
    durationMs = Date.now() - started;
    const size = fs.existsSync(out) ? fs.statSync(out).size : 0;
    fs.rmSync(out, { force: true });
    const ok = code === 0 && size > 0;
    const errorLine = log.find((l) => /\berror\b/i.test(l) && !/^Warning:/.test(l)) ?? [...log].reverse().find((l) => /failed|cannot|not supported|no device|invalid/i.test(l));
    last = { ok, encoder: built.videoEncoder, command, error: ok ? undefined : (errorLine ?? `ffmpeg exited with code ${code}`).replace(/^\[[^\]]*\]\s*/, '') };
    if (ok || !rejected || forceBitrate !== undefined) break;
    note = 'Constant-quality mode is not supported here, so jobs use bitrate mode for this encoder';
    log.push(`-- ${note}; retrying --`);
    fps = 0;
  }
  return { ok: last.ok, method: t.hardwareAcceleration, encoder: last.encoder, fps: fps || undefined, durationMs, command: last.command, error: last.error, note: last.ok ? note : undefined, log: log.slice(-80) };
}

export default async function transcodingRoutes(app: FastifyInstance) {
  app.get('/api/transcoding/devices', async () => detectDevices());

  app.post('/api/transcoding/test', async (req, reply) => {
    const body = z
      .object({
        hardwareAcceleration: z.enum(['none', 'amf', 'nvenc', 'qsv', 'vaapi', 'rkmpp', 'videotoolbox', 'v4l2']),
        device: z.string().max(200).default(''),
        hardwareDecoding: z.boolean().default(false),
      })
      .safeParse(req.body ?? store.settings.transcoding);
    if (!body.success) return reply.code(400).send({ error: 'invalid body' });
    return testEncode(body.data);
  });
}
