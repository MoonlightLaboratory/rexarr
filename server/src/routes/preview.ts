import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { queue } from '../jobs/queue.js';
import { store } from '../store.js';

/** At most two frame extractions at a time, so scrubbing the compare slider cannot flood the machine. */
let active = 0;
const waiting: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= 2) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

/** Grab one frame as JPEG. Input seeking (-ss before -i) keeps it fast even deep into a file. */
function grabFrame(file: string, seconds: number, width: number, format?: string, timeoutMs = 15_000): Promise<Buffer> {
  return slot(
    () =>
      new Promise<Buffer>((resolve, reject) => {
        const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', Math.max(0, seconds).toFixed(2), ...(format ? ['-f', format] : []), '-i', file, '-map', '0:v:0', '-frames:v', '1', '-vf', `scale=${width}:-2:flags=bicubic,format=yuvj420p`, '-q:v', '3', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'];
        const child = spawn(store.settings.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const chunks: Buffer[] = [];
        let err = '';
        child.stdout.on('data', (c: Buffer) => chunks.push(c));
        child.stderr.on('data', (c: Buffer) => (err += c.toString()));
        const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
        child.on('error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          const buf = Buffer.concat(chunks);
          if (code === 0 && buf.length) resolve(buf);
          else reject(new Error(err.trim().split('\n').pop() || `ffmpeg exited with code ${code}`));
        });
      }),
  );
}

/** Short-lived cache of encoded frames per job so several viewers do not each spawn ffmpeg. */
const encodedCache = new Map<string, { at: number; t: number; buf: Buffer }>();

export default async function previewRoutes(app: FastifyInstance) {
  /** Live source frame written by the running encode (refreshes every ~3 s). */
  app.get<{ Params: { id: string } }>('/api/jobs/:id/preview/live.jpg', async (req, reply) => {
    const file = queue.previewPath(req.params.id);
    if (!fs.existsSync(file) || !fs.statSync(file).size) return reply.code(404).header('Cache-Control', 'no-store').send({ error: 'no live frame yet' });
    return reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'no-store').send(fs.readFileSync(file));
  });

  /** Frame from the partially written output, a few seconds behind the encoder. */
  app.get<{ Params: { id: string }; Querystring: { w?: string } }>('/api/jobs/:id/preview/encoded.jpg', async (req, reply) => {
    const job = queue.get(req.params.id);
    const part = queue.partial(req.params.id);
    if (!job || !part) return reply.code(404).header('Cache-Control', 'no-store').send({ error: 'job is not encoding' });
    if (part.container === 'mp4' || part.container === 'mov') return reply.code(409).header('Cache-Control', 'no-store').send({ error: 'MP4 / MOV outputs cannot be read until the encode finishes' });
    const t = Math.max(0, (job.progress.outTimeSeconds || 0) - 6);
    const cached = encodedCache.get(job.id);
    if (cached && Date.now() - cached.at < 4000) return reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'no-store').header('X-Frame-Time', String(cached.t)).send(cached.buf);
    try {
      const buf = await grabFrame(part.path, t, Math.min(1920, Number(req.query.w) || 640), 'matroska', 10_000);
      encodedCache.set(job.id, { at: Date.now(), t, buf });
      return reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'no-store').header('X-Frame-Time', String(t)).send(buf);
    } catch (err) {
      return reply.code(503).header('Cache-Control', 'no-store').send({ error: `no encoded frame yet: ${(err as Error).message}` });
    }
  });

  /** Source or finished output frame at a timestamp, for the before / after compare view. */
  app.get<{ Params: { id: string }; Querystring: { which?: string; t?: string; w?: string } }>('/api/jobs/:id/frame', async (req, reply) => {
    const job = queue.get(req.params.id);
    if (!job) return reply.code(404).send({ error: 'job not found' });
    const which = req.query.which === 'output' ? 'output' : 'source';
    const file = which === 'output' ? job.outputPath : job.source.localPath;
    if (!file || !fs.existsSync(file) || (which === 'output' && job.status !== 'done')) return reply.code(404).send({ error: `${which} file is not available` });
    const t = Math.max(0, Number(req.query.t) || 0);
    try {
      const buf = await grabFrame(file, t, Math.min(3840, Number(req.query.w) || 960));
      return reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'private, max-age=3600').send(buf);
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });
}
