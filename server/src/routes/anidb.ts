import type { FastifyInstance } from 'fastify';
import { anidb } from '../anidb.js';

export default async function anidbRoutes(app: FastifyInstance) {
  app.get('/api/anidb/status', async () => anidb.status());

  app.post('/api/anidb/refresh', async (_req, reply) => {
    if (!anidb.enabled) return reply.code(400).send({ error: 'AniDB is disabled in Settings' });
    await anidb.ensure(true);
    return anidb.status();
  });

  app.get<{ Querystring: { q?: string; limit?: string } }>('/api/anidb/search', async (req) => {
    await anidb.ensure();
    return anidb.search(req.query.q ?? '', Math.min(50, Number(req.query.limit) || 10)).map((h) => ({
      aid: h.entry.aid,
      title: h.entry.main,
      romaji: h.entry.romaji,
      kanji: h.entry.kanji,
      english: h.entry.english,
      score: h.score,
      tvdbId: h.mapping?.tvdbId,
      tmdbId: h.mapping?.tmdbId,
      imdbId: h.mapping?.imdbId,
      isMovie: h.mapping?.isMovie ?? false,
      defaultSeason: h.mapping?.defaultSeason,
      episodeOffset: h.mapping?.episodeOffset,
    }));
  });
}
