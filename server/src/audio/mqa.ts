/**
 * MQA detection (MQA-CD rips, MQA FLAC downloads).
 *
 * An MQA stream hides its signalling in the low bits of the PCM: XOR-ing the left and right channel at one bit
 * position yields a bit stream that carries a 36-bit sync word (0xBE0498C88). The stream is decoded to
 * left-aligned 32-bit samples, so the same scan covers 16- and 24-bit files: MQA-CD (16-bit) signals at
 * positions 16–23. After the sync, four bits describe the original (studio) sample rate.
 *
 * Detection is reliable; the original sample rate is decoded on a best-effort basis and left out when the value
 * is implausible. Nothing is decoded or "unfolded" – this only tells you the file is MQA, so it can be kept bit-perfect.
 */
import { spawn } from 'node:child_process';
import type { MqaInfo } from '../../../shared/types.js';

export const MQA_SYNC = 0xbe0498c88;
const MOD36 = 2 ** 36;

/** Original sample rate from the 4 bits after the sync: bit 0 picks the 44.1 / 48 kHz family, bits 1–3 (reversed) the multiplier. */
export function decodeOriginalSampleRate(code: number): number | undefined {
  const base = code & 1 ? 48000 : 44100;
  const exp = ((code >> 3) & 1) | (((code >> 2) & 1) << 1) | (((code >> 1) & 1) << 2);
  const rate = base * (1 << exp);
  return rate <= 768000 ? rate : undefined;
}

/** Scan interleaved left-aligned int32 stereo samples for the MQA sync word. */
export function detectMqaInSamples(interleaved: Int32Array, sampleRate: number): MqaInfo {
  const frames = Math.floor(interleaved.length / 2);
  const scannedSeconds = sampleRate ? frames / sampleRate : 0;
  for (let p = 16; p < 24; p++) {
    // a 36-bit shift register kept in a double (exact below 2^53), avoiding BigInt in the hot loop
    let buffer = 0;
    for (let i = 0; i < frames; i++) {
      const bit = ((interleaved[2 * i] ^ interleaved[2 * i + 1]) >>> p) & 1;
      buffer = (buffer * 2 + bit) % MOD36;
      if (buffer === MQA_SYNC) {
        let code = 0;
        if (i + 6 < frames) {
          for (let m = 3; m < 7; m++) {
            const b = ((interleaved[2 * (i + m)] ^ interleaved[2 * (i + m) + 1]) >>> p) & 1;
            code |= b << (6 - m);
          }
        }
        return { detected: true, bitPosition: p, originalSampleRate: i + 6 < frames ? decodeOriginalSampleRate(code) : undefined, scannedSeconds };
      }
    }
  }
  return { detected: false, scannedSeconds };
}

/**
 * Decode the first `seconds` of a file with ffmpeg (bit-exact, no downmix / resample) and scan it.
 * Files that are not stereo PCM-capable lossless audio cannot carry MQA and return detected: false.
 */
export function detectMqa(ffmpegPath: string, file: string, opts: { seconds?: number; sampleRate?: number; channels?: number } = {}): Promise<MqaInfo> {
  const seconds = opts.seconds ?? 20;
  if (opts.channels !== undefined && opts.channels !== 2) return Promise.resolve({ detected: false, scannedSeconds: 0 });
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-t', String(seconds), '-i', file, '-map', '0:a:0', '-f', 's32le', '-acodec', 'pcm_s32le', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let err = '';
    child.stdout.on('data', (c: Buffer) => {
      chunks.push(c);
      size += c.length;
    });
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 && !size) return reject(new Error(err.trim() || `ffmpeg exited with ${code}`));
      const buf = Buffer.concat(chunks, size);
      const n = Math.floor(buf.length / 4);
      // copy into a fresh, aligned ArrayBuffer (pooled Buffers can start at any byte offset)
      const samples = new Int32Array(n);
      for (let i = 0; i < n; i++) samples[i] = buf.readInt32LE(i * 4);
      resolve(detectMqaInSamples(samples, opts.sampleRate ?? 44100));
    });
  });
}
