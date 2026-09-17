import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Release } from '../../../shared/types.js';
import { arr } from '../arr/index.js';
import { store } from '../store.js';
import { queue } from '../jobs/queue.js';
import { makemkvInfo } from '../disc/makemkv.js';
import { invalidateLibrary, searchLocal, smartSearch } from '../search/smart.js';
import { parseQuery } from '../search/query.js';
import { rankReleases } from '../search/releaseInfo.js';


export default async function searchRoutes(app: FastifyInstance) {
  /**
   * Smart search: library titles (title, alternate, romaji, typo-tolerant) and, with online=1, new titles from
   * TMDB / TVDB. The query is parsed for ids, year, season / episode and release wishes (2160p, remux, dv…).
   */
  app.get<{ Querystring: { q?: string; scope?: 'all' | 'movie' | 'series' | 'music'; online?: string } }>('/api/search/smart', async (req) => {
    const q = (req.query.q ?? '').slice(0, 200);
    if (!q.trim()) return { query: parseQuery(''), library: [], local: [], online: [], errors: [] };
    return smartSearch(q, { scope: req.query.scope, online: req.query.online === '1' });
  });

  /** Local files only: every title on disk outside the *arr apps, or those matching q (Search → Local files). */
  app.get<{ Querystring: { q?: string; scope?: 'all' | 'movie' | 'series' | 'music' } }>('/api/search/local', async (req) => searchLocal(parseQuery((req.query.q ?? '').slice(0, 200)), req.query.scope));

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
      invalidateLibrary();
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
   *   kind=album&albumId=[&soulseek=1]   Lidarr indexers (+ Soulseek folders for "Artist Album")
   *   kind=soulseek&q=[&albumId=]        Soulseek only
   */
  app.get<{ Querystring: Record<string, string> }>('/api/search/releases', async (req, reply) => {
    const q = req.query;
    const { radarr, sonarr, prowlarr, lidarr, slskd } = arr();
    let expectedTracks: number | undefined;
    const errors: string[] = [];
    // filter=remux | disc | lossless (remux + disc) | all. Default follows Settings.
    const filter = ['remux', 'disc', 'lossless', 'all'].includes(q.filter) ? q.filter : q.all === '1' ? 'all' : store.settings.remuxOnly ? (store.settings.searchDiscReleases ? 'lossless' : 'remux') : 'all';
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
        case 'album': {
          if (!lidarr.configured) return reply.code(503).send({ error: 'Lidarr is not configured' });
          const album = await lidarr.album(Number(q.albumId));
          expectedTracks = album.statistics.trackCount || undefined;
          const artist = album.artist ?? (await lidarr.artist(album.artistId).catch(() => null))?.name ?? '';
          // Lidarr's indexers and Soulseek run side by side; one failing does not hide the other
          const [indexers, peers] = await Promise.all([
            lidarr.releases(album.id).catch((e: Error) => (errors.push(e.message), [] as Release[])),
            q.soulseek === '1' && slskd.configured ? slskd.search(`${artist} ${album.title}`.trim()).catch((e: Error) => (errors.push(e.message), [] as Release[])) : Promise.resolve([] as Release[]),
          ]);
          list = [...indexers, ...peers];
          break;
        }
        case 'soulseek': {
          if (!slskd.configured) return reply.code(503).send({ error: 'Soulseek (slskd) is not configured' });
          if (q.albumId && lidarr.configured) expectedTracks = (await lidarr.album(Number(q.albumId)).catch(() => null))?.statistics.trackCount || undefined;
          list = await slskd.search(q.q ?? '');
          break;
        }
        default:
          return reply.code(400).send({ error: 'unknown search kind' });
      }
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
    const total = list.length;
    const remux = list.filter((r) => r.isRemux).length;
    const disc = list.filter((r) => r.isDisc).length;
    if (q.kind === 'album' || q.kind === 'soulseek') {
      // music releases are never filtered by the video remux settings
      return { total, remux: 0, disc: 0, filter: 'all', releases: rankReleases(list, { query: q.q ? parseQuery(q.q) : undefined, expectedTracks }), errors };
    }
    if (filter === 'remux') list = list.filter((r) => r.isRemux);
    else if (filter === 'disc') list = list.filter((r) => r.isDisc);
    else if (filter === 'lossless') list = list.filter((r) => r.isRemux || r.isDisc);
    // q = the user's search text (release wishes like "2160p dv remux" boost matching releases); anime=1 prefers Japanese audio.
    const ranked = rankReleases(list, { query: q.q && q.kind !== 'prowlarr' ? parseQuery(q.q) : q.kind === 'prowlarr' ? parseQuery(q.q ?? '') : undefined, anime: q.anime === '1', season: q.season !== undefined && q.season !== '' ? Number(q.season) : q.episodeSeason ? Number(q.episodeSeason) : undefined });
    return { total, remux, disc, filter, releases: ranked };
  });

  /** Grab a release through the *arr app and create a waiting job that encodes it once imported. */
  app.post('/api/search/grab', async (req, reply) => {
    const body = z
      .object({
        release: z.object({
          guid: z.string(),
          indexerId: z.number(),
          title: z.string(),
          source: z.enum(['radarr', 'sonarr', 'prowlarr', 'lidarr', 'soulseek']),
          episodeIds: z.array(z.number()).optional(),
          isDisc: z.boolean().optional(),
          discFormat: z.enum(['uhd', 'bluray', 'dvd']).optional(),
          music: z.object({ username: z.string().optional(), directory: z.string().optional(), files: z.array(z.object({ filename: z.string(), size: z.number() }).passthrough()).optional() }).passthrough().optional(),
        }),
        /** Music: Lidarr album the release belongs to. */
        albumId: z.number().optional(),
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
    // Check the profile before anything reaches the download client.
    if (d.createJob && d.release.source !== 'prowlarr' && !store.getProfile(d.profileId)) return reply.code(400).send({ error: `Profile ${d.profileId} not found` });
    const { radarr, sonarr, prowlarr, lidarr, slskd } = arr();
    if (d.release.source === 'lidarr' || d.release.source === 'soulseek') {
      const music = d.release.music;
      try {
        if (d.release.source === 'lidarr') await lidarr.grab(d.release.guid, d.release.indexerId);
        else {
          if (!slskd.configured) return reply.code(503).send({ error: 'Soulseek (slskd) is not configured' });
          if (!music?.username || !music.files?.length) return reply.code(400).send({ error: 'Soulseek release without files' });
          await slskd.download(music.username, music.files.map((f) => ({ filename: f.filename, size: f.size })));
        }
      } catch (err) {
        return reply.code(502).send({ error: (err as Error).message });
      }
      const album = d.albumId && lidarr.configured ? await lidarr.album(d.albumId).catch(() => null) : null;
      const job = queue.create({
        title: d.title,
        subtitle: d.release.source === 'soulseek' ? `Soulseek · ${music?.username} · ${d.release.title}` : d.release.title,
        poster: d.poster,
        profileId: d.profileId,
        waiting: true,
        source: {
          kind: 'album',
          arr: 'lidarr',
          arrId: album?.artistId ?? d.arrId,
          albumId: d.albumId,
          releaseGuid: d.release.guid,
          releaseTitle: d.release.title,
          soulseek: d.release.source === 'soulseek' && music?.username ? { username: music.username, directory: music.directory ?? '', files: (music.files ?? []).map((f) => ({ filename: f.filename, size: f.size })) } : undefined,
        },
      });
      const keep = store.getProfile(d.profileId)?.audio.encoder === 'copy';
      return {
        grabbed: true,
        job,
        note: d.release.source === 'soulseek'
          ? `Downloading ${music?.files?.length} file(s) from ${music?.username}. Rexarr imports the folder into Lidarr when slskd finishes${keep ? '' : ', then encodes it'}.`
          : `Sent to Lidarr. Rexarr ${keep ? 'tracks the import' : 'encodes the tracks once Lidarr imports them'}.`,
      };
    }
    try {
      if (d.release.source === 'radarr') await radarr.grab(d.release.guid, d.release.indexerId);
      else if (d.release.source === 'sonarr') await sonarr.grab(d.release.guid, d.release.indexerId);
      else await prowlarr.grab(d.release.guid, d.release.indexerId);
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
    if (!d.createJob || d.release.source === 'prowlarr') {
      return { grabbed: true, job: null, note: d.release.source === 'prowlarr' ? `Sent to the download client via Prowlarr. Prowlarr grabs are not tracked; ${d.release.isDisc ? 'open the downloaded ISO / BDMV folder in Discs → Virtual drive' : 'queue the file manually'} once downloaded.` : undefined };
    }
    let discNote: string | undefined;
    if (d.release.isDisc) {
      const mk = await makemkvInfo(store.settings.disc.makemkvPath);
      discNote = mk.available
        ? `Full-disc release grabbed. When ${d.release.source === 'radarr' ? 'Radarr' : 'Sonarr'} finishes downloading it, Rexarr rips it with MakeMKV${d.release.source === 'radarr' ? ', transcodes the main title and imports it' : ' – confirm the episode order on the Discs page – then transcodes and imports the episodes'}.`
        : 'Full-disc release grabbed, but MakeMKV was not found, so Rexarr cannot rip it. Install MakeMKV (Settings → Disc ripping) before the download finishes.';
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
        disc: d.release.isDisc ? { format: d.release.discFormat } : undefined,
      },
    });
    return { grabbed: true, job, note: discNote };
  });
}
