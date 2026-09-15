import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { setDismissed, setupTools } from '../setup.js';

export default async function setupRoutes(app: FastifyInstance) {
  /** Recommended tools with detection results and install steps for this platform. */
  app.get<{ Querystring: { refresh?: string } }>('/api/setup/tools', async (req) => setupTools(req.query.refresh === '1'));

  /** Close (or bring back) the first-launch tools page. */
  app.post('/api/setup/dismiss', async (req, reply) => {
    const body = z.object({ dismissed: z.boolean().default(true) }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'dismissed must be a boolean' });
    setDismissed(body.data.dismissed);
    return { dismissed: body.data.dismissed };
  });
}
