import { listDriveCandidates } from '../disc/devices.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { discs } from '../disc/manager.js';
import { buildEntry, contributionUrl, discStructure, fingerprintOf, lookupDisc as lookupInRexDb, rexdbIndex, submitEntry } from '../disc/rexdb.js';
import { makemkvInfo } from '../disc/makemkv.js';
import fs from 'node:fs';
import { store } from '../store.js';
import { arr } from '../arr/index.js';
import { toArrPath } from '../paths.js';
import { PATHS } from '../config.js';
import { estimateRip } from '../disc/estimate.js';
import { canSeeFolder } from '../disc/arrImport.js';
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
  episodeStartGuessed: z.boolean().optional(),
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

/**
 * What this disc would contribute to RexDB, and whether it is worth contributing.
 *
 * Nothing is sent: the entry and a pre-filled link come back for the person to read. It is only offered when
 * RexDB would actually learn something - a disc it has never seen, or one where what is on screen disagrees
 * with what it holds.
 */
function contributionFor(rip: Parameters<typeof buildEntry>[0], match: Awaited<ReturnType<typeof lookupInRexDb>>) {
  // Only what somebody read off the disc. Offering to send a guess would be inviting people to fill the
  // database with the arithmetic it exists to replace.
  if (rip.media.episodeSource !== 'manual') return null;
  const entry = buildEntry(rip);
  if (!entry) return null;
  const known = match?.how === 'fingerprint' ? match.entry : null;
  const agrees = known ? JSON.stringify(known.titles ?? {}) === JSON.stringify((entry as { titles: unknown }).titles) : false;
  return {
    entry,
    url: contributionUrl(entry),
    /** RexDB has this disc and says the same thing, so there is nothing to add. */
    alreadyKnown: agrees,
    /** RexDB has this disc and says something else - worth sending, and worth a second look first. */
    disagrees: Boolean(known) && !agrees,
  };
}

export default async function discRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { refresh?: string } }>('/api/disc/status', async (req) => {
    const makemkv = await makemkvInfo(store.settings.disc.makemkvPath, req.query.refresh === '1');
    const drives = req.query.refresh === '1' || !discs.drives.length ? await discs.refreshDrives() : discs.drives;
    return { makemkv, drives, driveError: discs.driveError || undefined, enabled: store.settings.disc.enabled };
  });

  app.get('/api/disc/rips', async () => discs.list());

  /**
   * What RexDB says about this disc, and the fingerprint it would be contributed under. Looking up sends
   * nothing anywhere; this is the same read the scan does, on demand.
   */
  /**
   * Send this disc to RexDB now. The same thing the automatic setting does, asked for on purpose, so the button
   * does not have to throw the person out of Rexarr to a browser tab to finish what they started here.
   */
  app.post<{ Params: { id: string } }>('/api/disc/rips/:id/rexdb/submit', async (req, reply) => {
    const rip = discs.get(req.params.id);
    if (!rip) return reply.code(404).send({ error: 'rip not found' });
    const entry = buildEntry(rip);
    if (!entry) return reply.code(400).send({ error: 'nothing to send: this disc has no episode mapping yet' });
    if (rip.media.episodeSource !== 'manual') {
      return reply.code(400).send({ error: 'these episode numbers are Rexarr\'s guess, not a reading of the disc. Set them yourself first - a guess is what RexDB is for replacing.' });
    }
    const sent = await submitEntry(entry);
    if (!sent.ok) return reply.code(502).send({ error: sent.error ?? 'the submission service did not accept it' });
    return { ok: true, url: sent.url };
  });

  app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>('/api/disc/rips/:id/rexdb', async (req, reply) => {
    const rip = discs.get(req.params.id);
    if (!rip) return reply.code(404).send({ error: 'rip not found' });
    const fingerprint = fingerprintOf(rip);
    try {
      // the index is cached for a day; asking about one disc on purpose is a good moment to go and look again
      if (req.query.refresh === '1') await rexdbIndex(true);
      const match = await lookupInRexDb(rip);
      return { fingerprint, match, structure: discStructure(rip.titles), contribution: contributionFor(rip, match) };
    } catch (err) {
      return { fingerprint, match: null, structure: discStructure(rip.titles), contribution: contributionFor(rip, null), error: (err as Error).message };
    }
  });

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

  // Box sets: a disc is offered one when it is identified, and these are the three answers - join it, stand alone,
  // or leave the set it is in. The set itself is only its discs, so there is nothing else to create or delete.
  app.post<{ Params: { id: string }; Body: unknown }>('/api/disc/rips/:id/batch', async (req, reply) => {
    const body = z.object({ accept: z.boolean(), force: z.boolean().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'accept required' });
    if (!discs.get(req.params.id)) return reply.code(404).send({ error: 'rip not found' });
    if (!body.data.accept) return discs.declineBatch(req.params.id);
    const joined = discs.joinBatch(req.params.id, body.data.force);
    if (body.data.force && !joined?.batch) return reply.code(400).send({ error: 'No other disc of this series and season is in the queue' });
    return joined;
  });

  app.delete<{ Params: { id: string } }>('/api/disc/rips/:id/batch', async (req, reply) => {
    if (!discs.get(req.params.id)) return reply.code(404).send({ error: 'rip not found' });
    return discs.leaveBatch(req.params.id);
  });

  app.patch<{ Params: { id: string }; Body: unknown }>('/api/disc/batches/:id', async (req, reply) => {
    const body = z
      .object({ name: z.string().trim().min(1).max(200).optional(), expectedDiscs: z.number().int().min(1).max(60).optional() })
      .refine((b) => b.name !== undefined || b.expectedDiscs !== undefined, 'name or expectedDiscs required')
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'name or expectedDiscs required' });
    const n = discs.updateBatch(req.params.id, body.data);
    if (!n) return reply.code(404).send({ error: 'box set not found' });
    return { ok: true, discs: n };
  });

  /** A disc that turned up in a drive waiting for a different one: file it, or leave it out of the set. */
  app.post<{ Params: { id: string }; Body: unknown }>('/api/disc/rips/:id/slot', async (req, reply) => {
    const body = z.object({ disc: z.number().int().min(1).max(99).optional(), reject: z.boolean().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'disc or reject required' });
    if (!discs.get(req.params.id)) return reply.code(404).send({ error: 'rip not found' });
    return discs.resolveSlot(req.params.id, body.data);
  });

  /** Eject a drive and have it wait for the next disc of its set. */
  app.post<{ Params: { index: string } }>('/api/disc/drives/:index/swap', async (req, reply) => {
    try {
      return await discs.swapDrive(Number(req.params.index));
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /** The same for every drive whose disc has been copied, so a whole stack swaps in one pass. */
  app.post('/api/disc/drives/swap-all', async () => ({ swapped: await discs.swapAllFinished() }));

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
  /** Import what is left in the rip folder into Sonarr now (also a scheduled task). */
  app.post('/api/disc/import-rips', async (_req, reply) => {
    try {
      return await discs.importRipFolder();
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

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
      out.apps.push({ app, path: remote, visible: await canSeeFolder(client, remote) });
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
    // a smart profile is as good a choice here as any; it just decides per title rather than up front
    const profile = rip.profileId ? store.getProfile(rip.profileId) ?? store.getSmartProfile(rip.profileId) : undefined;
    const caps = await ffmpegCapabilities(store.settings.ffmpegPath);
    return estimateRip(rip, profile, rip.audioMode ?? store.settings.disc.audioMode ?? 'best', {
      anime: rip.media.seriesType === 'anime' || rip.media.kind === 'series',
      hardware: store.settings.transcoding,
      availableEncoders: caps.videoEncoders,
    });
  });

  /** Add the disc's show / movie to Sonarr / Radarr now (it is otherwise added when the rip starts). */
  app.post<{ Params: { id: string } }>('/api/disc/rips/:id/add-to-library', async (req, reply) => {
    const rip = discs.get(req.params.id);
    if (!rip) return reply.code(404).send({ error: 'rip not found' });
    try {
      await discs.addToLibrary(rip);
      return discs.get(req.params.id);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
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
