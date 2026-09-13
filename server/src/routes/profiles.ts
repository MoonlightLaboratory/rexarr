import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { z } from 'zod';
import type { Profile } from '../../../shared/types.js';
import { store } from '../store.js';
import { buildFfmpegArgs, outputPathFor } from '../ffmpeg/args.js';
import { probe, type ProbeResult } from '../ffmpeg/probe.js';

const profileSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(80),
  description: z.string().max(500).default(''),
  mediaType: z.enum(['any', 'movie', 'tv', 'anime']).default('any'),
  container: z.enum(['mkv', 'mp4', 'webm', 'mov']),
  video: z.object({
    encoder: z.string(),
    quality: z.number(),
    preset: z.string().default(''),
    pixelFormat: z.enum(['auto', 'yuv420p', 'yuv420p10le', 'p010le', 'nv12']).default('auto'),
    tune: z.enum(['none', 'animation', 'film', 'grain', 'fastdecode', 'zerolatency']).default('none'),
    maxHeight: z.number().int().min(0).default(0),
    hdrPassthrough: z.boolean().default(true),
    bitrate: z.number().int().min(0).default(0),
    extraArgs: z.string().default(''),
  }),
  audio: z.object({
    encoder: z.string(),
    bitrate: z.number().int().min(0).default(0),
    channels: z.number().int().min(0).default(0),
    languages: z.array(z.string()).default([]),
    firstMatchOnly: z.boolean().default(false),
    dropCommentary: z.boolean().default(true),
  }),
  subtitles: z.object({
    mode: z.enum(['copy', 'none', 'burn', 'copy-text']),
    languages: z.array(z.string()).default([]),
    burnLanguage: z.string().default(''),
    burnForcedOnly: z.boolean().default(false),
    keepFonts: z.boolean().default(true),
  }),
  output: z.object({
    directory: z.string().default(''),
    suffix: z.string().default(''),
    replaceOriginal: z.boolean().default(false),
    notifyArr: z.boolean().default(true),
  }),
});

/** A representative fake probe used for command previews when no file is given. */
function sampleProbe(): ProbeResult {
  const streams = [
    { index: 0, codec_type: 'video', codec_name: 'hevc', width: 3840, height: 2160, pix_fmt: 'yuv420p10le', color_primaries: 'bt2020', color_transfer: 'smpte2084', color_space: 'bt2020nc', avg_frame_rate: '24000/1001', tags: {} },
    { index: 1, codec_type: 'audio', codec_name: 'truehd', channels: 8, channel_layout: '7.1', tags: { language: 'eng', title: 'TrueHD Atmos 7.1' } },
    { index: 2, codec_type: 'audio', codec_name: 'dts', channels: 6, tags: { language: 'jpn', title: 'DTS-HD MA 5.1' } },
    { index: 3, codec_type: 'audio', codec_name: 'ac3', channels: 2, tags: { language: 'eng', title: 'Director commentary' } },
    { index: 4, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng' } },
    { index: 5, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', tags: { language: 'eng' }, disposition: { forced: 1 } },
    { index: 6, codec_type: 'subtitle', codec_name: 'ass', tags: { language: 'jpn' } },
    { index: 7, codec_type: 'attachment', codec_name: 'ttf', tags: { filename: 'font.ttf' } },
  ] as ProbeResult['streams'];
  return {
    path: '/media/Movies/Example (2024)/Example.2024.2160p.BluRay.REMUX.mkv',
    durationSeconds: 7200,
    sizeBytes: 60e9,
    bitRate: 66e6,
    formatName: 'matroska,webm',
    streams,
    video: streams[0],
    audio: streams.filter((s) => s.codec_type === 'audio'),
    subtitles: streams.filter((s) => s.codec_type === 'subtitle'),
    attachments: streams.filter((s) => s.codec_type === 'attachment'),
    isHdr: true,
    isDolbyVision: false,
    frameRate: 23.976,
  };
}

function quote(a: string) {
  return /[\s"'$`\\]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a;
}

export default async function profileRoutes(app: FastifyInstance) {
  app.get('/api/profiles', async () => store.profiles);

  app.post('/api/profiles', async (req, reply) => {
    const parsed = profileSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    const now = new Date().toISOString();
    const profile = { ...parsed.data, id: randomUUID(), builtin: false, createdAt: now, updatedAt: now } as Profile;
    store.upsertProfile(profile);
    return reply.code(201).send(profile);
  });

  app.put<{ Params: { id: string } }>('/api/profiles/:id', async (req, reply) => {
    const existing = store.getProfile(req.params.id);
    if (!existing) return reply.code(404).send({ error: 'profile not found' });
    if (existing.builtin) return reply.code(400).send({ error: 'built-in presets are read-only; clone it instead' });
    const parsed = profileSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    const profile = { ...parsed.data, id: existing.id, builtin: false, createdAt: existing.createdAt, updatedAt: new Date().toISOString() } as Profile;
    store.upsertProfile(profile);
    return profile;
  });

  app.post<{ Params: { id: string } }>('/api/profiles/:id/clone', async (req, reply) => {
    const existing = store.getProfile(req.params.id);
    if (!existing) return reply.code(404).send({ error: 'profile not found' });
    const now = new Date().toISOString();
    const profile: Profile = structuredClone({ ...existing, id: randomUUID(), name: `${existing.name} (copy)`, builtin: false, createdAt: now, updatedAt: now });
    store.upsertProfile(profile);
    return reply.code(201).send(profile);
  });

  app.delete<{ Params: { id: string } }>('/api/profiles/:id', async (req, reply) => {
    const existing = store.getProfile(req.params.id);
    if (!existing) return reply.code(404).send({ error: 'profile not found' });
    if (existing.builtin) return reply.code(400).send({ error: 'built-in presets cannot be deleted' });
    store.deleteProfile(req.params.id);
    return { ok: true };
  });

  /** Preview the ffmpeg command a profile would produce, for a real file or a sample UHD remux. */
  app.post('/api/profiles/preview', async (req, reply) => {
    const body = z.object({ profile: profileSchema.optional(), profileId: z.string().optional(), path: z.string().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid body' });
    let profile: Profile | undefined;
    if (body.data.profile) profile = { ...body.data.profile, id: body.data.profile.id ?? 'preview', builtin: false, createdAt: '', updatedAt: '' } as Profile;
    else if (body.data.profileId) profile = store.getProfile(body.data.profileId);
    if (!profile) return reply.code(400).send({ error: 'profile required' });
    let info: ProbeResult;
    let input: string;
    if (body.data.path) {
      if (!fs.existsSync(body.data.path)) return reply.code(400).send({ error: `file not found: ${body.data.path}` });
      input = body.data.path;
      info = await probe(store.settings.ffprobePath, input);
    } else {
      info = sampleProbe();
      input = info.path;
    }
    try {
      const output = outputPathFor(profile, input);
      const built = buildFfmpegArgs(profile, info, input, output);
      return {
        command: [store.settings.ffmpegPath, ...built.args].map(quote).join(' '),
        args: built.args,
        warnings: built.warnings,
        summary: built.summary,
        output,
        sample: !body.data.path,
        streams: info.streams.map((s) => ({ index: s.index, type: s.codec_type, codec: s.codec_name, language: s.tags?.language, title: s.tags?.title, channels: s.channels, width: s.width, height: s.height })),
      };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
}
