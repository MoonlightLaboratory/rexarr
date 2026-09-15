import type { FastifyInstance } from 'fastify';
import { arr } from '../arr/index.js';
import { anidb } from '../anidb.js';
import { enrichMovie, enrichSeries } from '../enrich.js';

export default async function libraryRoutes(app: FastifyInstance) {
  app.get('/api/library/movies', async (_req, reply) => {
    const { radarr } = arr();
    if (!radarr.configured) return reply.code(503).send({ error: 'Radarr is not configured' });
    await anidb.ensure();
    return (await radarr.movies()).map(enrichMovie);
  });

  app.get<{ Params: { id: string } }>('/api/library/movies/:id', async (req, reply) => {
    const { radarr } = arr();
    if (!radarr.configured) return reply.code(503).send({ error: 'Radarr is not configured' });
    await anidb.ensure();
    return enrichMovie(await radarr.movie(Number(req.params.id)));
  });

  app.get('/api/library/series', async (_req, reply) => {
    const { sonarr } = arr();
    if (!sonarr.configured) return reply.code(503).send({ error: 'Sonarr is not configured' });
    await anidb.ensure();
    return (await sonarr.series()).map(enrichSeries);
  });

  app.get<{ Params: { id: string } }>('/api/library/series/:id', async (req, reply) => {
    const { sonarr } = arr();
    if (!sonarr.configured) return reply.code(503).send({ error: 'Sonarr is not configured' });
    await anidb.ensure();
    return enrichSeries(await sonarr.seriesById(Number(req.params.id)));
  });

  app.get<{ Params: { id: string }; Querystring: { season?: string } }>('/api/library/series/:id/episodes', async (req, reply) => {
    const { sonarr } = arr();
    if (!sonarr.configured) return reply.code(503).send({ error: 'Sonarr is not configured' });
    const season = req.query.season !== undefined && req.query.season !== '' ? Number(req.query.season) : undefined;
    return sonarr.episodes(Number(req.params.id), season);
  });
}
