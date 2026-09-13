import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ArrStatus, Settings } from '../../../shared/types.js';
import { store } from '../store.js';
import { Radarr } from '../arr/radarr.js';
import { Sonarr } from '../arr/sonarr.js';
import { Prowlarr } from '../arr/prowlarr.js';
import { ffmpegCapabilities } from '../ffmpeg/capabilities.js';
import { discs } from '../disc/manager.js';

const conn = z.object({ enabled: z.boolean(), url: z.string(), apiKey: z.string() });
export const settingsSchema = z.object({
  disc: z.object({
    enabled: z.boolean(),
    makemkvPath: z.string(),
    ripDirectory: z.string(),
    minTitleSeconds: z.number().int().min(0).max(36000),
    pollIntervalSeconds: z.number().int().min(5).max(3600),
    autoRip: z.boolean(),
    autoTranscode: z.boolean(),
    autoDeliver: z.boolean(),
    autoEject: z.boolean(),
    keepRaw: z.boolean(),
  }),
  radarr: conn,
  sonarr: conn,
  prowlarr: conn,
  ffmpegPath: z.string().min(1),
  ffprobePath: z.string().min(1),
  concurrency: z.number().int().min(1).max(16),
  pollIntervalSeconds: z.number().int().min(10).max(3600),
  pathMappings: z.array(z.object({ remote: z.string(), local: z.string() })),
  defaultProfiles: z.object({ movie: z.string(), tv: z.string(), anime: z.string() }),
  remuxOnly: z.boolean(),
});

export async function testConnection(name: 'radarr' | 'sonarr' | 'prowlarr', c: { url: string; apiKey: string; enabled: boolean }): Promise<ArrStatus> {
  const configured = Boolean(c.url && c.apiKey);
  if (!configured) return { name, configured: false, ok: false, error: 'URL or API key missing' };
  try {
    const client = name === 'radarr' ? new Radarr({ ...c, enabled: true }) : name === 'sonarr' ? new Sonarr({ ...c, enabled: true }) : new Prowlarr({ ...c, enabled: true });
    const s = await client.status();
    return { name, configured: true, ok: true, version: s.version, appName: s.appName };
  } catch (err) {
    return { name, configured: true, ok: false, error: (err as Error).message };
  }
}

export function redact(s: Settings): Settings {
  return s;
}

export default async function settingsRoutes(app: FastifyInstance) {
  app.get('/api/settings', async () => redact(store.settings));

  app.put('/api/settings', async (req, reply) => {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    store.saveSettings(parsed.data as Settings);
    void ffmpegCapabilities(parsed.data.ffmpegPath, true);
    discs.schedule();
    return redact(store.settings);
  });

  app.post<{ Params: { app: 'radarr' | 'sonarr' | 'prowlarr' } }>('/api/settings/test/:app', async (req, reply) => {
    const name = req.params.app;
    if (!['radarr', 'sonarr', 'prowlarr'].includes(name)) return reply.code(404).send({ error: 'unknown app' });
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
