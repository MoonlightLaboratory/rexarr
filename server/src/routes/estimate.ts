/**
 * Estimated output size per profile for the files about to be encoded (Transcode dialog).
 */
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import { z } from 'zod';
import type { SizeEstimate, SizeEstimateResult } from '../../../shared/types.js';
import { store } from '../store.js';
import { probe, type ProbeResult } from '../ffmpeg/probe.js';
import { estimateSize } from '../ffmpeg/estimate.js';
import { ffmpegCapabilities } from '../ffmpeg/capabilities.js';
import { toLocalPath } from '../paths.js';

/** Probes are slow on network shares: keep them per path + mtime + size. */
const cache = new Map<string, ProbeResult>();
const MAX_PROBES = 6;

async function probeCached(file: string): Promise<ProbeResult> {
  const st = await fs.promises.stat(file);
  const key = `${file}|${st.mtimeMs}|${st.size}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const r = await probe(store.settings.ffprobePath, file);
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  cache.set(key, r);
  return r;
}

export default async function estimateRoutes(app: FastifyInstance) {
  app.post('/api/estimate', async (req, reply) => {
    const body = z
      .object({
        items: z.array(z.object({ localPath: z.string().optional(), arrPath: z.string().optional(), arr: z.enum(['radarr', 'sonarr', 'lidarr']).optional(), size: z.number().optional(), anime: z.boolean().optional() })).min(1).max(2000),
        profileIds: z.array(z.string()).optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'items required' });
    const settings = store.settings;
    const profiles = body.data.profileIds ? store.profiles.filter((p) => body.data.profileIds!.includes(p.id)) : store.profiles;
    const caps = await ffmpegCapabilities(settings.ffmpegPath).catch(() => undefined);
    const errors: string[] = [];

    const files = body.data.items.map((i) => ({ ...i, path: i.localPath || (i.arrPath ? toLocalPath(i.arrPath, i.arr) : '') }));
    // probe a sample (largest first differ most); the rest are scaled from the sample by file size
    const order = [...files.keys()].sort((a, b) => (files[b].size ?? 0) - (files[a].size ?? 0));
    const sampleIdx = files.length <= MAX_PROBES ? order : [0, Math.floor(order.length / 3), Math.floor((2 * order.length) / 3), order.length - 1, 1, order.length - 2].map((k) => order[k]);
    const probed = new Map<number, ProbeResult>();
    await Promise.all(
      [...new Set(sampleIdx)].map(async (i) => {
        const f = files[i];
        if (!f.path) return;
        try {
          probed.set(i, await Promise.race([probeCached(f.path), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('probe timed out')), 45_000))]));
        } catch (err) {
          if (errors.length < 3) errors.push(`${f.path.split('/').pop()}: ${(err as Error).message}`);
        }
      }),
    );
    if (!probed.size) return reply.code(502).send({ error: errors[0] ?? 'No file could be probed', errors });

    const estimates: SizeEstimate[] = profiles.map((profile) => {
      const per = new Map<number, Omit<SizeEstimate, 'profileId' | 'profileName'>>();
      for (const [i, pr] of probed) {
        try {
          per.set(i, estimateSize(profile, pr, { anime: files[i].anime, hardware: settings.transcoding, availableEncoders: caps?.available ? caps.videoEncoders : undefined }));
        } catch {
          /* e.g. a video profile on a music file */
        }
      }
      const sample = [...per.entries()];
      const sum = { bytes: 0, low: 0, high: 0, sourceBytes: 0, parts: { video: 0, audio: 0, subtitles: 0, other: 0 } };
      const notes = new Set<string>();
      let exact = true;
      let videoKbps = 0;
      // output / source ratio of the probed files, for files that were not probed
      const sampleSrc = sample.reduce((n, [, e]) => n + e.sourceBytes, 0);
      const ratio = (k: 'bytes' | 'low' | 'high') => (sampleSrc ? sample.reduce((n, [, e]) => n + e[k], 0) / sampleSrc : 1);
      files.forEach((f, i) => {
        const e = per.get(i);
        if (e) {
          sum.bytes += e.bytes;
          sum.low += e.low;
          sum.high += e.high;
          sum.sourceBytes += e.sourceBytes;
          for (const k of Object.keys(sum.parts) as (keyof typeof sum.parts)[]) sum.parts[k] += e.parts[k];
          e.notes.forEach((n) => notes.add(n));
          exact &&= e.exact;
          videoKbps = Math.max(videoKbps, e.videoKbps ?? 0);
        } else if (f.size) {
          sum.bytes += f.size * ratio('bytes');
          sum.low += f.size * ratio('low');
          sum.high += f.size * ratio('high');
          sum.sourceBytes += f.size;
        }
      });
      if (!sample.length) notes.add('Not estimated for these files');
      if (files.length > probed.size) notes.add(`${probed.size} of ${files.length} files probed; the others are scaled by size`);
      return { profileId: profile.id, profileName: profile.name, ...sum, bytes: Math.round(sum.bytes), low: Math.round(sum.low), high: Math.round(sum.high), videoKbps: videoKbps || undefined, notes: [...notes], exact };
    });
    const result: SizeEstimateResult = { estimates, probed: probed.size, files: files.length, errors };
    return result;
  });
}
