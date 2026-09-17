import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ArrStatus, Settings } from '../../../shared/types.js';
import { store } from '../store.js';
import { Radarr } from '../arr/radarr.js';
import { Sonarr } from '../arr/sonarr.js';
import { Prowlarr } from '../arr/prowlarr.js';
import { Lidarr } from '../arr/lidarr.js';
import { scan as scanLocal } from '../library/local.js';
import { Slskd } from '../arr/slskd.js';
import { ffmpegCapabilities } from '../ffmpeg/capabilities.js';
import { discs } from '../disc/manager.js';
import { anidb } from '../anidb.js';
import { appEvents } from '../system.js';
import net from 'node:net';
import type { GeneralSettings } from '../../../shared/types.js';
import { effectiveHost, hashPassword, newApiKey, normalizeUrlBase, redactGeneral } from '../general.js';
import { applyLogLevel, hostRuntime, restart, shutdown } from '../runtime.js';

const conn = z.object({ enabled: z.boolean(), url: z.string(), apiKey: z.string() });

const generalSchema = z.object({
  host: z.object({
    bindAddress: z.string().trim().refine((v) => v === '*' || v === 'localhost' || net.isIP(v) !== 0, "Bind Address must be a valid IP address, localhost or '*'"),
    port: z.number().int().min(1).max(65535),
    urlBase: z.string().max(100).refine((v) => !v.trim() || /^\/?[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*\/?$/.test(v.trim()), 'URL Base may only contain letters, digits and - . _ ~ separated by /'),
    instanceName: z.string().max(60),
    applicationUrl: z.string().max(300).refine((v) => !v || /^https?:\/\/[^\s]+$/i.test(v), 'Application URL must start with http:// or https://'),
    enableSsl: z.boolean(),
    sslPort: z.number().int().min(1).max(65535),
    sslCertPath: z.string().max(500),
    sslKeyPath: z.string().max(500),
    sslCertPassword: z.string().max(200),
  }),
  security: z.object({
    authentication: z.enum(['none', 'basic', 'forms']),
    authenticationRequired: z.enum(['enabled', 'disabledForLocalAddresses']),
    username: z.string().max(100),
    passwordHash: z.string().optional(),
    passwordSet: z.boolean().optional(),
    password: z.string().max(200).optional(),
    passwordConfirmation: z.string().max(200).optional(),
    apiKey: z.string().regex(/^[a-f0-9]{32}$/i, 'API key must be 32 hex characters'),
    certificateValidation: z.enum(['enabled', 'disabledForLocalAddresses', 'disabled']),
  }),
  proxy: z.object({
    enabled: z.boolean(),
    type: z.literal('http'),
    hostname: z.string().max(255),
    port: z.number().int().min(1).max(65535),
    username: z.string().max(200),
    password: z.string().max(200),
    bypassFilter: z.string().max(1000),
    bypassLocalAddresses: z.boolean(),
  }),
  logging: z.object({ level: z.enum(['info', 'debug', 'trace']), sizeLimitMb: z.number().int().min(1).max(100) }),
  updates: z.object({ branch: z.string().max(60), automatic: z.boolean(), mechanism: z.enum(['builtIn', 'script', 'docker', 'external']), scriptPath: z.string().max(500) }),
  backups: z.object({ folder: z.string().max(500), intervalDays: z.number().int().min(1).max(7), retentionDays: z.number().int().min(1).max(90) }),
});

export const settingsSchema = z.object({
  general: generalSchema.optional(),
  transcoding: z
    .object({
      hardwareAcceleration: z.enum(['none', 'amf', 'nvenc', 'qsv', 'vaapi', 'rkmpp', 'videotoolbox', 'v4l2']),
      device: z.string().max(200),
      hardwareDecoding: z.boolean(),
      fallbackToSoftware: z.boolean(),
    })
    .default({ hardwareAcceleration: 'none', device: '', hardwareDecoding: true, fallbackToSoftware: true }),
  transcodeTemp: z.enum(['transcodes', 'output']).default('transcodes'),
  stallTimeoutMinutes: z.number().int().min(0).max(1440).default(10),
  auto: z
    .object({
      enabled: z.boolean(),
      includeExisting: z.boolean(),
      sources: z.object({ radarr: z.boolean(), sonarr: z.boolean() }),
      scanIntervalMinutes: z.number().int().min(1).max(1440),
      maxPerScan: z.number().int().min(1).max(500),
      profiles: z.object({ movie: z.string(), tv: z.string(), anime: z.string() }),
    })
    .default({ enabled: false, includeExisting: false, sources: { radarr: true, sonarr: true }, scanIntervalMinutes: 15, maxPerScan: 10, profiles: { movie: '', tv: '', anime: '' } }),
  anidb: z.object({ enabled: z.boolean() }).default({ enabled: false }),
  disc: z.object({
    enabled: z.boolean(),
    makemkvPath: z.string(),
    ripDirectory: z.string(),
    minTitleSeconds: z.number().int().min(0).max(36000),
    audioMode: z.enum(['best', 'all']).default('best'),
    pollIntervalSeconds: z.number().int().min(5).max(3600),
    autoRip: z.boolean(),
    autoTranscode: z.boolean(),
    autoDeliver: z.boolean(),
    autoEject: z.boolean(),
    keepRaw: z.boolean(),
    virtualDriveDirectory: z.string().default(''),
    virtualDrives: z.array(z.object({ id: z.string(), path: z.string(), label: z.string().optional(), addedAt: z.string() })).default([]),
    physicalDrives: z.array(z.object({ id: z.string(), path: z.string(), label: z.string().optional(), addedAt: z.string() })).default([]),
    cd: z
      .object({ enabled: z.boolean(), ripperPath: z.string(), readOffset: z.number().int().min(-5000).max(5000), musicbrainz: z.boolean(), detectMqa: z.boolean(), compressionLevel: z.number().int().min(0).max(8), deliverToLidarr: z.boolean() })
      .default({ enabled: true, ripperPath: '', readOffset: 0, musicbrainz: true, detectMqa: true, compressionLevel: 8, deliverToLidarr: true }),
  }),
  radarr: conn,
  sonarr: conn,
  prowlarr: conn,
  lidarr: conn.extend({ splitCueImages: z.boolean().optional() }).default({ enabled: false, url: 'http://localhost:8686', apiKey: '', splitCueImages: true }),
  slskd: z
    .object({ enabled: z.boolean(), url: z.string(), apiKey: z.string(), downloadsPath: z.string().default(''), maxQueueLength: z.number().int().min(0).max(10000).default(50), searchTimeoutSeconds: z.number().int().min(5).max(60).default(15) })
    .default({ enabled: false, url: 'http://localhost:5030', apiKey: '', downloadsPath: '', maxQueueLength: 50, searchTimeoutSeconds: 15 }),
  musicbrainz: z.object({ enabled: z.boolean() }).default({ enabled: true }),
  freacPath: z.string().default(''),
  ffmpegPath: z.string().min(1),
  ffprobePath: z.string().min(1),
  concurrency: z.number().int().min(1).max(16),
  pollIntervalSeconds: z.number().int().min(10).max(3600),
  localMedia: z
    .object({
      enabled: z.boolean(),
      usePathMappings: z.boolean(),
      folders: z.array(z.object({ path: z.string(), kind: z.enum(['auto', 'movie', 'series', 'music']) })),
      exclude: z.array(z.string()),
      hideArrManaged: z.boolean(),
      rescanHours: z.number().min(0).max(24 * 30),
      metadata: z.boolean().default(true),
      tmdbApiKey: z.string().default(''),
      metadataLanguage: z.string().default('en-US'),
    })
    .optional(),
  pathMappings: z.array(z.object({ remote: z.string(), local: z.string(), app: z.enum(['all', 'radarr', 'sonarr', 'lidarr', 'slskd']).optional() })),
  defaultProfiles: z.object({ movie: z.string(), tv: z.string(), anime: z.string(), music: z.string().default('builtin-music-flac') }),
  remuxOnly: z.boolean(),
  searchDiscReleases: z.boolean().default(true),
});

export async function testConnection(name: 'radarr' | 'sonarr' | 'prowlarr' | 'lidarr' | 'slskd', c: { url: string; apiKey: string; enabled: boolean }): Promise<ArrStatus> {
  const configured = Boolean(c.url && c.apiKey);
  if (!configured) return { name, configured: false, ok: false, error: 'URL or API key missing' };
  try {
    const on = { ...c, enabled: true };
    const client = name === 'radarr' ? new Radarr(on) : name === 'sonarr' ? new Sonarr(on) : name === 'lidarr' ? new Lidarr(on) : name === 'slskd' ? new Slskd({ ...store.settings.slskd, ...on }) : new Prowlarr(on);
    const s = await client.status();
    return { name, configured: true, ok: true, version: s.version, appName: s.appName };
  } catch (err) {
    return { name, configured: true, ok: false, error: (err as Error).message };
  }
}

export function redact(s: Settings): Settings {
  return { ...s, general: redactGeneral(s.general) };
}

/** Apply a General settings update: hash a new password, keep the stored hash otherwise. */
function mergeGeneral(next: z.infer<typeof generalSchema> | undefined, current: GeneralSettings): GeneralSettings | string {
  if (!next) return current;
  const sec = next.security;
  let passwordHash = current.security.passwordHash;
  if (sec.password) {
    if (sec.password !== sec.passwordConfirmation) return 'Password and Password Confirmation do not match';
    if (sec.password.length < 6) return 'Password must be at least 6 characters';
    passwordHash = hashPassword(sec.password);
  }
  if (sec.authentication !== 'none') {
    if (!sec.username.trim()) return 'Username is required when authentication is enabled';
    if (!passwordHash) return 'Password is required when authentication is enabled';
  }
  if (next.host.enableSsl && next.host.sslPort === next.host.port) return 'SSL Port must differ from Port Number';
  if (next.proxy.enabled && !next.proxy.hostname.trim()) return 'Proxy hostname is required when the proxy is enabled';
  const { password: _p, passwordConfirmation: _c, passwordSet: _s, ...security } = sec;
  return {
    ...next,
    host: { ...next.host, urlBase: normalizeUrlBase(next.host.urlBase), instanceName: next.host.instanceName.trim() || 'Rexarr' },
    security: { ...security, username: security.username.trim(), passwordHash },
  };
}

export default async function settingsRoutes(app: FastifyInstance) {
  app.get('/api/settings', async () => redact(store.settings));

  app.put('/api/settings', async (req, reply) => {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    const general = mergeGeneral(parsed.data.general, store.settings.general);
    if (typeof general === 'string') return reply.code(400).send({ error: general });
    const before = store.settings.general;
    if (general.security.passwordHash !== before.security.passwordHash) appEvents.add('info', 'Security', 'Password changed');
    if (general.security.authentication !== before.security.authentication) appEvents.add('warning', 'Security', `Authentication set to ${general.security.authentication}`);
    const localBefore = JSON.stringify([store.settings.localMedia, store.settings.pathMappings]);
    const localMedia = parsed.data.localMedia ?? store.settings.localMedia;
    store.saveSettings({ ...(parsed.data as Settings), localMedia, general });
    // new folders or mappings: rebuild the local media index
    if (localMedia.enabled && JSON.stringify([localMedia, parsed.data.pathMappings]) !== localBefore) void scanLocal().catch(() => undefined);
    applyLogLevel(general.logging.level);
    void ffmpegCapabilities(parsed.data.ffmpegPath, true);
    discs.schedule();
    appEvents.add('info', 'Settings', 'Settings saved');
    anidb.enabled = parsed.data.anidb.enabled;
    if (anidb.enabled) void anidb.ensure();
    return redact(store.settings);
  });

  /** Running host values, environment overrides, and whether a restart is needed. */
  app.get('/api/settings/host', async () => hostRuntime());

  /** Settings → General → Security → API Key: regenerate (saved immediately). */
  app.post('/api/settings/apikey', async () => {
    const s = store.settings;
    const apiKey = newApiKey();
    store.saveSettings({ ...s, general: { ...s.general, security: { ...s.general.security, apiKey } } });
    appEvents.add('warning', 'Security', 'API key regenerated – update scripts and *arr webhooks that use it');
    return { apiKey };
  });

  app.post('/api/system/shutdown', async () => {
    shutdown();
    return { shuttingDown: true };
  });

  app.post('/api/system/restart', async () => {
    await restart();
    const h = effectiveHost(store.settings.general);
    return { restarting: true, port: h.port, urlBase: h.urlBase };
  });

  app.post<{ Params: { app: 'radarr' | 'sonarr' | 'prowlarr' | 'lidarr' | 'slskd' } }>('/api/settings/test/:app', async (req, reply) => {
    const name = req.params.app;
    if (!['radarr', 'sonarr', 'prowlarr', 'lidarr', 'slskd'].includes(name)) return reply.code(404).send({ error: 'unknown app' });
    const body = conn.partial().safeParse(req.body ?? {});
    const c = { ...store.settings[name], ...(body.success ? body.data : {}) };
    return testConnection(name, c);
  });

  app.get('/api/settings/arr-options', async () => {
    const s = store.settings;
    const out: Record<string, { qualityProfiles: { id: number; name: string }[]; rootFolders: { id: number; path: string }[] }> = {};
    const radarr = new Radarr(s.radarr);
    const sonarr = new Sonarr(s.sonarr);
    if (radarr.configured) {
      try {
        out.radarr = { qualityProfiles: await radarr.qualityProfiles(), rootFolders: await radarr.rootFolders() };
      } catch {
        /* ignore */
      }
    }
    if (sonarr.configured) {
      try {
        out.sonarr = { qualityProfiles: await sonarr.qualityProfiles(), rootFolders: await sonarr.rootFolders() };
      } catch {
        /* ignore */
      }
    }
    return out;
  });
}
