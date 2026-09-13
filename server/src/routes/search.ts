import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Release } from '../../../shared/types.js';
import { arr } from '../arr/index.js';
import { store } from '../store.js';
import { queue } from '../jobs/queue.js';

function sortReleases(list: Release[]) {
  return list.sort((a, b) => Number(b.isRemux) - Number(a.isRemux) || Number(b.approved) - Number(a.approved) || b.resolution - a.resolution || (b.seeders ?? 0) - (a.seeders ?? 0) || b.size - a.size);
}

export default async function searchRoutes(app: FastifyInstance) {
  /** Look up titles in TMDB/TVDB via Radarr/Sonarr. */
  app.get<{ Querystring: { q: string; kind: 'movie' | 'series' } }>('/api/search/lookup', async (req, reply) => {
    const { q, kind } = req.query;
    if (!q?.trim()) return [];
    const { radarr, sonarr } = arr();
    if (kind === 'movie') {
      if (!radarr.configured) return reply.code(503).send({ error: 'Radarr is not configured' });
      return radarr.lookup(q);
    }
    if (!sonarr.configured) return reply.code(503).send({ error: 'Sonarr is not configured' });
    return sonarr.lookup(q);
  });

  /** Add a title to Radarr/Sonarr so it can be searched. */
  app.post('/api/search/add', async (req, reply) => {
    const body = z
      .object({
        kind: z.enum(['movie', 'series']),
        externalId: z.number(),
        seriesType: z.enum(['standard', 'anime', 'daily']).optional(),
        qualityProfileId: z.number().optional(),
        rootFolderPath: z.string().optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid body' });
    const { radarr, sonarr } = arr();
    try {
      if (body.data.kind === 'movie') return await radarr.add(body.data.externalId, body.data.qualityProfileId, body.data.rootFolderPath);
      return await sonarr.add(body.data.externalId, body.data.seriesType ?? 'standard', body.data.qualityProfileId, body.data.rootFolderPath);
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  /**
   * Interactive release search, filtered to Blu-ray remuxes (unless remuxOnly is off or ?all=1).
   *   kind=movie&id=<movieId>
   *   kind=season&seriesId=&season=
   *   kind=episode&episodeId=
   *   kind=prowlarr&q=&category=movie|tv|all
   */
  app.get<{ Querystring: Record<string, string> }>('/api/search/releases', async (req, reply) => {
    const q = req.query;
    const { radarr, sonarr, prowlarr } = arr();
    const remuxOnly = store.settings.remuxOnly && q.all !== '1';
    let list: Release[];
    try {
      switch (q.kind) {
        case 'movie':
          if (!radarr.configured) return reply.code(503).send({ error: 'Radarr is not configured' });
          list = await radarr.releases(Number(q.id));
          break;
        case 'season':
          if (!sonarr.configured) return reply.code(503).send({ error: 'Sonarr is not configured' });
          list = await sonarr.releases({ seriesId: Number(q.seriesId), seasonNumber: Number(q.season) });
          break;
        case 'episode':
          if (!sonarr.configured) return reply.code(503).send({ error: 'Sonarr is not configured' });
          list = await sonarr.releases({ episodeId: Number(q.episodeId) });
          break;
        case 'prowlarr':
          if (!prowlarr.configured) return reply.code(503).send({ error: 'Prowlarr is not configured' });
          list = await prowlarr.search(q.q ?? '', (q.category as 'movie' | 'tv' | 'all') ?? 'all');
          break;
        default:
          return reply.code(400).send({ error: 'unknown search kind' });
      }
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
    const total = list.length;
    if (remuxOnly) list = list.filter((r) => r.isRemux);
    return { total, remux: list.filter((r) => r.isRemux).length, releases: sortReleases(list) };
  });

  /** Grab a release through the *arr app and create a waiting job that encodes it once imported. */
  app.post('/api/search/grab', async (req, reply) => {
    const body = z
      .object({
        release: z.object({ guid: z.string(), indexerId: z.number(), title: z.string(), source: z.enum(['radarr', 'sonarr', 'prowlarr']), episodeIds: z.array(z.number()).optional() }),
        profileId: z.string(),
        title: z.string(),
        poster: z.string().optional(),
        arrId: z.number().optional(),
        seasonNumber: z.number().optional(),
        episodeIds: z.array(z.number()).optional(),
        /** Create the transcode job (default true). */
        createJob: z.boolean().default(true),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    const d = body.data;
    const { radarr, sonarr, prowlarr } = arr();
    try {
      if (d.release.source === 'radarr') await radarr.grab(d.release.guid, d.release.indexerId);
      else if (d.release.source === 'sonarr') await sonarr.grab(d.release.guid, d.release.indexerId);
      else await prowlarr.grab(d.release.guid, d.release.indexerId);
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
    if (!d.createJob || d.release.source === 'prowlarr') {
      return { grabbed: true, job: null, note: d.release.source === 'prowlarr' ? 'Sent to the download client via Prowlarr. Prowlarr grabs are not tracked; queue the file manually once downloaded.' : undefined };
    }
    const job = queue.create({
      title: d.title,
      subtitle: d.release.source === 'sonarr' ? (d.seasonNumber !== undefined && !d.episodeIds?.length ? `Season ${d.seasonNumber}` : d.release.title) : d.release.title,
      poster: d.poster,
      profileId: d.profileId,
      waiting: true,
      source: {
        kind: d.release.source === 'radarr' ? 'movie' : 'episode',
        arr: d.release.source,
        arrId: d.arrId,
        seasonNumber: d.seasonNumber,
        episodeIds: d.episodeIds ?? d.release.episodeIds,
        releaseGuid: d.release.guid,
        releaseTitle: d.release.title,
      },
    });
    return { grabbed: true, job };
  });
}
