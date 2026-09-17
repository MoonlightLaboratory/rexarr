/**
 * Music library (Lidarr), MQA scans, file metadata, fre:ac status and MusicBrainz search.
 */
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { MqaInfo, Track } from '../../../shared/types.js';
import { arr } from '../arr/index.js';
import { store } from '../store.js';
import { freacInfo } from '../music/freac.js';
import { cachedMqa, scanMqa } from '../audio/mqaCache.js';
import { searchReleases } from '../music/musicbrainz.js';
import { findCueImages } from '../music/cue.js';
import { cueSplitStates, splitFolderImages } from '../music/cueImports.js';
import { toArrPath } from '../paths.js';
import { bus } from '../events.js';

const run = promisify(execFile);

const withMqa = (tracks: Track[]) => tracks.map((t) => (t.file ? { ...t, file: { ...t.file, mqa: cachedMqa(t.file.localPath) } } : t));

export default async function musicRoutes(app: FastifyInstance) {
  const lidarrOr503 = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
    const { lidarr } = arr();
    if (!lidarr.configured) {
      reply.code(503).send({ error: 'Lidarr is not configured' });
      return null;
    }
    return lidarr;
  };

  app.get('/api/music/artists', async (_req, reply) => {
    const lidarr = lidarrOr503(reply);
    return lidarr ? lidarr.artists() : undefined;
  });

  app.get<{ Params: { id: string } }>('/api/music/artists/:id', async (req, reply) => {
    const lidarr = lidarrOr503(reply);
    if (!lidarr) return;
    const id = Number(req.params.id);
    const [artist, albums] = await Promise.all([lidarr.artist(id), lidarr.albums(id)]);
    return { artist, albums };
  });

  app.get('/api/music/albums', async (_req, reply) => {
    const lidarr = lidarrOr503(reply);
    return lidarr ? lidarr.albums() : undefined;
  });

  app.get<{ Params: { id: string } }>('/api/music/albums/:id', async (req, reply) => {
    const lidarr = lidarrOr503(reply);
    if (!lidarr) return;
    const id = Number(req.params.id);
    const [album, tracks] = await Promise.all([lidarr.album(id), lidarr.tracks(id)]);
    return { album, tracks: withMqa(tracks) };
  });

  /** Scan the files of an album (or explicit paths) for MQA. */
  app.post('/api/music/mqa', async (req, reply) => {
    const body = z.object({ albumId: z.number().optional(), paths: z.array(z.string()).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'albumId or paths required' });
    let paths = body.data.paths ?? [];
    if (body.data.albumId) {
      const lidarr = lidarrOr503(reply);
      if (!lidarr) return;
      paths = (await lidarr.trackFiles(body.data.albumId)).map((f) => f.localPath);
    }
    const results: Record<string, MqaInfo | { error: string }> = {};
    for (const p of paths) {
      if (!fs.existsSync(p)) {
        results[p] = { error: 'file not found (check path mappings)' };
        continue;
      }
      try {
        results[p] = await scanMqa(p);
      } catch (err) {
        results[p] = { error: (err as Error).message };
      }
    }
    return results;
  });

  /** Tags, streams and format of any media file Rexarr can see. */
  app.get<{ Querystring: { path?: string } }>('/api/media/metadata', async (req, reply) => {
    const p = req.query.path ?? '';
    if (!p || !fs.existsSync(p) || !fs.statSync(p).isFile()) return reply.code(404).send({ error: 'file not found' });
    const { stdout } = await run(store.settings.ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', p], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
    const j = JSON.parse(stdout) as { format?: Record<string, unknown> & { tags?: Record<string, string> }; streams?: (Record<string, unknown> & { tags?: Record<string, string>; codec_type?: string })[]; chapters?: unknown[] };
    const lossless = j.streams?.some((s) => s.codec_type === 'audio' && /flac|alac|wavpack|ape|pcm_|truehd/.test(String(s.codec_name)));
    return { path: p, format: j.format, streams: j.streams, chapters: j.chapters?.length ?? 0, mqa: lossless ? cachedMqa(p) : undefined };
  });

  app.get<{ Querystring: { refresh?: string } }>('/api/music/freac', async (req) => freacInfo(store.settings.freacPath, req.query.refresh === '1'));

  /** Add an album (and its artist) to Lidarr by MusicBrainz release group id. */
  app.post('/api/music/add', async (req, reply) => {
    const body = z.object({ foreignAlbumId: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'foreignAlbumId required' });
    const lidarr = lidarrOr503(reply);
    if (!lidarr) return;
    try {
      return await lidarr.addAlbum(body.data.foreignAlbumId);
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  /** Cue image splits (Lidarr queue watcher). */
  app.get('/api/music/cue-splits', async () => cueSplitStates());

  /**
   * Import a folder into Lidarr, splitting "image + cue" albums first. For downloads that already left Lidarr's
   * queue. Splitting runs in the background; progress arrives as notifications.
   */
  app.post('/api/music/import-folder', async (req, reply) => {
    const body = z.object({ path: z.string().min(1), split: z.boolean().default(true) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'path required' });
    const lidarr = lidarrOr503(reply);
    if (!lidarr) return;
    const dir = body.data.path.trim();
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return reply.code(404).send({ error: `Folder not found: ${dir} (use the path as Rexarr sees it)` });
    const images = body.data.split ? findCueImages(dir) : [];
    if (!images.length) {
      await lidarr.importFolder(toArrPath(dir, 'lidarr'));
      return { images: 0, message: 'Asked Lidarr to import the folder' };
    }
    const tracks = images.reduce((n, i) => n + i.trackCount, 0);
    void splitFolderImages(dir, images, (l) => app.log.info(`[cue] ${l}`))
      .then(async (r) => {
        await lidarr.importFolder(toArrPath(r.importPath, 'lidarr'));
        bus.notice('info', `${path.basename(dir)}: split into ${r.tracks} tracks, Lidarr is importing`);
      })
      .catch((err: Error) => bus.notice('error', `${path.basename(dir)}: cue split failed – ${err.message}`));
    return { images: images.length, tracks, encodings: [...new Set(images.map((i) => i.encoding))], message: `Splitting ${images.length} cue image(s) into ${tracks} tracks, then Lidarr imports them` };
  });

  app.get<{ Querystring: { q?: string } }>('/api/musicbrainz/search', async (req, reply) => {
    if (!store.settings.musicbrainz.enabled) return reply.code(503).send({ error: 'MusicBrainz lookups are disabled in Settings' });
    if (!req.query.q?.trim()) return [];
    try {
      return await searchReleases(req.query.q.trim());
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });
}
