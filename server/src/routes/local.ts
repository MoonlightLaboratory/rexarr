/**
 * Local media (files outside the *arr apps): scan status, rescan, items, posters.
 */
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import { z } from 'zod';
import { localItem, localItems, localPoster, localStatus, refreshLocalMetadata, scan } from '../library/local.js';
import { candidatesFor, clearMatch, setMatch } from '../library/localMeta.js';

export default async function localRoutes(app: FastifyInstance) {
  app.get('/api/local/status', async () => localStatus());

  app.post('/api/local/scan', async () => {
    void scan().catch((err: Error) => app.log.error(`[local] scan failed: ${err.message}`));
    return localStatus();
  });

  /** Titles without their file lists (the list can be long). */
  app.get<{ Querystring: { kind?: string } }>('/api/local/items', async (req) =>
    localItems()
      .filter((i) => !req.query.kind || i.kind === req.query.kind)
      .map(({ files, ...rest }) => ({ ...rest, fileCount: files.length, remux: files.some((f) => f.isRemux) })),
  );

  app.get<{ Params: { id: string } }>('/api/local/items/:id', async (req, reply) => {
    const it = localItem(req.params.id);
    if (!it) return reply.code(404).send({ error: 'Not found – the folder may have been rescanned' });
    return { ...it, files: it.files.map((f) => ({ ...f, exists: fs.existsSync(f.path) })) };
  });

  /** Fix Match: candidates from TMDb / Radarr / Sonarr / MusicBrainz for a title or a typed query. */
  app.get<{ Params: { id: string }; Querystring: { q?: string } }>('/api/local/items/:id/candidates', async (req, reply) => {
    const it = localItem(req.params.id);
    if (!it) return reply.code(404).send({ error: 'Not found' });
    try {
      return await candidatesFor(it, req.query.q);
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.post<{ Params: { id: string } }>('/api/local/items/:id/match', async (req, reply) => {
    const it = localItem(req.params.id);
    if (!it) return reply.code(404).send({ error: 'Not found' });
    const body = z
      .object({
        clear: z.boolean().optional(),
        candidate: z
          .object({ source: z.enum(['tmdb', 'radarr', 'sonarr', 'musicbrainz']), externalId: z.string() })
          .passthrough()
          .optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'candidate or clear required' });
    if (body.data.clear) {
      clearMatch(it.id);
      void refreshLocalMetadata();
      return { ok: true };
    }
    if (!body.data.candidate) return reply.code(400).send({ error: 'candidate required' });
    try {
      return await setMatch(it, body.data.candidate as Parameters<typeof setMatch>[1]);
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.post<{ Querystring: { force?: string } }>('/api/local/metadata/refresh', async (req) => {
    void refreshLocalMetadata(req.query.force === '1').catch((err: Error) => app.log.error(`[local-meta] ${err.message}`));
    return localStatus();
  });

  app.get<{ Params: { id: string } }>('/api/local/items/:id/poster', async (req, reply) => {
    const it = localItem(req.params.id);
    const p = it && localPoster(it);
    if (!p) return reply.code(404).send({ error: 'no poster' });
    reply.header('Content-Type', /\.png$/i.test(p) ? 'image/png' : 'image/jpeg').header('Cache-Control', 'public, max-age=86400');
    return reply.send(fs.createReadStream(p));
  });

}
