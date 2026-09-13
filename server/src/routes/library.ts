import type { FastifyInstance } from 'fastify';
import { arr } from '../arr/index.js';

export default async function libraryRoutes(app: FastifyInstance) {
  app.get('/api/library/movies', async (_req, reply) => {
    const { radarr } = arr();
    if (!radarr.configured) return reply.code(503).send({ error: 'Radarr is not configured' });
    return radarr.movies();
  });

  app.get<{ Params: { id: string } }>('/api/library/movies/:id', async (req, reply) => {
    const { radarr } = arr();
    if (!radarr.configured) return reply.code(503).send({ error: 'Radarr is not configured' });
    return radarr.movie(Number(req.params.id));
  });

  app.get('/api/library/series', async (_req, reply) => {
    const { sonarr } = arr();
    if (!sonarr.configured) return reply.code(503).send({ error: 'Sonarr is not configured' });
    return sonarr.series();
  });

  app.get<{ Params: { id: string } }>('/api/library/series/:id', async (req, reply) => {
    const { sonarr } = arr();
    if (!sonarr.configured) return reply.code(503).send({ error: 'Sonarr is not configured' });
    return sonarr.seriesById(Number(req.params.id));
  });

  app.get<{ Params: { id: string }; Querystring: { season?: string } }>('/api/library/series/:id/episodes', async (req, reply) => {
    const { sonarr } = arr();
    if (!sonarr.configured) return reply.code(503).send({ error: 'Sonarr is not configured' });
    const season = req.query.season !== undefined && req.query.season !== '' ? Number(req.query.season) : undefined;
    return sonarr.episodes(Number(req.params.id), season);
  });
}
