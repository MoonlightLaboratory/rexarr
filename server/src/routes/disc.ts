import { listDriveCandidates } from '../disc/devices.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { discs } from '../disc/manager.js';
import { makemkvInfo } from '../disc/makemkv.js';
import fs from 'node:fs';
import { store } from '../store.js';
import { arr } from '../arr/index.js';
import { toArrPath } from '../paths.js';
import { PATHS } from '../config.js';
import { estimateRip } from '../disc/estimate.js';
import { ffmpegCapabilities } from '../ffmpeg/capabilities.js';

const mediaSchema = z.object({
  kind: z.enum(['movie', 'series', 'album', 'unknown']).optional(),
  title: z.string().optional(),
  artist: z.string().optional(),
  year: z.number().optional(),
  externalId: z.number().optional(),
  arrId: z.number().optional(),
  poster: z.string().optional(),
  seriesType: z.enum(['standard', 'anime', 'daily']).optional(),
  seasonNumber: z.number().int().min(0).optional(),
  episodeStart: z.number().int().min(0).optional(),
  absoluteNumbering: z.boolean().optional(),
  discNumber: z.number().int().min(0).optional(),
});
const patchSchema = z.object({
  media: mediaSchema.optional(),
  selectedTitleIds: z.array(z.number()).optional(),
  episodeMap: z.record(z.string(), z.number().int().min(0)).optional(),
  profileId: z.string().optional(),
  options: z.object({ transcode: z.boolean().optional(), deliver: z.boolean().optional(), eject: z.boolean().optional(), keepRaw: z.boolean().optional() }).optional(),
  audioMode: z.enum(['best', 'all', 'custom']).optional(),
  titleRoles: z
    .record(
      z.string(),
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('episode') }),
        z.object({ kind: z.literal('special'), episode: z.number().int().min(0) }),
        z.object({ kind: z.literal('extra'), type: z.enum(['none', 'op', 'ed', 'extra', 'ova', 'special', 'custom']), name: z.string().max(120).optional() }),
      ]),
    )
    .optional(),
  selectedAudio: z.record(z.string(), z.array(z.number().int().min(0))).optional(),
});

export default async function discRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { refresh?: string } }>('/api/disc/status', async (req) => {
    const makemkv = await makemkvInfo(store.settings.disc.makemkvPath, req.query.refresh === '1');
    const drives = req.query.refresh === '1' || !discs.drives.length ? await discs.refreshDrives() : discs.drives;
    return { makemkv, drives, driveError: discs.driveError || undefined, enabled: store.settings.disc.enabled };
  });

  app.get('/api/disc/rips', async () => discs.list());

  app.post('/api/disc/detect', async () => ({ created: await discs.detectNow() }));

  /** Rip an image or disc folder by path (testing / archived discs). */
  app.post('/api/disc/open', async (req, reply) => {
    const body = z.object({ path: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'path required' });
    try {
      return await discs.openImage(body.data.path);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /** Real drives added by device path. */
  app.get('/api/disc/drives/candidates', async () => listDriveCandidates());
  app.post('/api/disc/drives', async (req, reply) => {
    const body = z.object({ path: z.string().min(1).max(300), label: z.string().max(120).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'device path required' });
    try {
      return reply.code(201).send(await discs.addPhysicalDrive(body.data.path, body.data.label));
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
  app.delete<{ Params: { id: string } }>('/api/disc/drives/:id', async (req, reply) => {
    if (!discs.removePhysicalDrive(req.params.id)) return reply.code(404).send({ error: 'drive not found' });
    return { ok: true };
  });

  /** Persistent virtual drives (linked images / folders). */
  app.get('/api/disc/virtual', async () => store.settings.disc.virtualDrives ?? []);
  app.post('/api/disc/virtual', async (req, reply) => {
    const body = z.object({ path: z.string().min(1), label: z.string().max(120).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'path required' });
    try {
      return reply.code(201).send(await discs.addVirtualDrive(body.data.path, body.data.label));
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
  app.delete<{ Params: { id: string } }>('/api/disc/virtual/:id', async (req, reply) => {
    if (!discs.removeVirtualDrive(req.params.id)) return reply.code(404).send({ error: 'virtual drive not found' });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/disc/rips/:id/scan', async (req, reply) => {
    if (!discs.get(req.params.id)) return reply.code(404).send({ error: 'rip not found' });
    await discs.scan(req.params.id);
    return discs.get(req.params.id);
  });

  app.patch<{ Params: { id: string } }>('/api/disc/rips/:id', async (req, reply) => {
    const body = patchSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    try {
      return discs.update(req.params.id, body.data);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /**
   * Can Radarr and Sonarr see the rip folder? Asks each app's own file browser for the folder as it would be sent
   * to them (after path mappings); delivery only works when they can.
   */
  app.get('/api/disc/rip-directory/check', async () => {
    const dir = store.settings.disc.ripDirectory?.trim() || PATHS.rips;
    const { radarr, sonarr } = arr();
    const out: { dir: string; localOk: boolean; apps: { app: 'radarr' | 'sonarr'; path: string; visible: boolean | null; error?: string }[] } = {
      dir,
      localOk: fs.existsSync(dir),
      apps: [],
    };
    for (const [app, client] of [['radarr', radarr], ['sonarr', sonarr]] as const) {
      if (!client.configured) continue;
      const remote = toArrPath(dir, app);
      try {
        const res = await client.http.get<{ directories?: unknown[]; parent?: string }>('/filesystem', { path: remote.endsWith('/') ? remote : `${remote}/`, includeFiles: 'false' }, 15_000);
        out.apps.push({ app, path: remote, visible: Array.isArray(res.directories) });
      } catch (err) {
        out.apps.push({ app, path: remote, visible: false, error: (err as Error).message });
      }
    }
    return out;
  });

  /** Estimated rip and transcode size. The body may carry a selection that has not been saved yet. */
  app.post<{ Params: { id: string } }>('/api/disc/rips/:id/estimate', async (req, reply) => {
    const saved = discs.get(req.params.id);
    if (!saved) return reply.code(404).send({ error: 'rip not found' });
    const body = patchSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid body' });
    const rip = {
      ...saved,
      selectedTitleIds: body.data.selectedTitleIds ?? saved.selectedTitleIds,
      audioMode: body.data.audioMode ?? saved.audioMode,
      selectedAudio: { ...saved.selectedAudio, ...body.data.selectedAudio },
      options: { ...saved.options, ...body.data.options },
      profileId: body.data.profileId ?? saved.profileId,
    };
    const profile = rip.profileId ? store.getProfile(rip.profileId) : undefined;
    const caps = await ffmpegCapabilities(store.settings.ffmpegPath);
    return estimateRip(rip, profile, rip.audioMode ?? store.settings.disc.audioMode ?? 'best', {
      anime: rip.media.seriesType === 'anime' || rip.media.kind === 'series',
      hardware: store.settings.transcoding,
      availableEncoders: caps.videoEncoders,
    });
  });

  app.post<{ Params: { id: string } }>('/api/disc/rips/:id/identify', async (req, reply) => {
    try {
      return await discs.reidentify(req.params.id);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post<{ Params: { id: string } }>('/api/disc/rips/:id/start', async (req, reply) => {
    const body = patchSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid body' });
    try {
      await discs.startRip(req.params.id, body.data);
      return discs.get(req.params.id);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post<{ Params: { id: string } }>('/api/disc/rips/:id/cancel', async (req) => {
    discs.cancel(req.params.id);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/disc/rips/:id', async (req) => {
    discs.remove(req.params.id);
    return { ok: true };
  });

  /** Read an audio CD in a drive (fre:ac rip with MusicBrainz metadata). */
  app.post<{ Params: { index: string } }>('/api/disc/drives/:index/cd', async (req, reply) => {
    try {
      return await discs.readCd(Number(req.params.index));
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /** Audio CD: choose a MusicBrainz match (index) or use a release found by title search (releaseId). */
  app.post<{ Params: { id: string } }>('/api/disc/rips/:id/musicbrainz', async (req, reply) => {
    const body = z.object({ index: z.number().int().min(0).optional(), releaseId: z.string().uuid().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'index or releaseId required' });
    try {
      return await discs.setCdRelease(req.params.id, body.data);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post<{ Params: { index: string } }>('/api/disc/drives/:index/eject', async (req, reply) => {
    try {
      await discs.eject(Number(req.params.index));
      return { ok: true };
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });
}
