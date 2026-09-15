/**
 * Output naming and metadata for encodes.
 *
 * A remux that has been re-encoded is no longer a remux. Left as "Remux-1080p", Radarr / Sonarr keep reporting the
 * wrong quality (and may try to "upgrade" to it again), so the release tokens in the file name are rewritten to
 * describe the encode:
 *
 *   Movie (2017) Remux-2160p.mkv                                    → Movie (2017) Bluray-2160p.mkv
 *   Show - S01E05 - Bluray-1080p Remux.mkv                          → Show - S01E05 - Bluray-1080p.mkv
 *   Movie.2017.2160p.UHD.BluRay.REMUX.DV.HDR.HEVC.TrueHD.7.1-GRP    → Movie.2017.2160p.UHD.BluRay.HDR.10bit.x265.Opus.7.1-GRP
 *   (downscaled to 1080p)                                           → Movie.2017.1080p.BluRay.HDR.10bit.x265.Opus.7.1-GRP
 *
 * Titles, years and release groups are never touched; only quality, resolution, codec, audio, HDR and bit-depth
 * tokens that are already in the name are replaced (a remux token is turned into Bluray).
 */
import type { Profile } from '../../../shared/types.js';
import { CONTAINER_INFO, LANGUAGES, VIDEO_ENCODER_INFO } from '../../../shared/presets.js';
import { streamLanguage, streamTitle, type ProbeResult, type ProbeStream } from './probe.js';

export interface AudioPlanItem {
  stream: ProbeStream;
  /** ffmpeg encoder, or "copy". */
  encoder: string;
  /** Output channel count. */
  channels: number;
}

export interface EncodeDescription {
  /** Output height class, e.g. "1080p". */
  resolution: string;
  /** Tag for the video codec as releases write it: x265, x264, AV1, HEVC, H.264… */
  videoCodec: string;
  /** Human codec name for metadata: HEVC, H.264, AV1… */
  videoCodecName: string;
  videoCopied: boolean;
  tenBit: boolean;
  /** HDR kept in the output. */
  hdr: boolean;
  /** Dolby Vision kept (only when the video is copied). */
  dolbyVision: boolean;
  /** First (default) audio track, e.g. { codec: "Opus", channels: "7.1" }. */
  audio?: { codec: string; channels: string; copied: boolean; atmos: boolean };
}

export function codecForAudioEncoder(enc: string) {
  switch (enc) {
    case 'libfdk_aac':
      return 'aac';
    case 'libopus':
      return 'opus';
    default:
      return enc;
  }
}

/** Which audio encoder each selected track really ends up with (container limits, channel caps). */
export function planAudio(profile: Profile, streams: ProbeStream[], warnings: string[] = []): AudioPlanItem[] {
  const container = CONTAINER_INFO[profile.container];
  const a = profile.audio;
  return streams.map((s) => {
    let enc: string = a.encoder;
    if (enc === 'libfdk_aac') {
      // not open source (and often missing from ffmpeg builds): use FFmpeg's native AAC encoder
      if (!warnings.some((w) => w.includes('libfdk_aac'))) warnings.push('libfdk_aac is not open source; encoding with FFmpeg\'s native AAC encoder');
      enc = 'aac';
    }
    if (enc !== 'copy' && container.audioCodecs[0] !== '*' && !container.audioCodecs.includes(codecForAudioEncoder(enc))) {
      warnings.push(`${enc} is not allowed in ${profile.container}; falling back to aac`);
      enc = 'aac';
    }
    if (enc === 'copy' && container.audioCodecs[0] !== '*' && !container.audioCodecs.includes(s.codec_name)) {
      warnings.push(`Audio codec ${s.codec_name} cannot be stored in ${profile.container}; re-encoding to aac`);
      enc = 'aac';
    }
    const src = s.channels ?? 2;
    let channels = src;
    if (enc !== 'copy') {
      if (a.channels > 0 && a.channels < src) channels = a.channels;
      else if ((enc === 'ac3' || enc === 'eac3') && src > 6) channels = 6;
    }
    return { stream: s, encoder: enc, channels };
  });
}

export function channelLabel(n: number) {
  return n === 1 ? '1.0' : n === 2 ? '2.0' : n === 3 ? '2.1' : n === 6 ? '5.1' : n === 7 ? '6.1' : n === 8 ? '7.1' : `${n}ch`;
}

/** Release-style audio codec name. */
export function audioCodecLabel(encoder: string, s?: ProbeStream): string {
  if (encoder === 'copy' && s) {
    const title = streamTitle(s);
    switch (s.codec_name) {
      case 'truehd':
        return 'TrueHD';
      case 'dts':
        return /DTS-HD MA|MA$/i.test(s.profile ?? '') ? 'DTS-HD MA' : /X/i.test(s.profile ?? '') || /dts[-:\s]?x/i.test(title) ? 'DTS-X' : /HD/i.test(s.profile ?? '') ? 'DTS-HD' : 'DTS';
      case 'eac3':
        return 'EAC3';
      case 'ac3':
        return 'AC3';
      case 'aac':
        return 'AAC';
      case 'flac':
        return 'FLAC';
      case 'opus':
        return 'Opus';
      default:
        return s.codec_name.startsWith('pcm_') ? 'LPCM' : s.codec_name.toUpperCase();
    }
  }
  switch (codecForAudioEncoder(encoder)) {
    case 'opus':
      return 'Opus';
    case 'aac':
      return 'AAC';
    case 'ac3':
      return 'AC3';
    case 'eac3':
      return 'EAC3';
    case 'flac':
      return 'FLAC';
    case 'truehd':
      return 'TrueHD';
    default:
      return encoder.toUpperCase();
  }
}

/** Height class from the frame size; wide ratios (1920×800) still count as 1080p. */
export function resolutionClass(width = 0, height = 0): string {
  if (width >= 3200 || height >= 2000) return '2160p';
  if (width >= 1800 || height >= 1000) return '1080p';
  if (width >= 1200 || height >= 700) return '720p';
  if (height >= 560 || width >= 1000) return '576p';
  return '480p';
}

const SOURCE_VIDEO_TAG: Record<string, [string, string]> = {
  hevc: ['HEVC', 'HEVC'],
  h264: ['AVC', 'H.264'],
  av1: ['AV1', 'AV1'],
  vp9: ['VP9', 'VP9'],
  vc1: ['VC-1', 'VC-1'],
  mpeg2video: ['MPEG-2', 'MPEG-2'],
};

/** What the encode will produce, given the (hardware-resolved) profile. */
export function describeEncode(profile: Profile, probe: ProbeResult, videoEncoder = profile.video.encoder, audioPlan?: AudioPlanItem[]): EncodeDescription {
  const v = profile.video;
  const src = probe.video;
  const copied = videoEncoder === 'copy';
  const info = VIDEO_ENCODER_INFO[videoEncoder];
  let width = src?.width ?? 0;
  let height = src?.height ?? 0;
  if (!copied && v.maxHeight > 0 && height > v.maxHeight) {
    width = Math.round((width * v.maxHeight) / height);
    height = v.maxHeight;
  }
  let videoCodec: string;
  let videoCodecName: string;
  if (copied) [videoCodec, videoCodecName] = SOURCE_VIDEO_TAG[src?.codec_name ?? ''] ?? [(src?.codec_name ?? '').toUpperCase(), (src?.codec_name ?? '').toUpperCase()];
  else {
    const codec = info?.codec ?? '';
    videoCodecName = codec === 'hevc' ? 'HEVC' : codec === 'h264' ? 'H.264' : codec.toUpperCase();
    videoCodec = info?.family === 'x265' ? 'x265' : info?.family === 'x264' ? 'x264' : codec === 'hevc' ? 'HEVC' : codec === 'h264' ? 'H.264' : codec.toUpperCase();
  }
  const pix = v.pixelFormat;
  const tenBit = copied ? /10/.test(src?.pix_fmt ?? '') : pix === 'yuv420p10le' || pix === 'p010le' || (pix === 'auto' && /10/.test(src?.pix_fmt ?? '') && info?.codec !== 'h264');
  const hdr = probe.isHdr && (copied || (v.hdrPassthrough && tenBit));
  const first = audioPlan?.[0];
  return {
    resolution: resolutionClass(width, height),
    videoCodec,
    videoCodecName,
    videoCopied: copied,
    tenBit,
    hdr,
    dolbyVision: copied && probe.isDolbyVision,
    audio: first
      ? {
          codec: audioCodecLabel(first.encoder, first.stream),
          channels: channelLabel(first.channels),
          copied: first.encoder === 'copy',
          atmos: first.encoder === 'copy' && /atmos/i.test(`${streamTitle(first.stream)} ${first.stream.profile ?? ''}`),
        }
      : undefined,
  };
}

// ---------- file name rewriting ----------

const VIDEO_CODEC_RE = /(?<![A-Za-z0-9])(?:[xh][.\s]?26[45]|HEVC|AVC|VC-?1|MPEG-?2|AV1|VP9)(?![A-Za-z0-9])/gi;
const AUDIO_RE = /(?<![A-Za-z0-9])(?:TrueHD|DTS[-.\s]?HD[-.\s]?MA|DTS[-.\s]?HD|DTS[-.\s]?X|DTS[-.\s]?ES|DTS|L?PCM|FLAC|E-?AC-?3|DDP|DD\+|DD|AC-?3|AAC|Opus)(?:[.\s]?Atmos)?(?:[.\s]?[1-7][.\s][01])?(?:[.\s]?Atmos)?(?![A-Za-z0-9])/gi;
const HDR_RE = /(?<![A-Za-z0-9])(?:HDR10\+|HDR10Plus|HDR10|HDR|HLG|DV|DoVi|Dolby[.\s]?Vision)(?![A-Za-z0-9+])/gi;
const DV_RE = /(?<![A-Za-z0-9])(?:DV|DoVi|Dolby[.\s]?Vision)(?![A-Za-z0-9])/gi;
const BIT_RE = /(?<![A-Za-z0-9])(?:10|8)[-.\s]?bit(?![A-Za-z0-9])/gi;
const RES_RE = /(?<![A-Za-z0-9])(?:2160p|1080p|1080i|720p|576p|480p|4K)(?![A-Za-z0-9])/gi;

/** Global regexes keep state in .test(); test with a fresh non-global copy. */
const has = (re: RegExp, str: string) => new RegExp(re.source, re.flags.replace('g', '')).test(str);

/** Is this file name (without extension) a remux, by its release tokens? */
export function looksLikeRemux(name: string) {
  return /(?<![A-Za-z0-9])(?:BD|UHD)?[-.\s]?Remux(?![A-Za-z0-9])/i.test(name);
}

/**
 * Rewrite release tokens in a file name (without extension) to describe the encode.
 * Returns the name unchanged when it carries no release tokens.
 */
export function renameForEncode(base: string, d: EncodeDescription): string {
  // Separator style: scene names use dots, arr names use spaces.
  const dotted = !/\s/.test(base) && (base.match(/\./g)?.length ?? 0) >= 2;
  const sep = dotted ? '.' : ' ';
  const join = (...parts: string[]) => parts.filter(Boolean).join(sep);
  let s = base;
  const wasRemux = looksLikeRemux(s);

  // 1. arr quality tokens: "Remux-2160p", "Bluray-1080p Remux", "Bluray-2160p" (resolution follows the encode)
  s = s.replace(/(?<![A-Za-z0-9])Remux-(2160p|1080p|720p|576p|480p)(?![A-Za-z0-9])/gi, () => `Bluray-${d.resolution}`);
  s = s.replace(/(?<![A-Za-z0-9])Bluray-(2160p|1080p|720p|576p|480p)(?:[\s.]Remux)?(?![A-Za-z0-9])/gi, () => `Bluray-${d.resolution}`);

  // 2. scene remux tokens: "BluRay.REMUX", "UHD.BluRay.REMUX", "BDRemux", "DVD.Remux", lone "REMUX"
  s = s.replace(/(?<![A-Za-z0-9])(?:BD|UHD)[-.\s]?Remux(?![A-Za-z0-9])/gi, 'BluRay');
  s = s.replace(/(Blu-?Ray|DVD)([-.\s])Remux(?![A-Za-z0-9])/gi, '$1');
  s = s.replace(/(?<![A-Za-z0-9])Remux([-.\s])(Blu-?Ray)(?![A-Za-z0-9])/gi, '$2');
  s = s.replace(/(?<![A-Za-z0-9])Remux(?![A-Za-z0-9])/gi, /dvd/i.test(s) ? '' : 'BluRay');

  // 3. resolution (downscales), and "UHD" no longer applies below 2160p
  if (has(RES_RE, s)) s = s.replace(RES_RE, d.resolution);
  if (d.resolution !== '2160p') s = s.replace(/(?<![A-Za-z0-9])UHD(?![A-Za-z0-9])[-.\s]?(?=Blu-?Ray)/gi, '');

  // 4. video codec: replace the first codec token, drop any others
  let codecDone = false;
  s = s.replace(VIDEO_CODEC_RE, () => (codecDone ? '' : ((codecDone = true), d.videoCodec)));

  // 5. HDR / Dolby Vision / bit depth
  if (!d.hdr) s = s.replace(HDR_RE, '');
  else {
    if (!d.dolbyVision) s = s.replace(DV_RE, '');
    if (!d.videoCopied) s = s.replace(/HDR10(?:\+|Plus)/gi, 'HDR10'); // dynamic HDR10+ metadata is not carried through an encode
    // a DV-only source keeps its HDR10 base layer: say so
    if (codecDone && !has(HDR_RE, s) && has(DV_RE, base)) s = s.replace(d.videoCodec, join('HDR', d.videoCodec));
  }
  if (has(BIT_RE, s)) s = s.replace(BIT_RE, d.tenBit ? '10bit' : '');
  else if (d.tenBit && codecDone && wasRemux && !d.videoCopied) s = s.replace(d.videoCodec, join('10bit', d.videoCodec));

  // 6. audio: replace the first audio token with the encode's first track, drop the rest (other tracks)
  if (d.audio) {
    const label = join(d.audio.codec.replace(/\s/g, dotted ? '.' : ' '), d.audio.atmos ? 'Atmos' : '', d.audio.channels);
    let audioDone = false;
    s = s.replace(AUDIO_RE, () => (audioDone ? '' : ((audioDone = true), label)));
  }

  // tidy: collapse doubled separators left by removed tokens, empty brackets, stray separators before "-GROUP"
  s = s
    .replace(/\[\s*\]|\(\s*\)/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/ {2,}/g, ' ')
    .replace(/([.\s])-(?=[A-Za-z0-9]+$)/, '-')
    .replace(/\s+\]/g, ']')
    .replace(/\[\s+/g, '[')
    .replace(/[.\s]+$/g, '')
    .replace(/^[.\s]+/g, '');
  return s;
}

// ---------- metadata ----------

export function languageName(code: string) {
  const alias: Record<string, string> = { fra: 'fre', deu: 'ger', zho: 'chi', nld: 'dut', ja: 'jpn', en: 'eng' };
  const c = alias[code] ?? code;
  return LANGUAGES.find((l) => l.code === c)?.label ?? (code === 'und' ? '' : code.toUpperCase());
}

export interface MetadataContext {
  /** File title, e.g. "Blade Runner 2049 (2017)" or "Frieren - S01E05 - Phantoms of the Dead". */
  title?: string;
}

/** Stream title for an audio track: "English · Opus 5.1", keeping commentary / descriptive names from the source. */
export function audioTrackTitle(item: AudioPlanItem): string {
  const src = streamTitle(item.stream);
  if (item.encoder === 'copy' && src) return src;
  const lang = languageName(streamLanguage(item.stream));
  const extra = /commentar/i.test(src) ? 'Commentary' : /descriptive|audio description|\bAD\b/i.test(src) ? 'Audio Description' : '';
  const atmos = item.encoder === 'copy' && /atmos/i.test(src);
  return [lang, [audioCodecLabel(item.encoder, item.stream), atmos ? 'Atmos' : '', channelLabel(item.channels)].filter(Boolean).join(' '), extra].filter(Boolean).join(' · ');
}

export function videoTrackTitle(d: EncodeDescription): string {
  return [d.resolution, d.videoCodecName, d.tenBit ? '10-bit' : '', d.dolbyVision ? 'Dolby Vision' : d.hdr ? 'HDR10' : ''].filter(Boolean).join(' ');
}
