import type { FastifyInstance } from 'fastify';
import { autoTranscode } from '../auto.js';

export default async function autoRoutes(app: FastifyInstance) {
  app.get('/api/auto/status', async () => autoTranscode.status());

  /** ?dryRun=1 lists what would be queued without queueing or remembering anything. */
  app.post<{ Querystring: { dryRun?: string } }>('/api/auto/scan', async (req, reply) => {
    try {
      return await autoTranscode.scan(req.query.dryRun === '1', req.query.dryRun === '1' ? 'preview' : 'manual');
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post('/api/auto/reset', async () => {
    autoTranscode.reset();
    return autoTranscode.status();
  });

  /**
   * Radarr / Sonarr → Settings → Connect → Webhook, URL http://rexarr:7878/api/webhook/radarr (or /sonarr),
   * triggers: On Import / On Upgrade. The payload is only used as a signal; the library is re-read.
   */
  app.post<{ Params: { source: string } }>('/api/webhook/:source', async (req) => {
    const body = (req.body ?? {}) as { eventType?: string };
    if (body.eventType === 'Test') return { ok: true, test: true };
    const triggered = autoTranscode.webhook(req.params.source, body.eventType ?? '');
    return { ok: true, triggered };
  });
}
