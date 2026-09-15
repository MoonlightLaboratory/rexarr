import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import { appEvents, backups, logs, tasks } from '../system.js';
import { storagePaths } from '../storage.js';

export default async function systemPageRoutes(app: FastifyInstance) {
  // Storage paths with folder size and disk usage
  app.get<{ Querystring: { refresh?: string } }>('/api/system/paths', async (req) => storagePaths(req.query.refresh === '1'));

  // Events
  app.get<{ Querystring: { limit?: string; level?: 'info' | 'warning' | 'error' } }>('/api/system/events', async (req) => appEvents.list(Math.min(500, Number(req.query.limit) || 200), req.query.level));
  app.delete('/api/system/events', async () => {
    appEvents.clear();
    return { ok: true };
  });

  // Tasks
  app.get('/api/system/tasks', async () => tasks.list());
  app.post<{ Params: { id: string } }>('/api/system/tasks/:id/run', async (req, reply) => {
    try {
      return await tasks.run(req.params.id);
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  // Backups
  app.get('/api/system/backups', async () => backups.list());
  app.post('/api/system/backups', async (_req, reply) => reply.code(201).send(backups.create('manual')));
  app.get<{ Params: { name: string } }>('/api/system/backups/:name', async (req, reply) => {
    try {
      const p = backups.path(req.params.name);
      return reply.header('Content-Type', 'application/gzip').header('Content-Disposition', `attachment; filename="${req.params.name}"`).send(fs.createReadStream(p));
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });
  app.delete<{ Params: { name: string } }>('/api/system/backups/:name', async (req, reply) => {
    try {
      backups.remove(req.params.name);
      return { ok: true };
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });
  app.post<{ Params: { name: string } }>('/api/system/backups/:name/restore', async (req, reply) => {
    try {
      return { restored: backups.restore(req.params.name), restartRequired: true };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
  /** Restore from an uploaded backup (raw body: the .json.gz or .json content). */
  app.post('/api/system/backups/restore', { bodyLimit: 50 * 1024 * 1024 }, async (req, reply) => {
    try {
      const body = req.body as unknown;
      const buf = Buffer.isBuffer(body) ? body : typeof body === 'string' ? Buffer.from(body) : Buffer.from(JSON.stringify(body));
      return { restored: backups.restore(buf), restartRequired: true };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // Log files
  app.get('/api/system/logs', async () => logs.list());
  app.get<{ Params: { name: string } }>('/api/system/logs/:name', async (req, reply) => {
    try {
      return reply.header('Content-Type', 'text/plain; charset=utf-8').send(logs.read(req.params.name));
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });
  app.delete('/api/system/logs', async () => {
    logs.clear();
    return { ok: true };
  });
}
