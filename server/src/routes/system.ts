import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import type { SystemInfo } from '../../../shared/types.js';
import { APP_VERSION, CONFIG_DIR } from '../config.js';
import { store } from '../store.js';
import { ffmpegCapabilities } from '../ffmpeg/capabilities.js';
import { testConnection } from './settings.js';
import { queue } from '../jobs/queue.js';
import { runHealthChecks } from '../health.js';
import { freacInfo } from '../music/freac.js';

const startedAt = Date.now();

export default async function systemRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { refresh?: string } }>('/api/system', async (req) => {
    const s = store.settings;
    const [ffmpeg, ...arr] = await Promise.all([
      ffmpegCapabilities(s.ffmpegPath, req.query.refresh === '1'),
      testConnection('radarr', s.radarr).then((r) => ({ ...r, configured: s.radarr.enabled && r.configured })),
      testConnection('sonarr', s.sonarr).then((r) => ({ ...r, configured: s.sonarr.enabled && r.configured })),
      testConnection('prowlarr', s.prowlarr).then((r) => ({ ...r, configured: s.prowlarr.enabled && r.configured })),
      testConnection('lidarr', s.lidarr).then((r) => ({ ...r, configured: s.lidarr.enabled && r.configured })),
      testConnection('slskd', s.slskd).then((r) => ({ ...r, configured: s.slskd.enabled && r.configured })),
    ]);
    const freac = await freacInfo(s.freacPath, req.query.refresh === '1');
    const jobs = queue.list();
    const info: SystemInfo = {
      version: APP_VERSION,
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      dataDir: CONFIG_DIR,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      ffmpeg,
      freac,
      arr,
      jobs: {
        active: jobs.filter((j) => ['probing', 'encoding', 'finalizing'].includes(j.status)).length,
        queued: jobs.filter((j) => j.status === 'queued').length,
        waiting: jobs.filter((j) => j.status === 'waiting').length,
        done: jobs.filter((j) => j.status === 'done').length,
        failed: jobs.filter((j) => j.status === 'failed').length,
      },
    };
    return info;
  });

  app.get('/api/system/health', async () => runHealthChecks());

  app.get<{ Querystring: { refresh?: string } }>('/api/system/ffmpeg', async (req) => ffmpegCapabilities(store.settings.ffmpegPath, req.query.refresh === '1'));

  /** Minimal directory listing for the folder pickers. */
  app.get<{ Querystring: { path?: string } }>('/api/fs/list', async (req, reply) => {
    const target = req.query.path?.trim() || (process.platform === 'win32' ? 'C:\\' : '/');
    try {
      const entries = fs.readdirSync(target, { withFileTypes: true });
      return {
        path: target,
        parent: path.dirname(target) === target ? null : path.dirname(target),
        entries: entries
          .filter((e) => !e.name.startsWith('.'))
          .map((e) => ({ name: e.name, dir: e.isDirectory(), path: path.join(target, e.name) }))
          .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)),
      };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
}
