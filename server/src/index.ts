import Fastify, { type FastifyInstance } from 'fastify';
import http from 'node:http';
import net from 'node:net';
import https from 'node:https';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { APP_VERSION, CLIENT_DIST, CONFIG_DIR, MIGRATED, PATHS } from './config.js';
import { registerAuth } from './auth.js';
import { effectiveHost, listenHost } from './general.js';
import { onLogLevel, onRestart, onShutdown, running, sslFingerprint } from './runtime.js';
import { openBrowser } from './browser.js';
import { store } from './store.js';
import { queue } from './jobs/queue.js';
import settingsRoutes from './routes/settings.js';
import profileRoutes from './routes/profiles.js';
import libraryRoutes from './routes/library.js';
import searchRoutes from './routes/search.js';
import jobRoutes from './routes/jobs.js';
import systemRoutes from './routes/system.js';
import discRoutes from './routes/disc.js';
import anidbRoutes from './routes/anidb.js';
import imageRoutes from './routes/images.js';
import systemPageRoutes from './routes/systemPages.js';
import autoRoutes from './routes/auto.js';
import transcodingRoutes from './routes/transcoding.js';
import previewRoutes from './routes/preview.js';
import musicRoutes from './routes/music.js';
import localRoutes from './routes/local.js';
import estimateRoutes from './routes/estimate.js';
import { startLocalMedia } from './library/local.js';
import { autoTranscode } from './auto.js';
import { appEvents, backups, createLogStream, tasks } from './system.js';
import { bus } from './events.js';
import { runHealthChecks } from './health.js';
import { ffmpegCapabilities } from './ffmpeg/capabilities.js';
import { anidb } from './anidb.js';
import { discs } from './disc/manager.js';

const logStream = createLogStream();
let app: FastifyInstance | null = null;
let httpsServer: https.Server | null = null;
/** Host values to use instead of the saved ones (after a restart failed to bind). */
let fallbackHost: { bindAddress: string; port: number; urlBase: string } | null = null;

/** TLS options from Settings → General → Host (PEM cert + key, or a .pfx / .p12 bundle). */
function tlsOptions(): https.ServerOptions | null {
  const h = store.settings.general.host;
  if (!h.enableSsl) return null;
  if (!h.sslCertPath) throw new Error('SSL is enabled but no certificate path is set');
  if (/\.(pfx|p12)$/i.test(h.sslCertPath)) return { pfx: fs.readFileSync(h.sslCertPath), passphrase: h.sslCertPassword || undefined };
  if (!h.sslKeyPath) throw new Error('SSL is enabled but no key path is set (needed for PEM certificates)');
  return { cert: fs.readFileSync(h.sslCertPath), key: fs.readFileSync(h.sslKeyPath), passphrase: h.sslCertPassword || undefined };
}

async function buildApp(host: { bindAddress: string; port: number; urlBase: string }) {
  const g = store.settings.general;
  const urlBase = host.urlBase;
  let tls: https.ServerOptions | null = null;
  try {
    tls = tlsOptions();
  } catch (err) {
    appEvents.add('error', 'Host', `HTTPS not started: ${(err as Error).message}`);
  }
  let pendingHttps: https.Server | null = null;
  const instance = Fastify({
    logger: { level: g.logging.level, stream: logStream },
    // lets close() tear down long-lived SSE streams instead of waiting on them
    forceCloseConnections: true,
    // Settings → General → URL Base: requests may arrive as /rexarr/api/... (reverse proxy) or /api/...
    rewriteUrl: (req) => {
      const u = req.url ?? '/';
      if (urlBase && (u === urlBase || u.startsWith(`${urlBase}/`) || u.startsWith(`${urlBase}?`))) return u.slice(urlBase.length) || '/';
      return u;
    },
    // the HTTPS listener shares the same request handler as HTTP
    serverFactory: (handler) => {
      if (tls) pendingHttps = https.createServer(tls, handler);
      return http.createServer(handler);
    },
  });
  // Backup uploads arrive as raw gzip / json bodies; the login form as urlencoded.
  instance.addContentTypeParser(['application/gzip', 'application/x-gzip', 'application/octet-stream'], { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  instance.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))));

  instance.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    instance.log.error(err);
    reply.code(err.statusCode ?? 500).send({ error: err.message });
  });

  registerAuth(instance, urlBase);
  await instance.register(settingsRoutes);
  await instance.register(profileRoutes);
  await instance.register(libraryRoutes);
  await instance.register(searchRoutes);
  await instance.register(jobRoutes);
  await instance.register(systemRoutes);
  await instance.register(discRoutes);
  await instance.register(anidbRoutes);
  await instance.register(imageRoutes);
  await instance.register(systemPageRoutes);
  await instance.register(autoRoutes);
  await instance.register(transcodingRoutes);
  await instance.register(previewRoutes);
  await instance.register(musicRoutes);
  await instance.register(localRoutes);
  await instance.register(estimateRoutes);

  instance.get('/api/health', async () => ({ ok: true, version: APP_VERSION }));

  if (fs.existsSync(path.join(CLIENT_DIST, 'index.html'))) {
    // index.html gets the URL base and instance name; relative asset paths resolve against <base href>.
    const indexHtml = () =>
      fs
        .readFileSync(path.join(CLIENT_DIST, 'index.html'), 'utf8')
        .replace(/<base href="[^"]*"\s*\/?>/, `<base href="${urlBase}/">`)
        .replace('</head>', `<script>window.__REXARR__=${JSON.stringify({ urlBase, instanceName: store.settings.general.host.instanceName || 'Rexarr' }).replace(/</g, '\\u003c')}</script></head>`);
    // wildcard serving looks files up per request, so a rebuilt client bundle is picked up without a restart.
    await instance.register(fastifyStatic, { root: CLIENT_DIST, prefix: '/', wildcard: true, index: false });
    instance.get('/', async (_req, reply) => reply.type('text/html').header('Cache-Control', 'no-cache').send(indexHtml()));
    // SPA fallback for client-side routes.
    instance.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
      return reply.type('text/html').header('Cache-Control', 'no-cache').send(indexHtml());
    });
  } else {
    instance.log.warn(`Client bundle not found at ${CLIENT_DIST}; run "npm run build" or use the Vite dev server.`);
  }
  return { instance, https: () => pendingHttps as https.Server | null };
}

async function start() {
  const want = fallbackHost ?? effectiveHost(store.settings.general);
  const built = await buildApp(want);
  const bind = listenHost(want.bindAddress);
  await built.instance.listen({ port: want.port, host: bind });
  app = built.instance;
  const sslServer = built.https();
  running.bindAddress = want.bindAddress;
  running.port = want.port;
  running.urlBase = want.urlBase;
  running.sslKey = sslFingerprint();
  running.sslPort = undefined;
  if (sslServer) {
    const sslPort = store.settings.general.host.sslPort;
    await new Promise<void>((resolve) => {
      sslServer.once('error', (err) => {
        appEvents.add('error', 'Host', `HTTPS could not listen on ${sslPort}: ${err.message}`);
        resolve();
      });
      sslServer.listen(sslPort, bind, () => {
        running.sslPort = sslPort;
        httpsServer = sslServer;
        resolve();
      });
    });
  }
  app.log.info(`rexarr ${APP_VERSION} listening on http://${bind}:${want.port}${want.urlBase}/${running.sslPort ? ` and https://${bind}:${running.sslPort}${want.urlBase}/` : ''} (config: ${CONFIG_DIR})`);
}

onLogLevel((level) => {
  if (app) app.log.level = level;
});

onRestart(async () => {
  // reply first, then swap the server underneath
  setTimeout(async () => {
    const previous = { bindAddress: running.bindAddress, port: running.port, urlBase: running.urlBase };
    app?.log.info('restarting HTTP server');
    await app?.close().catch(() => undefined);
    if (httpsServer) {
      httpsServer.closeAllConnections();
      httpsServer.close();
      httpsServer = null;
    }
    fallbackHost = null;
    try {
      await start();
      appEvents.add('info', 'App', `Restarted on port ${running.port}${running.urlBase ? `, URL base ${running.urlBase}` : ''}${running.sslPort ? `, HTTPS ${running.sslPort}` : ''}`);
    } catch (err) {
      appEvents.add('error', 'App', `Restart failed (${(err as Error).message}); back on port ${previous.port}`);
      fallbackHost = previous;
      await start();
    }
  }, 300).unref();
});

/** --browser (the macOS app and Windows shortcuts): open the web UI once listening. Launched again while rexarr is
 *  already running, it opens the running instance and exits before touching the queue. */
const launchBrowser = process.argv.includes('--browser') && !process.env.REXARR_NO_BROWSER;
if (launchBrowser) {
  const want = effectiveHost(store.settings.general);
  const taken = await new Promise<boolean>((resolve) => {
    const probe = net.createServer();
    probe.once('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'EADDRINUSE'));
    probe.listen(want.port, listenHost(want.bindAddress), () => probe.close(() => resolve(false)));
  });
  if (taken) {
    console.log(`[rexarr] port ${want.port} is in use, probably by rexarr itself: opening it`);
    openBrowser(`http://localhost:${want.port}${want.urlBase}/`);
    await new Promise((r) => setTimeout(r, 1500));
    process.exit(0);
  }
}

queue.start();
discs.start();
startLocalMedia();

// ---- application event log
bus.on('event', (ev) => {
  if (ev.type === 'job' && ev.job.status === 'done') autoTranscode.noteOutput(ev.job);
  if (ev.type === 'notice') appEvents.add(ev.level === 'warn' ? 'warning' : ev.level, 'App', ev.message);
  else if (ev.type === 'job' && ['done', 'failed', 'cancelled'].includes(ev.job.status)) {
    const key = `${ev.job.id}:${ev.job.status}`;
    if (!seenJobEvents.has(key)) {
      seenJobEvents.add(key);
      appEvents.add(ev.job.status === 'failed' ? 'error' : 'info', 'Encode', `${ev.job.title}${ev.job.subtitle ? ` – ${ev.job.subtitle}` : ''}: ${ev.job.status}${ev.job.error ? ` (${ev.job.error})` : ''}`, ev.job.outputPath);
    }
  } else if (ev.type === 'rip' && ['done', 'failed', 'cancelled', 'ready'].includes(ev.rip.status)) {
    const key = `${ev.rip.id}:${ev.rip.status}`;
    if (!seenJobEvents.has(key)) {
      seenJobEvents.add(key);
      appEvents.add(ev.rip.status === 'failed' ? 'error' : 'info', 'Disc', `${ev.rip.media.title || ev.rip.label}: ${ev.rip.status === 'ready' ? 'disc scanned, ready to rip' : ev.rip.status}${ev.rip.error ? ` (${ev.rip.error})` : ''}`);
    }
  }
});
const seenJobEvents = new Set<string>();
appEvents.add('info', 'App', `rexarr ${APP_VERSION} started`);
if (MIGRATED.length) appEvents.add('info', 'Storage', `Moved to the new storage layout: ${MIGRATED.join(', ')}`);

// ---- scheduled tasks (System → Tasks)
tasks.register({ id: 'check-health', name: 'Check health', interval: () => 300, run: async () => { const r = await runHealthChecks(); return r.length ? `${r.length} issue(s)` : 'no issues'; } });
tasks.register({ id: 'poll-drives', name: 'Check optical drives', interval: () => (store.settings.disc.enabled ? store.settings.disc.pollIntervalSeconds : 0), run: async () => { const d = await discs.refreshDrives(); if (store.settings.disc.enabled) await discs.poll(); return `${d.length} drive(s)`; } });
tasks.register({ id: 'poll-imports', name: 'Check *arr imports for waiting jobs', interval: () => store.settings.pollIntervalSeconds, run: async () => { const n = queue.list().filter((j) => j.status === 'waiting').length; await queue.pollNow(); return `${n} waiting job(s) checked`; } });
tasks.register({ id: 'refresh-anidb', name: 'Refresh AniDB data', interval: () => (store.settings.anidb.enabled ? 7 * 24 * 3600 : 0), run: async () => { if (!store.settings.anidb.enabled) return 'disabled'; await anidb.ensure(true); const s = anidb.status(); return s.error ?? `${s.animeCount} anime, ${s.mappingCount} mappings`; } });
tasks.register({ id: 'detect-ffmpeg', name: 'Detect FFmpeg encoders', interval: () => 6 * 3600, run: async () => { const c = await ffmpegCapabilities(store.settings.ffmpegPath, true); return c.available ? `ffmpeg ${c.version}, ${c.videoEncoders.length - 1} video encoders` : c.error; } });
tasks.register({ id: 'auto-transcode', name: 'Auto transcode new remuxes', interval: () => (store.settings.auto.enabled ? store.settings.auto.scanIntervalMinutes * 60 : 0), run: async () => { if (!store.settings.auto.enabled) return 'disabled'; const r = await autoTranscode.scan(false, 'schedule'); return r.baseline !== undefined ? `baseline: ${r.baseline} existing remux(es) ignored` : `${r.found} remux(es), ${r.queued.length} queued${r.pending.length ? `, ${r.pending.length} pending` : ''}${r.skippedMissing.length ? `, ${r.skippedMissing.length} not visible` : ''}`; } });
tasks.register({ id: 'backup', name: 'Backup configuration', interval: () => Math.max(1, store.settings.general.backups.intervalDays) * 86400, run: async () => backups.create('scheduled').name });
tasks.register({ id: 'clean-transcodes', name: 'Clean transcode cache', interval: () => 24 * 3600, run: async () => { const dir = PATHS.transcodes; if (!fs.existsSync(dir)) return 'nothing to clean'; const active = new Set(queue.list().filter((j) => ['probing', 'encoding', 'finalizing'].includes(j.status)).map((j) => j.id)); let n = 0; let bytes = 0; for (const f of fs.readdirSync(dir)) { const id = f.split('__')[0]; const p = `${dir}/${f}`; const st = fs.statSync(p); if (!active.has(id) && Date.now() - st.mtimeMs > 3600_000) { bytes += st.size; fs.rmSync(p, { recursive: true, force: true }); n++; } } return `${n} leftover file(s) removed (${(bytes / 1e9).toFixed(2)} GB)`; } });
tasks.register({ id: 'clean-images', name: 'Clean image cache', interval: () => 7 * 24 * 3600, run: async () => { const dir = PATHS.images; if (!fs.existsSync(dir)) return 'nothing to clean'; let n = 0; for (const f of fs.readdirSync(dir)) { const p = `${dir}/${f}`; if (Date.now() - fs.statSync(p).mtimeMs > 30 * 24 * 3600_000) { fs.unlinkSync(p); n++; } } return `${n} stale image(s) removed`; } });
tasks.start();
anidb.enabled = store.settings.anidb.enabled;
if (anidb.enabled) void anidb.ensure();

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return; // a second signal must not re-flush stale state
  shuttingDown = true;
  app?.log.info('shutting down');
  queue.stop();
  discs.stop();
  store.flushAll();
  // Never hang on lingering connections: exit regardless after a short grace period.
  setTimeout(() => process.exit(0), 3000).unref();
  httpsServer?.closeAllConnections();
  httpsServer?.close();
  await app?.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
onShutdown(() => void shutdown());

try {
  await start();
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') console.error(`[rexarr] port ${effectiveHost(store.settings.general).port} is already in use (is rexarr already running?)`);
  throw err;
}
if (launchBrowser) openBrowser(`http://localhost:${running.port}${running.urlBase}/`);
