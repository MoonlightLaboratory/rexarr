// Types shared between the rexarr server and web client.

export type Container = 'mkv' | 'mp4' | 'webm' | 'mov';

export type VideoEncoder =
  | 'copy'
  | 'libx264'
  | 'libx265'
  | 'libsvtav1'
  | 'libaom-av1'
  | 'libvpx-vp9'
  | 'h264_videotoolbox'
  | 'hevc_videotoolbox'
  | 'h264_nvenc'
  | 'hevc_nvenc'
  | 'av1_nvenc'
  | 'h264_qsv'
  | 'hevc_qsv'
  | 'av1_qsv'
  | 'h264_vaapi'
  | 'hevc_vaapi'
  | 'av1_vaapi'
  | 'h264_amf'
  | 'hevc_amf'
  | 'av1_amf';

export type AudioEncoder = 'copy' | 'aac' | 'libfdk_aac' | 'libopus' | 'eac3' | 'ac3' | 'flac' | 'truehd';

export type PixelFormat = 'auto' | 'yuv420p' | 'yuv420p10le' | 'p010le' | 'nv12';

export type VideoTune = 'none' | 'animation' | 'film' | 'grain' | 'fastdecode' | 'zerolatency';

export type SubtitleMode = 'copy' | 'none' | 'burn' | 'copy-text';

export interface VideoSettings {
  encoder: VideoEncoder;
  /** CRF / CQ / global quality, interpreted per encoder family. */
  quality: number;
  /** Speed preset. Software: ultrafast..placebo (x264/x265), 0-13 (svt-av1). Hardware: p1-p7 / speed. */
  preset: string;
  pixelFormat: PixelFormat;
  tune: VideoTune;
  /** Downscale so height <= maxHeight (0 = keep source resolution). */
  maxHeight: number;
  /** Keep HDR10 / colour metadata when the source is HDR. */
  hdrPassthrough: boolean;
  /** Bitrate in kbps; only used by encoders/modes that need it (0 = quality based). */
  bitrate: number;
  /** Extra raw ffmpeg args appended after the video options. */
  extraArgs: string;
}

export interface AudioSettings {
  encoder: AudioEncoder;
  /** Bitrate in kbps per stream (0 = encoder default). */
  bitrate: number;
  /** 0 = keep source channel layout, 2 = stereo, 6 = 5.1, 8 = 7.1 */
  channels: number;
  /** ISO 639-2 language codes to keep. Empty = keep all. */
  languages: string[];
  /** Only keep the first matching stream per language. */
  firstMatchOnly: boolean;
  /** Skip commentary tracks (matched by title). */
  dropCommentary: boolean;
}

export interface SubtitleSettings {
  mode: SubtitleMode;
  /** ISO 639-2 language codes to keep. Empty = keep all. */
  languages: string[];
  /** Language to burn in when mode = burn (first match), or empty for first subtitle stream. */
  burnLanguage: string;
  /** Prefer forced subtitles for burn-in. */
  burnForcedOnly: boolean;
  /** Copy font attachments (mkv only). */
  keepFonts: boolean;
}

export interface OutputSettings {
  /** Empty = write next to the source file. */
  directory: string;
  /** Appended to the file name before the extension. */
  suffix: string;
  /** Replace the source file with the transcode (source is deleted after success). */
  replaceOriginal: boolean;
  /** Ask Radarr/Sonarr to rescan after the transcode finishes. */
  notifyArr: boolean;
}

export interface Profile {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  /** Media kind this preset is intended for (used for auto-selection). */
  mediaType: 'any' | 'movie' | 'tv' | 'anime';
  container: Container;
  video: VideoSettings;
  audio: AudioSettings;
  subtitles: SubtitleSettings;
  output: OutputSettings;
  createdAt: string;
  updatedAt: string;
}

export interface ArrConnection {
  enabled: boolean;
  url: string;
  apiKey: string;
}

export interface PathMapping {
  /** Path prefix as reported by the *arr app (e.g. /data/media). */
  remote: string;
  /** Equivalent path visible to rexarr (e.g. /mnt/media). */
  local: string;
}

export interface DiscSettings {
  /** Watch optical drives and create rip entries when a disc is inserted. */
  enabled: boolean;
  /** makemkvcon binary (name on PATH or absolute path). */
  makemkvPath: string;
  /** Where raw rips are written; one sub-folder per disc. */
  ripDirectory: string;
  /** Ignore titles shorter than this (trailers, menus). */
  minTitleSeconds: number;
  /** Seconds between drive polls. */
  pollIntervalSeconds: number;
  /** Start ripping as soon as a disc is identified, without confirmation. */
  autoRip: boolean;
  /** Queue the ripped titles for transcoding with the default profile. */
  autoTranscode: boolean;
  /** Hand the finished files to Radarr / Sonarr for import. */
  autoDeliver: boolean;
  /** Eject the disc when the rip is finished. */
  autoEject: boolean;
  /** Keep the raw MakeMKV rip after a successful transcode. */
  keepRaw: boolean;
}

export interface Settings {
  disc: DiscSettings;
  radarr: ArrConnection;
  sonarr: ArrConnection;
  prowlarr: ArrConnection;
  ffmpegPath: string;
  ffprobePath: string;
  /** Maximum simultaneous encodes. */
  concurrency: number;
  /** Seconds between polls when waiting for an *arr download to import. */
  pollIntervalSeconds: number;
  pathMappings: PathMapping[];
  /** Default profile ids by media type. */
  defaultProfiles: { movie: string; tv: string; anime: string };
  /** Only surface remux releases in search results. */
  remuxOnly: boolean;
}

export type JobStatus =
  | 'waiting'   // waiting for the *arr app to download + import the release
  | 'queued'    // ready for ffmpeg
  | 'probing'
  | 'encoding'
  | 'finalizing'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface JobSource {
  kind: 'movie' | 'episode' | 'file';
  arr?: 'radarr' | 'sonarr';
  /** Radarr movieId or Sonarr seriesId */
  arrId?: number;
  /** Sonarr episodeId(s) the job is tied to. */
  episodeIds?: number[];
  seasonNumber?: number;
  /** Radarr movieFileId / Sonarr episodeFileId once known. */
  fileId?: number;
  /** Release GUID the job was created from (if grabbed via rexarr). */
  releaseGuid?: string;
  releaseTitle?: string;
  /** Path as known by the *arr app. */
  arrPath?: string;
  /** Local path after path mapping. */
  localPath?: string;
}

export interface JobProgress {
  percent: number;
  fps: number;
  speed: string;
  bitrate: string;
  outTimeSeconds: number;
  etaSeconds: number | null;
  frame: number;
  sizeBytes: number;
}

export interface Job {
  id: string;
  title: string;
  subtitle?: string;
  poster?: string;
  status: JobStatus;
  profileId: string;
  profileName: string;
  source: JobSource;
  outputPath?: string;
  progress: JobProgress;
  error?: string;
  log: string[];
  command?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationSeconds?: number;
  inputSizeBytes?: number;
  outputSizeBytes?: number;
}

export interface Release {
  guid: string;
  indexerId: number;
  indexer: string;
  title: string;
  size: number;
  quality: string;
  resolution: number;
  isRemux: boolean;
  seeders: number | null;
  leechers: number | null;
  protocol: 'torrent' | 'usenet' | string;
  ageDays: number;
  languages: string[];
  approved: boolean;
  rejections: string[];
  /** Where the release came from. */
  source: 'radarr' | 'sonarr' | 'prowlarr';
  /** Sonarr: whether this is a full season pack. */
  fullSeason?: boolean;
  /** Prowlarr: direct download URL for the release. */
  downloadUrl?: string;
  /** Sonarr: episodes matched by the release. */
  episodeIds?: number[];
}

export interface MediaFile {
  id: number;
  path: string;
  localPath: string;
  size: number;
  quality: string;
  isRemux: boolean;
  videoCodec?: string;
  audioCodec?: string;
  audioChannels?: number;
  resolution?: string;
  languages?: string[];
}

export interface Movie {
  id: number;
  tmdbId: number;
  title: string;
  year: number;
  overview: string;
  poster?: string;
  fanart?: string;
  monitored: boolean;
  hasFile: boolean;
  file?: MediaFile;
  path: string;
  runtime: number;
  genres: string[];
  status?: string;
  /** 0-100 */
  rating?: number;
  qualityProfile?: string;
  originalLanguage?: string;
  studio?: string;
  certification?: string;
  imdbId?: string;
}

export interface Episode {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  airDate?: string;
  hasFile: boolean;
  monitored: boolean;
  file?: MediaFile;
}

export interface Season {
  seasonNumber: number;
  monitored: boolean;
  episodeCount: number;
  episodeFileCount: number;
  remuxCount: number;
}

export interface Series {
  id: number;
  tvdbId: number;
  title: string;
  year: number;
  overview: string;
  poster?: string;
  fanart?: string;
  monitored: boolean;
  seriesType: 'standard' | 'anime' | 'daily';
  path: string;
  seasons: Season[];
  genres: string[];
  status?: string;
  network?: string;
  runtime?: number;
  /** 0-100 */
  rating?: number;
  endYear?: number;
  qualityProfile?: string;
  originalLanguage?: string;
  certification?: string;
  imdbId?: string;
  statistics: { episodeFileCount: number; episodeCount: number; sizeOnDisk: number; remuxFileCount: number };
}

export interface LookupResult {
  kind: 'movie' | 'series';
  arrId?: number;
  externalId: number;
  title: string;
  year: number;
  overview: string;
  poster?: string;
  inLibrary: boolean;
  seriesType?: string;
}

export interface FfmpegCapabilities {
  available: boolean;
  version: string;
  path: string;
  videoEncoders: VideoEncoder[];
  audioEncoders: AudioEncoder[];
  hwaccels: string[];
  error?: string;
}

export interface ArrStatus {
  name: 'radarr' | 'sonarr' | 'prowlarr';
  configured: boolean;
  ok: boolean;
  version?: string;
  appName?: string;
  error?: string;
}

export interface HealthCheck {
  type: 'ok' | 'warning' | 'error';
  source: string;
  message: string;
  /** Where to go to fix it (client route). */
  link?: string;
}

export interface SystemInfo {
  version: string;
  node: string;
  platform: string;
  dataDir: string;
  uptimeSeconds: number;
  ffmpeg: FfmpegCapabilities;
  arr: ArrStatus[];
  jobs: { active: number; queued: number; waiting: number; done: number; failed: number };
}

export type DriveState = 'empty' | 'open' | 'loaded' | 'loading' | 'unknown';

export interface DiscDrive {
  index: number;
  name: string;
  path: string;
  state: DriveState;
  discLabel?: string;
}

export interface DiscTitle {
  id: number;
  name: string;
  durationSeconds: number;
  sizeBytes: number;
  chapters: number;
  /** File name MakeMKV will write (e.g. t00.mkv). */
  fileName: string;
  sourceFile?: string;
  videoCodec?: string;
  resolution?: string;
  frameRate?: string;
  audio: string[];
  subtitles: string[];
}

export type RipStatus =
  | 'inserted'    // disc detected, not scanned yet
  | 'scanning'    // reading title list
  | 'ready'       // waiting for the user to start (or auto-rip)
  | 'ripping'
  | 'transcoding'
  | 'delivering'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface RipMedia {
  kind: 'movie' | 'series' | 'unknown';
  title: string;
  year?: number;
  /** TMDB id (movie) or TVDB id (series). */
  externalId?: number;
  /** Radarr movie id / Sonarr series id once known. */
  arrId?: number;
  poster?: string;
  seriesType?: 'standard' | 'anime' | 'daily';
  seasonNumber?: number;
  /** Episode number assigned to the first ripped title. */
  episodeStart?: number;
}

export interface RipOptions {
  transcode: boolean;
  deliver: boolean;
  eject: boolean;
  keepRaw: boolean;
}

export interface RippedFile {
  titleId: number;
  path: string;
  sizeBytes: number;
  /** Transcode job created for this file, if any. */
  jobId?: string;
  /** Final path after transcode / delivery. */
  finalPath?: string;
}

export interface DiscRip {
  id: string;
  driveIndex: number;
  drivePath: string;
  driveName: string;
  label: string;
  volumeName: string;
  discType: 'bluray' | 'dvd' | 'unknown';
  status: RipStatus;
  media: RipMedia;
  titles: DiscTitle[];
  selectedTitleIds: number[];
  profileId?: string;
  profileName?: string;
  options: RipOptions;
  outputDir?: string;
  files: RippedFile[];
  progress: { percent: number; step: string; titleIndex: number; titleCount: number };
  log: string[];
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface MakemkvInfo {
  available: boolean;
  path: string;
  version?: string;
  error?: string;
}

export type ServerEvent =
  | { type: 'rip'; rip: DiscRip }
  | { type: 'rips'; rips: DiscRip[] }
  | { type: 'rip-removed'; id: string }
  | { type: 'drives'; drives: DiscDrive[] }
  | { type: 'job'; job: Job }
  | { type: 'jobs'; jobs: Job[] }
  | { type: 'job-removed'; id: string }
  | { type: 'log'; jobId: string; line: string }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; message: string };
