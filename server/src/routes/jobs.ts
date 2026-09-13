import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { queue } from '../jobs/queue.js';
import { bus } from '../events.js';
import { discs } from '../disc/manager.js';
import type { ServerEvent } from '../../../shared/types.js';

export default async function jobRoutes(app: FastifyInstance) {
  app.get('/api/jobs', async () => queue.list());

  app.post('/api/jobs', async (req, reply) => {
    const body = z
      .object({
        title: z.string(),
        subtitle: z.string().optional(),
        poster: z.string().optional(),
        profileId: z.string(),
        source: z.object({
          kind: z.enum(['movie', 'episode', 'file']),
          arr: z.enum(['radarr', 'sonarr']).optional(),
          arrId: z.number().optional(),
          episodeIds: z.array(z.number()).optional(),
          seasonNumber: z.number().optional(),
          fileId: z.number().optional(),
          arrPath: z.string().optional(),
          localPath: z.string().optional(),
        }),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    try {
      return reply.code(201).send(queue.create(body.data));
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /** Queue many files at once (bulk transcode from the library). */
  app.post('/api/jobs/bulk', async (req, reply) => {
    const body = z
      .object({
        profileId: z.string(),
        items: z.array(
          z.object({
            title: z.string(),
            subtitle: z.string().optional(),
            poster: z.string().optional(),
            source: z.object({
              kind: z.enum(['movie', 'episode', 'file']),
              arr: z.enum(['radarr', 'sonarr']).optional(),
              arrId: z.number().optional(),
              episodeIds: z.array(z.number()).optional(),
              seasonNumber: z.number().optional(),
              fileId: z.number().optional(),
              arrPath: z.string().optional(),
              localPath: z.string().optional(),
            }),
          }),
        ),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid body' });
    const created = [];
    const errors: string[] = [];
    for (const item of body.data.items) {
      try {
        created.push(queue.create({ ...item, profileId: body.data.profileId }));
      } catch (err) {
        errors.push(`${item.title}: ${(err as Error).message}`);
      }
    }
    return { created: created.length, errors };
  });

  app.post<{ Params: { id: string } }>('/api/jobs/:id/cancel', async (req) => {
    queue.cancel(req.params.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/jobs/:id/retry', async (req) => {
    queue.retry(req.params.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string }; Body: { direction?: 'top' | 'bottom' } }>('/api/jobs/:id/reorder', async (req) => {
    queue.reorder(req.params.id, req.body?.direction === 'bottom' ? 'bottom' : 'top');
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>('/api/jobs/:id', async (req) => {
    queue.remove(req.params.id);
    return { ok: true };
  });
  app.post('/api/jobs/clear', async () => {
    queue.clearFinished();
    return { ok: true };
  });
  app.get<{ Params: { id: string } }>('/api/jobs/:id/log', async (req, reply) => {
    const job = queue.get(req.params.id);
    if (!job) return reply.code(404).send({ error: 'job not found' });
    return { log: job.log, command: job.command };
  });

  /** Server-sent events: job updates, log lines and notices. */
  app.get('/api/events', async (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(`event: jobs\ndata: ${JSON.stringify({ type: 'jobs', jobs: queue.list() })}\n\n`);
    reply.raw.write(`event: rips\ndata: ${JSON.stringify({ type: 'rips', rips: discs.list() })}\n\n`);
    reply.raw.write(`event: drives\ndata: ${JSON.stringify({ type: 'drives', drives: discs.drives })}\n\n`);
    const onEvent = (ev: ServerEvent) => {
      reply.raw.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    };
    bus.on('event', onEvent);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      bus.off('event', onEvent);
    });
    await new Promise(() => {});
  });
}
