import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { z } from 'zod';
import type { Profile } from '../../../shared/types.js';
import { store } from '../store.js';
import { buildFfmpegArgs, outputPathFor } from '../ffmpeg/args.js';
import { ffmpegCapabilities } from '../ffmpeg/capabilities.js';
import { probe, type ProbeResult } from '../ffmpeg/probe.js';
import { CONTAINER_INFO } from '../../../shared/presets.js';
import { freacEncoderArgs, freacInfo } from '../music/freac.js';

const profileSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(80),
  description: z.string().max(500).default(''),
  mediaType: z.enum(['any', 'movie', 'tv', 'anime', 'music']).default('any'),
  container: z.enum(['mkv', 'mp4', 'webm', 'mov', 'flac', 'mp3', 'opus', 'ogg', 'wv', 'ape']),
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
    hwMode: z.enum(['auto', 'software']).default('auto'),
  }),
  audio: z.object({
    encoder: z.string(),
    bitrate: z.number().int().min(0).default(0),
    channels: z.number().int().min(0).default(0),
    languages: z.array(z.string()).default([]),
    firstMatchOnly: z.boolean().default(false),
    dropCommentary: z.boolean().default(true),
    vbrQuality: z.number().min(0).max(10).optional(),
    maxSampleRate: z.number().int().min(0).max(768000).optional(),
    bitDepth: z.union([z.literal(0), z.literal(16), z.literal(24)]).optional(),
    compressionLevel: z.number().int().min(0).max(12).optional(),
    preserveMqa: z.boolean().optional(),
    replayGain: z.boolean().optional(),
    embedCover: z.boolean().optional(),
    opusComplexity: z.number().int().min(0).max(10).optional(),
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
    renameTokens: z.boolean().default(true),
    cleanMetadata: z.boolean().default(true),
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
    path: '/media/Movies/Example (2024)/Example.2024.2160p.UHD.BluRay.REMUX.HDR.HEVC.TrueHD.Atmos.7.1-GROUP.mkv',
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
    if (profile.mediaType === 'music' || CONTAINER_INFO[profile.container]?.music) {
      // Music profiles run through fre:ac: describe that pipeline instead of an ffmpeg command
      const input = body.data.path || '/music/Artist/Album (2024)/01 - Track.flac';
      if (profile.audio.encoder === 'copy') return { command: '(no encode – files are kept as downloaded)', args: [], warnings: [], summary: ['Import only'], output: input, sample: !body.data.path, streams: [] };
      let enc;
      try {
        enc = freacEncoderArgs(profile);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
      const fa = await freacInfo(store.settings.freacPath);
      const output = outputPathFor(profile, input, undefined, { replacingInput: profile.output.replaceOriginal });
      const summary: string[] = [];
      const warnings: string[] = [];
      if (!fa.available) warnings.push(`fre:ac not found (${fa.error ?? 'freaccmd'}): install fre:ac or set its path in Settings`);
      else if (!fa.encoders.includes(enc.encoder)) warnings.push(`This fre:ac build has no "${enc.encoder}" encoder`);
      if (profile.audio.maxSampleRate || profile.audio.bitDepth) summary.push(`FFmpeg soxr: ${profile.audio.maxSampleRate ? `resample above ${profile.audio.maxSampleRate / 1000} kHz` : ''}${profile.audio.maxSampleRate && profile.audio.bitDepth ? ', ' : ''}${profile.audio.bitDepth ? `reduce to ${profile.audio.bitDepth}-bit with triangular dither` : ''} (only when the source is higher)`);
      summary.push(`fre:ac ${fa.version ?? ''} encoder ${enc.encoder}${enc.options.length ? ` ${enc.options.join(' ')}` : ''}; tags and cover art copied from the source`);
      if (profile.audio.replayGain) summary.push(['flac', 'mp3', 'opus'].includes(enc.ext) ? 'ReplayGain track gain / peak written with a stream-copy remux' : `ReplayGain tags are not written to .${enc.ext}`);
      if (profile.audio.preserveMqa) summary.push(['flac', 'wv', 'ape'].includes(enc.ext) ? 'MQA sources: encoded bit-perfect (no resampling / dither)' : 'MQA sources are skipped (a lossy encode would destroy MQA)');
      const q = (a: string) => (/[\s"'$`\\]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a);
      return { command: [fa.path, '-e', enc.encoder, '-o', output, '--', ...enc.options, input].map(q).join(' '), args: [], warnings, summary, output, sample: !body.data.path, streams: [] };
    }
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
      const caps = await ffmpegCapabilities(store.settings.ffmpegPath).catch(() => undefined);
      const draft = buildFfmpegArgs(profile, info, input, outputPathFor(profile, input), { hardware: store.settings.transcoding, availableEncoders: caps?.available ? caps.videoEncoders : undefined, metadata: { title: body.data.path ? undefined : 'Example (2024)' } });
      // the real name depends on what the encode produces (codec after hardware mapping, resolution, audio)
      const output = outputPathFor(profile, input, draft.description, { replacingInput: profile.output.replaceOriginal });
      const built = buildFfmpegArgs(profile, info, input, output, { hardware: store.settings.transcoding, availableEncoders: caps?.available ? caps.videoEncoders : undefined, metadata: { title: body.data.path ? undefined : 'Example (2024)' } });
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
