import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AudioEncoder, FfmpegCapabilities, VideoEncoder } from '../../../shared/types.js';
import { AUDIO_ENCODER_INFO, VIDEO_ENCODER_INFO } from '../../../shared/presets.js';

const run = promisify(execFile);

let cache: { path: string; caps: FfmpegCapabilities; at: number } | null = null;

export async function ffmpegCapabilities(ffmpegPath: string, force = false): Promise<FfmpegCapabilities> {
  if (!force && cache && cache.path === ffmpegPath && Date.now() - cache.at < 5 * 60_000) return cache.caps;
  const caps: FfmpegCapabilities = { available: false, version: '', path: ffmpegPath, videoEncoders: [], audioEncoders: [], hwaccels: [] };
  try {
    const { stdout: v } = await run(ffmpegPath, ['-version'], { timeout: 10_000 });
    caps.version = v.split('\n')[0]?.replace(/^ffmpeg version\s+/, '').split(' ')[0] ?? '';
    const { stdout: enc } = await run(ffmpegPath, ['-hide_banner', '-encoders'], { timeout: 10_000 });
    const names = new Set(
      enc
        .split('\n')
        .map((l) => l.trim().match(/^[VASFXBD.]{6}\s+(\S+)/)?.[1])
        .filter((n): n is string => Boolean(n)),
    );
    caps.videoEncoders = (Object.keys(VIDEO_ENCODER_INFO) as VideoEncoder[]).filter((e) => e === 'copy' || names.has(e));
    caps.audioEncoders = (Object.keys(AUDIO_ENCODER_INFO) as AudioEncoder[]).filter((e) => e === 'copy' || names.has(e));
    try {
      const { stdout: hw } = await run(ffmpegPath, ['-hide_banner', '-hwaccels'], { timeout: 10_000 });
      caps.hwaccels = hw.split('\n').slice(1).map((l) => l.trim()).filter(Boolean);
    } catch {
      /* optional */
    }
    caps.available = true;
  } catch (err) {
    caps.error = (err as Error).message;
  }
  cache = { path: ffmpegPath, caps, at: Date.now() };
  return caps;
}
