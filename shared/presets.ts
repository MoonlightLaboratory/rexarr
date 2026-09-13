import type { Profile, AudioSettings, OutputSettings, SubtitleSettings, VideoSettings } from './types.js';

const now = '2026-01-01T00:00:00.000Z';

const baseVideo: VideoSettings = {
  encoder: 'libx265',
  quality: 20,
  preset: 'slow',
  pixelFormat: 'yuv420p10le',
  tune: 'none',
  maxHeight: 0,
  hdrPassthrough: true,
  bitrate: 0,
  extraArgs: '',
};

const baseAudio: AudioSettings = {
  encoder: 'copy',
  bitrate: 0,
  channels: 0,
  languages: [],
  firstMatchOnly: false,
  dropCommentary: true,
};

const baseSubs: SubtitleSettings = {
  mode: 'copy',
  languages: [],
  burnLanguage: '',
  burnForcedOnly: false,
  keepFonts: true,
};

const baseOutput: OutputSettings = {
  directory: '',
  suffix: '',
  replaceOriginal: false,
  notifyArr: true,
};

function make(p: Partial<Profile> & { id: string; name: string }): Profile {
  return {
    description: '',
    builtin: true,
    mediaType: 'any',
    container: 'mkv',
    createdAt: now,
    updatedAt: now,
    ...p,
    video: { ...baseVideo, ...(p.video ?? {}) },
    audio: { ...baseAudio, ...(p.audio ?? {}) },
    subtitles: { ...baseSubs, ...(p.subtitles ?? {}) },
    output: { ...baseOutput, ...(p.output ?? {}) },
  };
}

/** Built-in presets. They are read-only in the UI but can be cloned. */
export const BUILTIN_PROFILES: Profile[] = [
  make({
    id: 'builtin-anime-x265',
    name: 'Anime · x265 10-bit',
    description:
      'Tuned for animation: HEVC 10-bit with the animation tune, Japanese + English audio in Opus, all subtitles and fonts kept for typesetting.',
    mediaType: 'anime',
    video: { ...baseVideo, encoder: 'libx265', quality: 18, preset: 'slow', tune: 'animation', pixelFormat: 'yuv420p10le' },
    audio: { ...baseAudio, encoder: 'libopus', bitrate: 192, languages: ['jpn', 'eng'], firstMatchOnly: false },
    subtitles: { ...baseSubs, mode: 'copy', keepFonts: true },
  }),
  make({
    id: 'builtin-anime-av1',
    name: 'Anime · SVT-AV1',
    description: 'Smaller files for long-running series. AV1 10-bit via SVT-AV1 preset 6, Opus audio, subtitles and fonts kept.',
    mediaType: 'anime',
    video: { ...baseVideo, encoder: 'libsvtav1', quality: 28, preset: '6', tune: 'none', pixelFormat: 'yuv420p10le', extraArgs: '-svtav1-params tune=0:film-grain=0' },
    audio: { ...baseAudio, encoder: 'libopus', bitrate: 160, languages: ['jpn', 'eng'] },
    subtitles: { ...baseSubs, mode: 'copy', keepFonts: true },
  }),
  make({
    id: 'builtin-movie-4k-hdr',
    name: 'Movie · 4K HDR x265',
    description: 'UHD remux to HEVC 10-bit with HDR10 metadata passthrough. Lossless/HD audio kept untouched, subtitles copied.',
    mediaType: 'movie',
    video: { ...baseVideo, encoder: 'libx265', quality: 18, preset: 'slow', pixelFormat: 'yuv420p10le', hdrPassthrough: true, tune: 'none' },
    audio: { ...baseAudio, encoder: 'copy', dropCommentary: true },
    subtitles: { ...baseSubs, mode: 'copy' },
  }),
  make({
    id: 'builtin-movie-1080p',
    name: 'Movie · 1080p x265',
    description: 'Balanced quality/size for 1080p remuxes. HEVC 10-bit CRF 20, E-AC-3 640k 5.1 audio, subtitles copied.',
    mediaType: 'movie',
    video: { ...baseVideo, encoder: 'libx265', quality: 20, preset: 'slow', pixelFormat: 'yuv420p10le' },
    audio: { ...baseAudio, encoder: 'eac3', bitrate: 640, channels: 6 },
    subtitles: { ...baseSubs, mode: 'copy' },
  }),
  make({
    id: 'builtin-movie-grain',
    name: 'Movie · Film grain x265',
    description: 'For grainy film sources: x265 grain tune preserves texture at a slightly larger size.',
    mediaType: 'movie',
    video: { ...baseVideo, encoder: 'libx265', quality: 19, preset: 'slow', tune: 'grain', pixelFormat: 'yuv420p10le' },
    audio: { ...baseAudio, encoder: 'copy' },
    subtitles: { ...baseSubs, mode: 'copy' },
  }),
  make({
    id: 'builtin-tv-1080p',
    name: 'TV · 1080p x265',
    description: 'Episode-friendly HEVC encode. CRF 21, medium preset, AAC stereo + original surround kept, subtitles copied.',
    mediaType: 'tv',
    video: { ...baseVideo, encoder: 'libx265', quality: 21, preset: 'medium', pixelFormat: 'yuv420p10le' },
    audio: { ...baseAudio, encoder: 'libopus', bitrate: 192, channels: 0, languages: ['eng'] },
    subtitles: { ...baseSubs, mode: 'copy', languages: ['eng'] },
  }),
  make({
    id: 'builtin-web-mp4',
    name: 'Web · H.264 MP4',
    description: 'Maximum compatibility: H.264 8-bit 1080p in MP4 with AAC stereo. Text subtitles converted to mov_text.',
    mediaType: 'any',
    container: 'mp4',
    video: { ...baseVideo, encoder: 'libx264', quality: 19, preset: 'slow', pixelFormat: 'yuv420p', maxHeight: 1080, hdrPassthrough: false },
    audio: { ...baseAudio, encoder: 'aac', bitrate: 192, channels: 2 },
    subtitles: { ...baseSubs, mode: 'copy-text', keepFonts: false },
  }),
  make({
    id: 'builtin-hw-videotoolbox',
    name: 'Fast · HEVC VideoToolbox',
    description: 'Apple Silicon hardware HEVC encode. Very fast, larger files than x265 at similar quality.',
    mediaType: 'any',
    video: { ...baseVideo, encoder: 'hevc_videotoolbox', quality: 60, preset: '', pixelFormat: 'p010le' },
    audio: { ...baseAudio, encoder: 'copy' },
    subtitles: { ...baseSubs, mode: 'copy' },
  }),
  make({
    id: 'builtin-hw-nvenc',
    name: 'Fast · HEVC NVENC',
    description: 'NVIDIA hardware HEVC encode (p6 preset, CQ 24). Good for bulk conversions.',
    mediaType: 'any',
    video: { ...baseVideo, encoder: 'hevc_nvenc', quality: 24, preset: 'p6', pixelFormat: 'p010le' },
    audio: { ...baseAudio, encoder: 'copy' },
    subtitles: { ...baseSubs, mode: 'copy' },
  }),
  make({
    id: 'builtin-remux-audio-only',
    name: 'Remux · Keep video, Opus audio',
    description: 'Leaves the video stream untouched and only re-encodes audio to Opus. Quick way to shrink lossless audio.',
    mediaType: 'any',
    video: { ...baseVideo, encoder: 'copy' },
    audio: { ...baseAudio, encoder: 'libopus', bitrate: 256 },
    subtitles: { ...baseSubs, mode: 'copy' },
  }),
];

export const VIDEO_ENCODER_INFO: Record<string, { label: string; family: 'copy' | 'x264' | 'x265' | 'svtav1' | 'aom' | 'vpx' | 'videotoolbox' | 'nvenc' | 'qsv' | 'vaapi' | 'amf'; codec: string; qualityLabel: string; qualityRange: [number, number]; presets: string[] }> = {
  copy: { label: 'Copy (no re-encode)', family: 'copy', codec: 'source', qualityLabel: '—', qualityRange: [0, 0], presets: [] },
  libx264: { label: 'H.264 (libx264)', family: 'x264', codec: 'h264', qualityLabel: 'CRF', qualityRange: [0, 51], presets: ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow', 'placebo'] },
  libx265: { label: 'HEVC (libx265)', family: 'x265', codec: 'hevc', qualityLabel: 'CRF', qualityRange: [0, 51], presets: ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow', 'placebo'] },
  libsvtav1: { label: 'AV1 (SVT-AV1)', family: 'svtav1', codec: 'av1', qualityLabel: 'CRF', qualityRange: [0, 63], presets: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13'] },
  'libaom-av1': { label: 'AV1 (libaom)', family: 'aom', codec: 'av1', qualityLabel: 'CRF', qualityRange: [0, 63], presets: ['0', '1', '2', '3', '4', '5', '6', '7', '8'] },
  'libvpx-vp9': { label: 'VP9 (libvpx)', family: 'vpx', codec: 'vp9', qualityLabel: 'CRF', qualityRange: [0, 63], presets: ['0', '1', '2', '3', '4', '5'] },
  h264_videotoolbox: { label: 'H.264 VideoToolbox (Apple)', family: 'videotoolbox', codec: 'h264', qualityLabel: 'Quality (1-100)', qualityRange: [1, 100], presets: [] },
  hevc_videotoolbox: { label: 'HEVC VideoToolbox (Apple)', family: 'videotoolbox', codec: 'hevc', qualityLabel: 'Quality (1-100)', qualityRange: [1, 100], presets: [] },
  h264_nvenc: { label: 'H.264 NVENC (NVIDIA)', family: 'nvenc', codec: 'h264', qualityLabel: 'CQ', qualityRange: [0, 51], presets: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'] },
  hevc_nvenc: { label: 'HEVC NVENC (NVIDIA)', family: 'nvenc', codec: 'hevc', qualityLabel: 'CQ', qualityRange: [0, 51], presets: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'] },
  av1_nvenc: { label: 'AV1 NVENC (NVIDIA)', family: 'nvenc', codec: 'av1', qualityLabel: 'CQ', qualityRange: [0, 63], presets: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'] },
  h264_qsv: { label: 'H.264 QuickSync (Intel)', family: 'qsv', codec: 'h264', qualityLabel: 'ICQ', qualityRange: [1, 51], presets: ['veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'] },
  hevc_qsv: { label: 'HEVC QuickSync (Intel)', family: 'qsv', codec: 'hevc', qualityLabel: 'ICQ', qualityRange: [1, 51], presets: ['veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'] },
  av1_qsv: { label: 'AV1 QuickSync (Intel)', family: 'qsv', codec: 'av1', qualityLabel: 'ICQ', qualityRange: [1, 63], presets: ['veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'] },
  h264_vaapi: { label: 'H.264 VAAPI (Linux)', family: 'vaapi', codec: 'h264', qualityLabel: 'QP', qualityRange: [0, 52], presets: [] },
  hevc_vaapi: { label: 'HEVC VAAPI (Linux)', family: 'vaapi', codec: 'hevc', qualityLabel: 'QP', qualityRange: [0, 52], presets: [] },
  av1_vaapi: { label: 'AV1 VAAPI (Linux)', family: 'vaapi', codec: 'av1', qualityLabel: 'QP', qualityRange: [0, 255], presets: [] },
  h264_amf: { label: 'H.264 AMF (AMD)', family: 'amf', codec: 'h264', qualityLabel: 'QP', qualityRange: [0, 51], presets: ['speed', 'balanced', 'quality'] },
  hevc_amf: { label: 'HEVC AMF (AMD)', family: 'amf', codec: 'hevc', qualityLabel: 'QP', qualityRange: [0, 51], presets: ['speed', 'balanced', 'quality'] },
  av1_amf: { label: 'AV1 AMF (AMD)', family: 'amf', codec: 'av1', qualityLabel: 'QP', qualityRange: [0, 255], presets: ['speed', 'balanced', 'quality'] },
};

export const AUDIO_ENCODER_INFO: Record<string, { label: string; defaultBitrate: number; lossless: boolean }> = {
  copy: { label: 'Copy (no re-encode)', defaultBitrate: 0, lossless: true },
  aac: { label: 'AAC (ffmpeg native)', defaultBitrate: 192, lossless: false },
  libfdk_aac: { label: 'AAC (libfdk_aac)', defaultBitrate: 192, lossless: false },
  libopus: { label: 'Opus', defaultBitrate: 192, lossless: false },
  eac3: { label: 'E-AC-3 (Dolby Digital Plus)', defaultBitrate: 640, lossless: false },
  ac3: { label: 'AC-3 (Dolby Digital)', defaultBitrate: 448, lossless: false },
  flac: { label: 'FLAC (lossless)', defaultBitrate: 0, lossless: true },
  truehd: { label: 'TrueHD (lossless)', defaultBitrate: 0, lossless: true },
};

export const CONTAINER_INFO: Record<string, { label: string; ext: string; videoCodecs: string[]; audioCodecs: string[]; textSubs: string; bitmapSubs: boolean; attachments: boolean }> = {
  mkv: { label: 'Matroska (.mkv)', ext: 'mkv', videoCodecs: ['*'], audioCodecs: ['*'], textSubs: 'copy', bitmapSubs: true, attachments: true },
  mp4: { label: 'MP4 (.mp4)', ext: 'mp4', videoCodecs: ['h264', 'hevc', 'av1', 'mpeg4'], audioCodecs: ['aac', 'ac3', 'eac3', 'opus', 'flac', 'alac', 'mp3'], textSubs: 'mov_text', bitmapSubs: false, attachments: false },
  webm: { label: 'WebM (.webm)', ext: 'webm', videoCodecs: ['vp9', 'av1', 'vp8'], audioCodecs: ['opus', 'vorbis'], textSubs: 'webvtt', bitmapSubs: false, attachments: false },
  mov: { label: 'QuickTime (.mov)', ext: 'mov', videoCodecs: ['h264', 'hevc', 'prores', 'av1'], audioCodecs: ['aac', 'ac3', 'eac3', 'alac', 'pcm_s16le', 'pcm_s24le'], textSubs: 'mov_text', bitmapSubs: false, attachments: false },
};

export const LANGUAGES: { code: string; label: string }[] = [
  { code: 'eng', label: 'English' },
  { code: 'jpn', label: 'Japanese' },
  { code: 'fre', label: 'French' },
  { code: 'ger', label: 'German' },
  { code: 'spa', label: 'Spanish' },
  { code: 'ita', label: 'Italian' },
  { code: 'por', label: 'Portuguese' },
  { code: 'kor', label: 'Korean' },
  { code: 'chi', label: 'Chinese' },
  { code: 'rus', label: 'Russian' },
  { code: 'dut', label: 'Dutch' },
  { code: 'swe', label: 'Swedish' },
  { code: 'nor', label: 'Norwegian' },
  { code: 'dan', label: 'Danish' },
  { code: 'fin', label: 'Finnish' },
  { code: 'pol', label: 'Polish' },
  { code: 'hin', label: 'Hindi' },
  { code: 'ara', label: 'Arabic' },
  { code: 'tha', label: 'Thai' },
  { code: 'und', label: 'Undetermined' },
];

export const DEFAULT_SETTINGS = {
  disc: {
    enabled: false,
    makemkvPath: 'makemkvcon',
    ripDirectory: '',
    minTitleSeconds: 600,
    pollIntervalSeconds: 15,
    autoRip: false,
    autoTranscode: true,
    autoDeliver: true,
    autoEject: true,
    keepRaw: false,
  },
  radarr: { enabled: false, url: 'http://localhost:7878', apiKey: '' },
  sonarr: { enabled: false, url: 'http://localhost:8989', apiKey: '' },
  prowlarr: { enabled: false, url: 'http://localhost:9696', apiKey: '' },
  ffmpegPath: 'ffmpeg',
  ffprobePath: 'ffprobe',
  concurrency: 1,
  pollIntervalSeconds: 60,
  pathMappings: [],
  defaultProfiles: { movie: 'builtin-movie-1080p', tv: 'builtin-tv-1080p', anime: 'builtin-anime-x265' },
  remuxOnly: true,
};
