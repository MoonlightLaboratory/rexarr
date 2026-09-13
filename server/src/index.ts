import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { APP_VERSION, CLIENT_DIST, DATA_DIR, HOST, PORT } from './config.js';
import { store } from './store.js';
import { queue } from './jobs/queue.js';
import settingsRoutes from './routes/settings.js';
import profileRoutes from './routes/profiles.js';
import libraryRoutes from './routes/library.js';
import searchRoutes from './routes/search.js';
import jobRoutes from './routes/jobs.js';
import systemRoutes from './routes/system.js';
import discRoutes from './routes/disc.js';
import { discs } from './disc/manager.js';

// forceCloseConnections lets close() tear down long-lived SSE streams instead of waiting on them.
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, forceCloseConnections: true });

app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
  app.log.error(err);
  reply.code(err.statusCode ?? 500).send({ error: err.message });
});

await app.register(settingsRoutes);
await app.register(profileRoutes);
await app.register(libraryRoutes);
await app.register(searchRoutes);
await app.register(jobRoutes);
await app.register(systemRoutes);
await app.register(discRoutes);

app.get('/api/health', async () => ({ ok: true, version: APP_VERSION }));

if (fs.existsSync(path.join(CLIENT_DIST, 'index.html'))) {
  // wildcard serving looks files up per request, so a rebuilt client bundle is picked up without a restart.
  await app.register(fastifyStatic, { root: CLIENT_DIST, prefix: '/', wildcard: true, index: ['index.html'] });
  // SPA fallback for client-side routes.
  app.setNotFoundHandler((req, reply) => {
    if (req.raw.url?.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
    return reply.sendFile('index.html');
  });
} else {
  app.log.warn(`Client bundle not found at ${CLIENT_DIST}; run "npm run build" or use the Vite dev server.`);
}

queue.start();
discs.start();

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return; // a second signal must not re-flush stale state
  shuttingDown = true;
  app.log.info('shutting down');
  queue.stop();
  discs.stop();
  store.flushAll();
  // Never hang on lingering connections: exit regardless after a short grace period.
  setTimeout(() => process.exit(0), 3000).unref();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: PORT, host: HOST });
app.log.info(`rexarr ${APP_VERSION} listening on http://${HOST}:${PORT} (data: ${DATA_DIR})`);
