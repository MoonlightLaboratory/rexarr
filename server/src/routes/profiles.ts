import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { z } from 'zod';
import type { PreviewEstimate, Profile, SmartProfile } from '../../../shared/types.js';
import { store } from '../store.js';
import { buildFfmpegArgs, outputPathFor, subtitlesToOcr, withoutOcr } from '../ffmpeg/args.js';
import { parseManualCrop } from '../ffmpeg/crop.js';
import { ffmpegCapabilities } from '../ffmpeg/capabilities.js';
import { probe, streamLanguage, type ProbeResult } from '../ffmpeg/probe.js';
import { tesseractInfo } from '../ffmpeg/ocr.js';
import { estimateSize } from '../ffmpeg/estimate.js';
import { baseProfile, decide, explainDecision } from '../../../shared/smart.js';
import { sourceFacts } from '../ffmpeg/facts.js';
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
    // 'off', 'auto', or a crop of your own as width:height:x:y
    crop: z.union([z.enum(['off', 'auto']), z.string().regex(/^\d+:\d+:\d+:\d+$/, 'a crop is width:height:x:y')]).default('off'),
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
    perLanguage: z.enum(['all', 'best', 'smallest', 'first']).default('all'),
    // the boolean perLanguage replaced; still accepted so a profile saved by an older Rexarr round-trips
    firstMatchOnly: z.boolean().optional(),
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
    bitmapMode: z.enum(['keep', 'ocr', 'ocr-keep']).default('keep'),
    ocrLanguage: z.string().max(40).optional(),
  }),
  output: z.object({
    directory: z.string().default(''),
    suffix: z.string().default(''),
    replaceOriginal: z.boolean().default(false),
    notifyArr: z.boolean().default(true),
    renameTokens: z.boolean().default(true),
    cleanMetadata: z.boolean().default(true),
    multiVersion: z.boolean().default(false),
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

const smartConditionSchema = z.object({
  field: z.enum([
    'audio.maxChannels', 'audio.codecs', 'audio.objectBased', 'audio.lossless', 'audio.languages', 'audio.hasCommentary', 'audio.trackCount', 'audio.maxBitrateKbps',
    'video.height', 'video.width', 'video.codec', 'video.hdr', 'video.dolbyVision', 'video.bitDepth', 'video.frameRate', 'video.interlaced',
    'subtitles.count', 'subtitles.languages', 'subtitles.hasForced', 'subtitles.hasText',
    'source.durationMinutes', 'source.sizeGB', 'source.bitrateMbps', 'source.container',
    'media.kind', 'media.genres', 'media.year',
  ]),
  op: z.enum(['atLeast', 'atMost', 'equals', 'anyOf', 'noneOf', 'isTrue', 'isFalse']),
  number: z.number().optional(),
  list: z.array(z.string().max(40)).max(20).optional(),
});
const smartAssignmentSchema = z.object({
  path: z.enum([
    'container',
    'video.encoder', 'video.quality', 'video.preset', 'video.tune', 'video.maxHeight', 'video.crop', 'video.pixelFormat', 'video.hdrPassthrough', 'video.bitrate', 'video.hwMode', 'video.extraArgs',
    'audio.encoder', 'audio.bitrate', 'audio.channels', 'audio.languages', 'audio.perLanguage', 'audio.firstMatchOnly', 'audio.dropCommentary',
    'subtitles.mode', 'subtitles.languages', 'subtitles.burnLanguage', 'subtitles.burnForcedOnly', 'subtitles.keepFonts', 'subtitles.bitmapMode',
    'output.suffix', 'output.directory', 'output.replaceOriginal', 'output.renameTokens', 'output.cleanMetadata', 'output.multiVersion', 'output.notifyArr',
  ]),
  value: z.union([z.string().max(400), z.number(), z.boolean(), z.array(z.string().max(20)).max(40)]),
});
const smartProfileSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).default(''),
  mediaType: z.enum(['any', 'movie', 'tv', 'anime']).default('any'),
  container: z.enum(['mkv', 'mp4', 'webm', 'mov']).default('mkv'),
  base: z.array(smartAssignmentSchema).max(30).default([]),
  rules: z
    .array(
      z.object({
        id: z.string().min(1).max(60),
        label: z.string().max(60).optional(),
        enabled: z.boolean().optional(),
        match: z.enum(['all', 'any']).optional(),
        when: z.array(smartConditionSchema).max(12),
        set: z.array(smartAssignmentSchema).max(30).default([]),
      }),
    )
    .max(30)
    .default([]),
  loose: z.array(z.object({ id: z.string().min(1).max(60), when: smartConditionSchema })).max(40).optional(),
  layout: z.record(z.string().max(80), z.object({ x: z.number(), y: z.number() })).optional(),
});

export default async function profileRoutes(app: FastifyInstance) {
  app.get('/api/profiles', async () => store.profiles);

  // ---- smart profiles ----
  app.get('/api/smart-profiles', async () => store.smartProfiles);

  app.post('/api/smart-profiles', async (req, reply) => {
    const parsed = smartProfileSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    const now = new Date().toISOString();
    const smart: SmartProfile = { ...parsed.data, id: randomUUID(), builtin: false, createdAt: now, updatedAt: now };
    store.saveSmartProfile(smart);
    return reply.code(201).send(smart);
  });

  app.put<{ Params: { id: string } }>('/api/smart-profiles/:id', async (req, reply) => {
    const existing = store.getSmartProfile(req.params.id);
    if (!existing) return reply.code(404).send({ error: 'smart profile not found' });
    if (existing.builtin) return reply.code(400).send({ error: 'built-in smart profiles are read-only; clone it instead' });
    const parsed = smartProfileSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    const smart: SmartProfile = { ...parsed.data, id: existing.id, builtin: false, createdAt: existing.createdAt, updatedAt: new Date().toISOString() };
    store.saveSmartProfile(smart);
    return smart;
  });

  app.post<{ Params: { id: string } }>('/api/smart-profiles/:id/clone', async (req, reply) => {
    const existing = store.getSmartProfile(req.params.id);
    if (!existing) return reply.code(404).send({ error: 'smart profile not found' });
    const now = new Date().toISOString();
    const smart: SmartProfile = structuredClone({ ...existing, id: randomUUID(), name: `${existing.name} (copy)`, builtin: false, createdAt: now, updatedAt: now });
    store.saveSmartProfile(smart);
    return reply.code(201).send(smart);
  });

  app.delete<{ Params: { id: string } }>('/api/smart-profiles/:id', async (req, reply) => {
    const existing = store.getSmartProfile(req.params.id);
    if (!existing) return reply.code(404).send({ error: 'smart profile not found' });
    if (existing.builtin) return reply.code(400).send({ error: 'built-in smart profiles cannot be deleted' });
    // a default that points at it would silently stop working
    const used = Object.entries(store.settings.defaultProfiles).filter(([, id]) => id === existing.id).map(([k]) => k);
    if (used.length) return reply.code(400).send({ error: `still the default for ${used.join(', ')}; change that first` });
    store.deleteSmartProfile(req.params.id);
    return { ok: true };
  });

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
    const body = z.object({ profile: profileSchema.optional(), profileId: z.string().optional(), path: z.string().optional(), audioOnly: z.boolean().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid body' });
    let profile: Profile | undefined;
    const smartSummary: string[] = [];
    // a smart profile id is as good as a profile id here; it just needs the file first
    const smart = body.data.profileId ? store.getSmartProfile(body.data.profileId) : undefined;
    if (body.data.profile) profile = { ...body.data.profile, id: body.data.profile.id ?? 'preview', builtin: false, createdAt: '', updatedAt: '' } as Profile;
    else if (smart) profile = { ...baseProfile(smart), id: smart.id, name: smart.name, builtin: false, createdAt: '', updatedAt: '' } as Profile;
    else if (body.data.profileId) profile = store.getProfile(body.data.profileId);
    if (!profile) return reply.code(400).send({ error: 'profile required' });
    // an audio-only job copies the video whatever the profile says, so the command has to show that
    if (body.data.audioOnly) profile = { ...profile, video: { ...profile.video, encoder: 'copy', maxHeight: 0 } };
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
    // A smart profile has no settings until it has seen a file, so the preview resolves it against this one -
    // which is the only honest command to show. What it settled on, and why, goes in the summary.
    if (smart) {
      const facts = sourceFacts(info, { kind: smart.mediaType === 'anime' ? 'anime' : 'unknown', genres: [], year: 0 });
      const decision = decide(smart, facts);
      profile = { ...decision.profile, id: smart.id, name: smart.name, builtin: false, createdAt: '', updatedAt: '' } as Profile;
      if (body.data.audioOnly) profile = { ...profile, video: { ...profile.video, encoder: 'copy', maxHeight: 0 } };
      smartSummary.push(explainDecision(smart, facts, decision));
      if (smart.rules.some((r) => r.when.some((c) => c.field.startsWith('media.')))) {
        smartSummary.push('A branch asks what the title is (kind, genre, year). That is looked up when the encode runs, not here, so the real decision may differ.');
      }
    }
    // the switch in Settings rewrites the profile, so the preview shows what the encode would really do
    const ocrOff = store.settings.ocr?.enabled === false;
    const asked = subtitlesToOcr(info, profile).length;
    if (ocrOff) profile = withoutOcr(profile);
    try {
      const caps = await ffmpegCapabilities(store.settings.ffmpegPath).catch(() => undefined);
      // A crop typed in by hand is shown here, because the preview is where someone checks it. "auto" cannot be
      // shown: it is measured from the file at encode time, so the preview says that rather than guessing a box.
      const cropSetting = profile.video.crop ?? 'off';
      const crop = cropSetting === 'off' || cropSetting === 'auto' ? undefined : (parseManualCrop(cropSetting) ?? undefined);
      const draft = buildFfmpegArgs(profile, info, input, outputPathFor(profile, input), { hardware: store.settings.transcoding, availableEncoders: caps?.available ? caps.videoEncoders : undefined, metadata: { title: body.data.path ? undefined : 'Example (2024)' }, ocrDisabled: ocrOff && asked > 0, crop });
      // the real name depends on what the encode produces (codec after hardware mapping, resolution, audio)
      const output = outputPathFor(profile, input, draft.description, { replacingInput: profile.output.replaceOriginal });
      const built = buildFfmpegArgs(profile, info, input, output, { hardware: store.settings.transcoding, availableEncoders: caps?.available ? caps.videoEncoders : undefined, metadata: { title: body.data.path ? undefined : 'Example (2024)' }, ocrDisabled: ocrOff && asked > 0, crop });
      // OCR runs before the encode and takes minutes, so the preview says it will happen rather than doing it
      const toRead = subtitlesToOcr(info, profile);
      const summary = [...built.summary];
      const warnings = [...built.warnings];
      if (cropSetting === 'auto') summary.push('Letterbox bars: measured when the file is encoded, and removed only if the samples agree');
      if (ocrOff && asked) {
        warnings.push(`${asked} picture subtitle track(s) would be read into text, but that is switched off in Settings – this profile is treated as "Keep as pictures"`);
      } else if (toRead.length) {
        const langs = toRead.map((t) => streamLanguage(t.stream)).join(', ');
        const tess = await tesseractInfo(store.settings.ocr?.tesseractPath ?? '');
        if (tess.available) summary.push(`Subtitles: ${toRead.length} picture track(s) read into text first (${langs}), then added to the command above`);
        else warnings.push(`${toRead.length} picture subtitle track(s) cannot be read into text – ${tess.error}`);
      }
      // Bitrates: what the command will produce, and what it is reading. The dialog beside this one has a full
      // estimate, but the Profiles page has only the command - and a CRF is not a number anyone can read a
      // bitrate off, which is the whole question when you are choosing one.
      let estimate: PreviewEstimate | undefined;
      try {
        const e = estimateSize(profile, info, { hardware: store.settings.transcoding, availableEncoders: caps?.available ? caps.videoEncoders : undefined });
        const srcSeconds = info.durationSeconds || 0;
        estimate = {
          bytes: e.bytes,
          low: e.low,
          high: e.high,
          sourceBytes: e.sourceBytes,
          videoKbps: e.videoKbps,
          sourceKbps: srcSeconds ? Math.round((info.sizeBytes * 8) / srcSeconds / 1000) : undefined,
          sourceVideoKbps: Number(info.video?.bit_rate) ? Math.round(Number(info.video!.bit_rate) / 1000) : undefined,
          exact: e.exact,
        };
      } catch {
        /* a music profile on a video file, or anything else estimateSize will not touch */
      }
      return {
        command: [store.settings.ffmpegPath, ...built.args].map(quote).join(' '),
        args: built.args,
        warnings,
        summary: [...smartSummary, ...summary],
        estimate,
        output,
        sample: !body.data.path,
        streams: info.streams.map((s) => ({ index: s.index, type: s.codec_type, codec: s.codec_name, language: s.tags?.language, title: s.tags?.title, channels: s.channels, width: s.width, height: s.height })),
      };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
}
