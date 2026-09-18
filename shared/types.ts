// Types shared between the Rexarr server and web client.

export type Container = 'mkv' | 'mp4' | 'webm' | 'mov' | 'flac' | 'mp3' | 'opus' | 'ogg' | 'wv' | 'ape';

/** Audio-only containers used by music profiles (encoded with fre:ac). */
export const MUSIC_CONTAINERS = ['flac', 'mp3', 'opus', 'ogg', 'wv', 'ape'] as const;

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
  | 'av1_amf'
  | 'h264_rkmpp'
  | 'hevc_rkmpp'
  | 'h264_v4l2m2m'
  | 'hevc_v4l2m2m';

/** Global hardware acceleration method (Settings → Transcoding). */
export type HwAccel = 'none' | 'amf' | 'nvenc' | 'qsv' | 'vaapi' | 'rkmpp' | 'videotoolbox' | 'v4l2';

export interface TranscodingSettings {
  hardwareAcceleration: HwAccel;
  /** VAAPI / QSV: render node (/dev/dri/renderD128). NVENC: GPU index. Empty = default device. */
  device: string;
  /** Decode on the GPU as well when the source codec allows it. */
  hardwareDecoding: boolean;
  /** Retry an encode on the CPU when the hardware encode fails. */
  fallbackToSoftware: boolean;
}

export interface HwDevices {
  platform: string;
  renderNodes: { path: string; driver?: string; vendor?: string }[];
  nvidiaGpus: { index: number; name: string }[];
  /** method -> encoders present in the detected ffmpeg build */
  encoders: Record<HwAccel, VideoEncoder[]>;
}

export interface HwTestResult {
  ok: boolean;
  method: HwAccel;
  encoder?: string;
  fps?: number;
  durationMs: number;
  command: string;
  error?: string;
  /** Extra information for a passing test (e.g. bitrate mode had to be used). */
  note?: string;
  log: string[];
}

/** libfdk_aac is accepted for old profiles only (not open source; encoded as FFmpeg's native AAC). */
export type AudioEncoder = 'copy' | 'aac' | 'libfdk_aac' | 'libopus' | 'eac3' | 'ac3' | 'flac' | 'truehd' | 'libmp3lame' | 'libvorbis' | 'wavpack' | 'ape';

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
  /** 'auto' follows Settings → Transcoding; 'software' always encodes on the CPU. */
  hwMode?: 'auto' | 'software';
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
  // ---- music profiles ----
  /** VBR quality instead of a bitrate: LAME V0–V9 (0 best) for MP3, 0–10 for Vorbis. Undefined = use bitrate. */
  vbrQuality?: number;
  /** Resample above this rate down to it (e.g. 44100 or 48000); 0 = keep. */
  maxSampleRate?: number;
  /** 16 or 24 to reduce bit depth (dithered); 0 = keep. */
  bitDepth?: 0 | 16 | 24;
  /** FLAC compression level 0–12 (all levels are lossless). */
  compressionLevel?: number;
  /** MQA sources are only ever copied bit-perfect (FLAC, no resampling / dithering / lossy), so MQA survives. */
  preserveMqa?: boolean;
  /** Scan loudness and write REPLAYGAIN_TRACK_GAIN / PEAK tags. */
  replayGain?: boolean;
  /** Keep embedded cover art (FLAC, MP3, Vorbis, WavPack, Monkey's Audio; Opus files carry tags only). */
  embedCover?: boolean;
  /** Opus complexity / LAME mode etc. are derived; this is the Opus encoder complexity 0–10. */
  opusComplexity?: number;
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
  /** Rewrite release tokens in the file name to describe the encode (Remux-1080p → Bluray-1080p, AVC → x265…). */
  renameTokens: boolean;
  /** Write clean metadata: file title, track titles ("English · Opus 5.1"), default track, no stale source tags. */
  cleanMetadata: boolean;
}

export interface Profile {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  /** Media kind this preset is intended for (used for auto-selection). */
  mediaType: 'any' | 'movie' | 'tv' | 'anime' | 'music';
  container: Container;
  video: VideoSettings;
  audio: AudioSettings;
  subtitles: SubtitleSettings;
  output: OutputSettings;
  createdAt: string;
  updatedAt: string;
}

export interface MusicFile {
  id: number;
  path: string;
  localPath: string;
  size: number;
  /** Lidarr quality name, e.g. "FLAC 24bit", "MP3-320". */
  quality: string;
  codec?: string;
  bitDepth?: number;
  sampleRate?: number;
  bitrate?: number;
  channels?: number;
  lossless: boolean;
  mqa?: MqaInfo;
}

export interface Artist {
  id: number;
  /** MusicBrainz artist id. */
  foreignArtistId: string;
  name: string;
  sortName?: string;
  overview: string;
  poster?: string;
  fanart?: string;
  path: string;
  genres: string[];
  status?: string;
  monitored: boolean;
  qualityProfile?: string;
  rating?: number;
  links?: { name: string; url: string }[];
  statistics: { albumCount: number; trackCount: number; trackFileCount: number; sizeOnDisk: number };
}

export interface Album {
  id: number;
  artistId: number;
  artist?: string;
  foreignAlbumId: string;
  title: string;
  overview?: string;
  releaseDate?: string;
  year?: number;
  albumType: string;
  secondaryTypes?: string[];
  genres?: string[];
  cover?: string;
  monitored: boolean;
  rating?: number;
  mediumCount?: number;
  statistics: { trackCount: number; trackFileCount: number; sizeOnDisk: number };
}

export interface Track {
  id: number;
  albumId: number;
  trackNumber: string;
  absoluteTrackNumber: number;
  mediumNumber: number;
  title: string;
  durationMs: number;
  explicit?: boolean;
  hasFile: boolean;
  file?: MusicFile;
}

/** Settings → Connections → Soulseek (slskd). */
export interface SlskdConnection {
  enabled: boolean;
  url: string;
  apiKey: string;
  /** slskd's download folder as Rexarr sees it; empty = use the path slskd reports (with path mappings). */
  downloadsPath: string;
  /** Ignore peers with more queued uploads than this. */
  maxQueueLength: number;
  /** Search time limit in seconds. */
  searchTimeoutSeconds: number;
}

/** Settings → Media Management → Local media: folders scanned for titles the *arr apps do not manage. */
export interface LocalMediaFolder {
  path: string;
  /** What the folder holds; "auto" guesses from folder names (Movies, TV Shows, Anime, Music…) and file names. */
  kind: 'auto' | 'movie' | 'series' | 'music';
}

export interface LocalMediaSettings {
  enabled: boolean;
  /** Also scan the local side of every path mapping. */
  usePathMappings: boolean;
  folders: LocalMediaFolder[];
  /** Folder names skipped anywhere in the tree (case-insensitive). */
  exclude: string[];
  /** Hide titles whose folder belongs to Radarr / Sonarr / Lidarr. */
  hideArrManaged: boolean;
  /** Rescan every N hours (0 = only on demand). */
  rescanHours: number;
  /** Match titles to TMDb (movies, series) and MusicBrainz + Cover Art Archive (albums). */
  metadata: boolean;
  /** TMDb API key (v3) or read access token (v4). Without one, movies use Radarr's and series Sonarr's lookup. */
  tmdbApiKey: string;
  /** TMDb language, e.g. en-US or ja-JP. */
  metadataLanguage: string;
}

/** Metadata matched for a local title. */
export interface LocalMeta {
  status: 'matched' | 'none' | 'error';
  source?: 'tmdb' | 'radarr' | 'sonarr' | 'musicbrainz';
  /** TMDb / TVDB id, or MusicBrainz release group id. */
  externalId?: string;
  url?: string;
  title?: string;
  originalTitle?: string;
  year?: number;
  overview?: string;
  poster?: string;
  backdrop?: string;
  genres?: string[];
  /** 0–100 */
  rating?: number;
  runtimeMinutes?: number;
  artist?: string;
  /** MusicBrainz primary type (Album, Single, EP…). */
  type?: string;
  /** Match confidence 0–100. */
  score?: number;
  manual?: boolean;
  error?: string;
  matchedAt: string;
}

/** A candidate for Fix Match. */
export interface LocalMetaCandidate extends Omit<LocalMeta, 'status' | 'matchedAt'> {
  source: NonNullable<LocalMeta['source']>;
  externalId: string;
}

export interface LocalFile {
  path: string;
  size: number;
  mtime: number;
  season?: number;
  episode?: number;
  /** Anime absolute episode ("[Group] Show - 105"). */
  absolute?: number;
  disc?: number;
  track?: number;
  resolution?: number;
  isRemux?: boolean;
  quality?: string;
}

export interface LocalItem {
  /** Stable id (hash of kind + folder / title). */
  id: string;
  kind: 'movie' | 'series' | 'album';
  title: string;
  year?: number;
  artist?: string;
  anime?: boolean;
  /** The title's folder (or the folder holding a loose file). */
  folder: string;
  /** Scan root it was found under. */
  root: string;
  poster?: boolean;
  files: LocalFile[];
  size: number;
  /** Matched metadata (attached when served). */
  meta?: LocalMeta;
}

export interface LocalScanStatus {
  scanning: boolean;
  scannedAt?: string;
  durationMs?: number;
  roots: { path: string; kind: LocalMediaFolder['kind']; fromMapping: boolean; exists: boolean }[];
  counts: { movie: number; series: number; album: number; files: number; hiddenArr: number };
  progress?: { folders: number; files: number; current?: string };
  metadata?: { running: boolean; done: number; total: number; matched: number; source: string };
  errors: string[];
}

export interface ArrConnection {
  enabled: boolean;
  url: string;
  apiKey: string;
}

export interface LidarrConnection extends ArrConnection {
  /** Split finished "image + cue" downloads into tracks so Lidarr can import them (default on). */
  splitCueImages?: boolean;
}

export interface PathMapping {
  /** Path prefix as reported by the *arr app (e.g. /data/media). */
  remote: string;
  /** Equivalent path visible to Rexarr (e.g. /mnt/media). */
  local: string;
  /** Only apply to one app (needed when two apps map different remote paths onto the same local folder). */
  app?: 'all' | 'radarr' | 'sonarr' | 'lidarr' | 'slskd';
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
  /** Which audio tracks a rip keeps: the best one per language, or every track on the disc. */
  audioMode: 'best' | 'all';
  /** Also list and rip short titles – creditless OP / ED, OVAs, bonus episodes – as specials or extras. */
  includeExtras: boolean;
  /** Shortest title still listed as an extra, in seconds. */
  extraMinSeconds: number;
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
  /**
   * Testing aid: a folder of .iso files or DVD / Blu-ray folders (VIDEO_TS, BDMV). Each one shows up as a
   * loaded virtual drive and is ripped through makemkvcon's iso:/file: sources. Empty = off.
   */
  virtualDriveDirectory: string;
  /** Explicitly linked disc images / folders that behave like always-loaded drives. */
  virtualDrives: VirtualDrive[];
  /** Real drives added by device path, for drives MakeMKV does not list on its own. */
  physicalDrives: PhysicalDrive[];
  /** Audio CDs (ripped with cdparanoia to FLAC, not MakeMKV). */
  cd: CdSettings;
}

export interface CdSettings {
  enabled: boolean;
  /** cdparanoia or cd-paranoia (libcdio); name on PATH or absolute path. Empty = auto-detect. */
  ripperPath: string;
  /** Read offset correction in samples for your drive (AccurateRip drive offset list). */
  readOffset: number;
  /** Look the disc up on MusicBrainz for artist, album, track titles and cover art. */
  musicbrainz: boolean;
  /** Scan the rip for an MQA stream (MQA-CD) and tag it. */
  detectMqa: boolean;
  /** FLAC compression level for the rip (lossless at any level). */
  compressionLevel: number;
  /** Hand the album to Lidarr when finished. */
  deliverToLidarr: boolean;
}

/** MQA stream detection result (see server/src/audio/mqa.ts). */
export interface MqaInfo {
  detected: boolean;
  /** Original (studio) sample rate signalled by the stream, when it could be read. */
  originalSampleRate?: number;
  /** Bit position of the MQA signalling in the samples (debug). */
  bitPosition?: number;
  /** Seconds of audio that were scanned. */
  scannedSeconds: number;
}

/** A MusicBrainz release matched to a CD. */
export interface MusicBrainzRelease {
  releaseId: string;
  releaseGroupId?: string;
  title: string;
  artist: string;
  artistId?: string;
  date?: string;
  country?: string;
  label?: string;
  barcode?: string;
  discNumber: number;
  discCount: number;
  tracks: { number: number; title: string; artist?: string; lengthMs?: number; recordingId?: string }[];
  coverUrl?: string;
}

/** Audio CD details on a rip. */
export interface CdInfo {
  discId: string;
  /** "1 12 198745 150 …" MusicBrainz TOC string. */
  toc: string;
  tracks: { number: number; startSector: number; sectors: number }[];
  releases: MusicBrainzRelease[];
  /** Index into releases of the chosen match. */
  selected: number;
  mqa?: MqaInfo;
}

export interface VirtualDrive {
  id: string;
  /** .iso / .img file or a folder containing BDMV / VIDEO_TS. */
  path: string;
  /** Optional display label; defaults to the file / folder name. */
  label?: string;
  addedAt: string;
}

export interface AutoTranscodeSettings {
  /** Queue every new Blu-ray remux found in Radarr / Sonarr automatically. */
  enabled: boolean;
  /** Also transcode remuxes that were already in the library when auto transcode was switched on. */
  includeExisting: boolean;
  sources: { radarr: boolean; sonarr: boolean };
  scanIntervalMinutes: number;
  /** Cap per scan so a big library is worked through gradually. */
  maxPerScan: number;
  /** Profile per media type; empty = use the default profile from Settings. */
  profiles: { movie: string; tv: string; anime: string };
}

export interface AutoScanItem {
  arr: 'radarr' | 'sonarr';
  arrId: number;
  fileId: number;
  episodeIds?: number[];
  seasonNumber?: number;
  title: string;
  subtitle?: string;
  poster?: string;
  path: string;
  localPath: string;
  quality: string;
  sizeBytes: number;
  mediaType: 'movie' | 'tv' | 'anime';
  profileName?: string;
  jobId?: string;
}

export interface AutoScanResult {
  at: string;
  reason: string;
  dryRun: boolean;
  found: number;
  queued: AutoScanItem[];
  /** Remuxes left for the next scan because of maxPerScan. */
  pending: AutoScanItem[];
  skippedSeen: number;
  skippedMissing: string[];
  skippedNoProfile: number;
  /** Set when this scan only recorded the existing library. */
  baseline?: number;
  errors: string[];
  durationMs: number;
}

export interface AutoStatus {
  enabled: boolean;
  scanning: boolean;
  baselineAt?: string;
  seen: number;
  counts: { queued: number; baseline: number; output: number; existing: number };
  lastScan?: AutoScanResult;
}

export interface AnidbSettings {
  /** Download AniDB titles + Anime-Lists mappings and use them for anime detection, titles and disc identification. */
  enabled: boolean;
}

/** Settings → General (Sonarr's Host / Security / Proxy / Logging / Updates / Backups). */
export interface GeneralSettings {
  host: {
    /** "*" for all interfaces, "localhost", or an IP address. */
    bindAddress: string;
    port: number;
    /** Reverse proxy sub-path, e.g. "/rexarr". Empty for none. */
    urlBase: string;
    /** Shown in the browser tab. */
    instanceName: string;
    /** External URL including http(s)://, port and URL base – used for links such as webhook URLs. */
    applicationUrl: string;
    enableSsl: boolean;
    sslPort: number;
    /** PEM certificate, or a .pfx / .p12 bundle (then sslKeyPath is not needed). */
    sslCertPath: string;
    sslKeyPath: string;
    sslCertPassword: string;
  };
  security: {
    authentication: 'none' | 'basic' | 'forms';
    authenticationRequired: 'enabled' | 'disabledForLocalAddresses';
    username: string;
    /** scrypt hash; never sent to the browser (sent as "" with passwordSet). */
    passwordHash: string;
    passwordSet?: boolean;
    /** Write-only: a new password to hash on save. */
    password?: string;
    apiKey: string;
    certificateValidation: 'enabled' | 'disabledForLocalAddresses' | 'disabled';
  };
  proxy: {
    enabled: boolean;
    type: 'http';
    hostname: string;
    port: number;
    username: string;
    password: string;
    /** Comma separated hosts / wildcards that skip the proxy, e.g. "*.local, 192.168.1.*". */
    bypassFilter: string;
    bypassLocalAddresses: boolean;
  };
  logging: {
    level: 'info' | 'debug' | 'trace';
    /** Log file size before rotating, in MB. */
    sizeLimitMb: number;
  };
  updates: {
    branch: string;
    automatic: boolean;
    mechanism: 'builtIn' | 'script' | 'docker' | 'external';
    scriptPath: string;
  };
  backups: {
    /** Relative paths are under the config directory. Empty = the default Backups folder. */
    folder: string;
    intervalDays: number;
    retentionDays: number;
  };
}

/** What the running process actually uses (host settings need a restart; environment variables win). */
export interface HostRuntime {
  bindAddress: string;
  port: number;
  urlBase: string;
  sslPort?: number;
  /** Settings fields set by environment variables (read-only in the UI). */
  envOverrides: string[];
  docker: boolean;
  restartRequired: boolean;
  configDir: string;
  defaultBackupFolder: string;
}

export interface Settings {
  general: GeneralSettings;
  transcoding: TranscodingSettings;
  /** Fail an encode that makes no progress for this many minutes (e.g. a stalled network share); 0 = never. */
  stallTimeoutMinutes?: number;
  /** Where ffmpeg writes while encoding: the Transcodes folder (default) or next to the final output. */
  transcodeTemp: 'transcodes' | 'output';
  auto: AutoTranscodeSettings;
  anidb: AnidbSettings;
  disc: DiscSettings;
  radarr: ArrConnection;
  sonarr: ArrConnection;
  prowlarr: ArrConnection;
  lidarr: LidarrConnection;
  localMedia: LocalMediaSettings;
  slskd: SlskdConnection;
  /** MusicBrainz / Cover Art Archive lookups (CDs, music metadata). */
  musicbrainz: { enabled: boolean };
  ffmpegPath: string;
  ffprobePath: string;
  /** fre:ac command line encoder (freaccmd) for music profiles and CD ripping. Empty = auto-detect. */
  freacPath: string;
  /** Maximum simultaneous encodes. */
  concurrency: number;
  /** Seconds between polls when waiting for an *arr download to import. */
  pollIntervalSeconds: number;
  pathMappings: PathMapping[];
  /** Default profile ids by media type. */
  defaultProfiles: { movie: string; tv: string; anime: string; music: string };
  /** Only surface remux releases in search results. */
  remuxOnly: boolean;
  /** With remuxOnly, also show full-disc releases (ISO / BDMV / VIDEO_TS). */
  searchDiscReleases: boolean;
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
  /** Set for grabbed full-disc releases: the download is ripped with MakeMKV instead of being imported as a file. */
  disc?: { format?: 'uhd' | 'bluray' | 'dvd'; ripIds?: string[]; /** Last status line (so polling does not repeat it). */ status?: string };
  /** Soulseek downloads (via slskd): files requested from one user's folder, imported into Lidarr when complete. */
  soulseek?: { username: string; directory: string; files: { filename: string; size: number }[]; status?: string };
  kind: 'movie' | 'episode' | 'file' | 'album' | 'track';
  arr?: 'radarr' | 'sonarr' | 'lidarr';
  /** Lidarr album the job is tied to (arrId is the artist). */
  albumId?: number;
  /** Lidarr track ids the job is tied to. */
  trackIds?: number[];
  /** Radarr movieId or Sonarr seriesId */
  arrId?: number;
  /** Sonarr episodeId(s) the job is tied to. */
  episodeIds?: number[];
  seasonNumber?: number;
  /** Radarr movieFileId / Sonarr episodeFileId once known. */
  fileId?: number;
  /** Release GUID the job was created from (if grabbed via Rexarr). */
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
  /** What created the job. */
  trigger?: 'manual' | 'grab' | 'auto' | 'disc';
  /** A live preview frame is available while encoding. */
  preview?: boolean;
  outputPath?: string;
  progress: JobProgress;
  error?: string;
  /** Short status line for waiting jobs (e.g. full-disc download progress). */
  message?: string;
  log: string[];
  command?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationSeconds?: number;
  inputSizeBytes?: number;
  outputSizeBytes?: number;
  /** Estimated output size when the encode started (same model as the Transcode dialog). */
  estimatedBytes?: number;
}

/** Release family, from best to worst source for re-encoding. */
export type ReleaseCategory = 'remux' | 'disc' | 'bluray' | 'web' | 'hdtv' | 'dvd' | 'other' | 'hires' | 'cd' | 'mqa' | 'lossy';

/** A free-text search understood by Rexarr (see server/src/search/query.ts). */
export interface SearchQuery {
  raw: string;
  /** What is left once ids, years, episodes and release words are taken out. */
  title: string;
  year?: number;
  kind?: 'movie' | 'series';
  anime?: boolean;
  season?: number;
  episode?: number;
  /** Anime-style "Show - 12". */
  absoluteEpisode?: number;
  tmdbId?: number;
  tvdbId?: number;
  imdbId?: string;
  wants: {
    resolution?: number;
    category?: ReleaseCategory;
    hdr?: boolean;
    dolbyVision?: boolean;
    atmos?: boolean;
    codec?: 'hevc' | 'avc';
    dualAudio?: boolean;
  };
}

export interface SmartSearchResult {
  query: SearchQuery;
  /** Titles already in Radarr / Sonarr, best match first. */
  library: LookupResult[];
  /** Titles on disk that no *arr app manages. */
  local: LookupResult[];
  /** New titles from TMDB / TVDB (via Radarr / Sonarr lookup); empty unless online=1. */
  online: LookupResult[];
  /** Sources that failed (e.g. Sonarr unreachable) – the rest still returned. */
  errors: string[];
}

export interface Release {
  /** Release family (remux, full disc, Blu-ray encode, WEB…). */
  category?: ReleaseCategory;
  /** Notable properties parsed from the title: HDR10, DV, Atmos, TrueHD, HEVC, 10-bit, Dual audio… */
  tags?: string[];
  /** Smart ranking score (higher is better) and what went into it. */
  score?: number;
  scoreReasons?: string[];
  /** Full-disc release (Blu-ray / UHD / DVD ISO or BDMV / VIDEO_TS folder); ripped with MakeMKV after download. */
  isDisc?: boolean;
  discFormat?: 'uhd' | 'bluray' | 'dvd';
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
  source: 'radarr' | 'sonarr' | 'prowlarr' | 'lidarr' | 'soulseek';
  /** Music releases: format details (from the title for indexers, from the files for Soulseek). */
  music?: {
    format?: string;
    bitDepth?: number;
    sampleRate?: number;
    bitrate?: number;
    trackCount?: number;
    /** Album image with a cue sheet (split into tracks after download). */
    cue?: boolean;
    /** Soulseek peer and folder. */
    username?: string;
    directory?: string;
    freeSlot?: boolean;
    queueLength?: number;
    uploadSpeed?: number;
    files?: { filename: string; size: number; bitDepth?: number; sampleRate?: number; bitRate?: number; length?: number }[];
  };
  /** Lidarr: albums matched by the release. */
  albumIds?: number[];
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
  /** AniDB: this movie is an anime (from the Anime-Lists mapping). */
  anime?: boolean;
  anidbId?: number;
  titleRomaji?: string;
  titleKanji?: string;
  /** Other titles Radarr knows (translations, AKAs) – used by search. */
  alternateTitles?: string[];
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
  /** AniDB ids mapped to this TVDB series (one per arc / season). */
  anidbIds?: number[];
  titleRomaji?: string;
  titleKanji?: string;
  /** Other titles Sonarr knows (scene names, translations) – used by search. */
  alternateTitles?: string[];
  /** Alternate titles Sonarr ties to one season, e.g. "… Zoku" for season 2. */
  seasonTitles?: { title: string; seasonNumber: number }[];
  statistics: { episodeFileCount: number; episodeCount: number; sizeOnDisk: number; remuxFileCount: number };
}

/** Estimated output size of an encode (Transcode dialog). */
/** Estimated size of a disc rip (and of the transcode that follows), before anything has been ripped. */
export interface DiscEstimate {
  ripBytes: number;
  transcode?: SizeEstimate;
  titleCount: number;
  durationSeconds: number;
}

export interface SizeEstimate {
  profileId: string;
  profileName: string;
  /** Best guess, bytes. */
  bytes: number;
  low: number;
  high: number;
  sourceBytes: number;
  parts: { video: number; audio: number; subtitles: number; other: number };
  videoKbps?: number;
  notes: string[];
  /** Copy / bitrate modes: close to exact. */
  exact: boolean;
}

export interface SizeEstimateResult {
  estimates: SizeEstimate[];
  /** Files probed; the rest were scaled from them by size. */
  probed: number;
  files: number;
  errors: string[];
}

export interface LookupResult {
  /** Found on disk outside the *arr apps (Settings → Local media). */
  local?: { id: string; folder: string; files: number; size: number; quality?: string; /** Newest file change (ms). */ modified?: number; matched?: boolean };
  /** Smart search: how well it matched (0–100+) and on which title. */
  score?: number;
  matchedOn?: string;
  anime?: boolean;
  /** Library titles: what is on disk now. */
  library?: { hasFile: boolean; remux: boolean; quality?: string; files?: number; episodes?: number; remuxFiles?: number; sizeOnDisk?: number };
  kind: 'movie' | 'series' | 'album';
  arrId?: number;
  /** Albums: the Lidarr artist id and name. */
  artistId?: number;
  artist?: string;
  /** MusicBrainz id for albums (externalId is a hash for those). */
  foreignId?: string;
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

/** Recommended external programs (System → Tools, shown on first launch). */
export type SetupPlatform = 'windows' | 'macos' | 'linux' | 'freebsd' | 'docker';
export interface SetupStep {
  label: string;
  /** Download or documentation page. */
  url?: string;
  /** Shell command to copy. */
  command?: string;
}
export interface SetupTool {
  id: 'ffmpeg' | 'freac' | 'makemkv' | 'slskd';
  name: string;
  purpose: string;
  required: boolean;
  available: boolean;
  /** Version when found, the error otherwise. */
  detail?: string;
  steps: SetupStep[];
  note?: string;
}
export interface SetupTools {
  platform: SetupPlatform;
  /** The first-launch page was closed; it is not opened automatically again. */
  dismissed: boolean;
  tools: SetupTool[];
}

export interface ArrStatus {
  name: 'radarr' | 'sonarr' | 'prowlarr' | 'lidarr' | 'slskd';
  configured: boolean;
  ok: boolean;
  version?: string;
  appName?: string;
  error?: string;
}

export interface AnidbInfo {
  enabled: boolean;
  loaded: boolean;
  loading: boolean;
  animeCount: number;
  mappingCount: number;
  updatedAt?: string;
  error?: string;
}

export interface AppEvent {
  id: number;
  time: string;
  level: 'info' | 'warning' | 'error';
  source: string;
  message: string;
  details?: string;
}

export interface ScheduledTask {
  id: string;
  name: string;
  intervalSeconds: number;
  lastRun?: string;
  lastDurationMs?: number;
  lastResult?: string;
  lastError?: string;
  running: boolean;
  nextRun?: string;
}

export interface BackupInfo {
  name: string;
  sizeBytes: number;
  createdAt: string;
  type: 'manual' | 'scheduled';
}

export interface LogFileInfo {
  name: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface StoragePath {
  id: 'cache' | 'images' | 'programData' | 'logs' | 'metadata' | 'transcodes' | 'backups' | 'rips';
  label: string;
  path: string;
  description: string;
  /** Environment variable that overrides this location. */
  env: string;
  overridden: boolean;
  exists: boolean;
  writable: boolean;
  sizeBytes: number;
  fileCount: number;
  sizeTruncated: boolean;
  /** Filesystem the folder lives on. */
  disk?: { totalBytes: number; freeBytes: number; usedBytes: number };
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
  /** How Rexarr was installed: a release package (runtime e.g. "linux-x64", "osx-arm64-app"), Docker, or undefined for source. */
  package?: { version: string; runtime: string; branch: string };
  uptimeSeconds: number;
  ffmpeg: FfmpegCapabilities;
  /** fre:ac (freaccmd): music encodes and CD ripping. */
  freac?: { available: boolean; path: string; version?: string; encoders: string[]; error?: string };
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
  /** makemkvcon source: disc:N for real drives, iso:/path or file:/path for virtual ones. */
  source: string;
  virtual?: boolean;
  /** Set for drives that come from the linked virtual drive list. */
  virtualId?: string;
  /** false when a linked image is currently missing on disk, or an added device path does not exist. */
  available?: boolean;
  /** Set for real drives added by device path (Discs → Add drive). */
  manualId?: string;
  /** false when MakeMKV did not list the drive and Rexarr probed the device itself. */
  detected?: boolean;
}

/** A real optical drive added by device path. */
export interface PhysicalDrive {
  id: string;
  /** /dev/sr0, /dev/cdrom, /dev/disk/by-id/…, or /dev/disk4 on macOS. */
  path: string;
  label?: string;
  addedAt: string;
}

export interface DriveCandidate {
  path: string;
  name: string;
  note?: string;
}

/** One audio stream of a disc title. `index` is its position among the title's audio streams, which is also the order in the ripped MKV. */
export interface DiscAudioTrack {
  index: number;
  codec: string;
  language: string;
  languageName?: string;
  channels?: number;
  bitrateKbps?: number;
  /** "Surround 5.1", "Stereo", "Director's commentary" … as the disc labels it. */
  name?: string;
  lossless: boolean;
  /** Ready-made description, e.g. "Japanese · DTS 5.1 768 kbps". */
  label: string;
}

/** Name for a bonus title that is not an episode. "none" keeps the disc's own title name. */
export type ExtraType = 'none' | 'op' | 'ed' | 'extra' | 'ova' | 'special' | 'custom';

/**
 * What a disc title is: an episode (number in `episodeMap`), a special imported as season 0 (S00Exx, when TVDB has
 * it), or an extra – kept next to the show / movie in an Extras folder, because Sonarr and Radarr only import
 * episodes and movies.
 */
export type TitleRole = { kind: 'episode' } | { kind: 'special'; episode: number } | { kind: 'extra'; type: ExtraType; name?: string };

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
  audioTracks?: DiscAudioTrack[];
  subtitles: string[];
  /** Shorter than the minimum title length: only listed because extras are included. */
  short?: boolean;
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
  /** The season's own name, when it has one (AniDB), e.g. "My Teen Romantic Comedy SNAFU Too!" for season 2. */
  seasonTitle?: string;
  kind: 'movie' | 'series' | 'album' | 'unknown';
  title: string;
  /** Audio CDs: album artist. */
  artist?: string;
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
  /** Anime: name files with absolute episode numbers (Show - 005) instead of S01E05. */
  absoluteNumbering?: boolean;
  /** Disc number parsed from the label (multi-disc sets). */
  discNumber?: number;
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
  /** Where the disc came from. */
  origin?: 'drive' | 'image' | 'download';
  /** Download-origin rips: the waiting job that grabbed the release, and the *arr queue item to clear after import. */
  jobId?: string;
  arrQueue?: { arr: 'radarr' | 'sonarr'; id: number; title: string };
  /** Start ripping as soon as the scan finishes. */
  autoStart?: boolean;
  id: string;
  driveIndex: number;
  /** makemkvcon source used for scan / rip (disc:N, iso:path, file:path). */
  source: string;
  virtual?: boolean;
  drivePath: string;
  driveName: string;
  label: string;
  volumeName: string;
  discType: 'bluray' | 'dvd' | 'cd' | 'unknown';
  /** Audio CDs: TOC, MusicBrainz matches and MQA detection. */
  cd?: CdInfo;
  status: RipStatus;
  media: RipMedia;
  titles: DiscTitle[];
  selectedTitleIds: number[];
  /** Which audio tracks to keep: the best per language, all of them, or a hand-picked set per title id. */
  audioMode?: 'best' | 'all' | 'custom';
  selectedAudio?: Record<string, number[]>;
  /** Minimum title length the disc was scanned with; the rip must use the same one (MakeMKV numbers titles after it). */
  scanMinSeconds?: number;
  /** Titles that are specials or extras rather than episodes (by title id); anything else is an episode. */
  titleRoles?: Record<string, TitleRole>;
  /** Series: explicit title -> episode number mapping (falls back to episodeStart + order). */
  episodeMap?: Record<number, number>;
  /** Title ids that look like a "play all" title (duration ≈ sum of the others). */
  playAllTitleIds?: number[];
  profileId?: string;
  profileName?: string;
  options: RipOptions;
  outputDir?: string;
  files: RippedFile[];
  progress: { percent: number; step: string; titleIndex: number; titleCount: number; startedAt?: string; etaSeconds?: number };
  /** How long the rip itself took, once it has finished. */
  ripSeconds?: number;
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
  | { type: 'queue'; paused: boolean }
  | { type: 'log'; jobId: string; line: string }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; message: string };
