/**
 * Soulseek through slskd (https://github.com/slskd/slskd), REST API v0 with an API key.
 *
 * A search returns files from many peers; Rexarr groups them into album folders (one peer + one directory), keeps
 * audio files only, and describes each folder like a release (format, bit depth, sample rate, size, free upload
 * slot, queue length, speed) so it can be ranked and grabbed alongside Lidarr's indexer results.
 */
import { randomUUID } from 'node:crypto';
import type { Release, SlskdConnection } from '../../../shared/types.js';
import { httpFetch } from '../net.js';
import { formatLabel, musicFormatFromText } from '../music/format.js';

export interface SlskdFile {
  filename: string;
  size: number;
  bitRate?: number;
  bitDepth?: number;
  sampleRate?: number;
  length?: number;
  extension?: string;
  isLocked?: boolean;
}

export interface SlskdResponse {
  username: string;
  files: SlskdFile[];
  hasFreeUploadSlot: boolean;
  queueLength: number;
  uploadSpeed: number;
  lockedFiles?: SlskdFile[];
}

export interface SlskdTransfer {
  id: string;
  username: string;
  filename: string;
  size: number;
  state: string;
  percentComplete?: number;
  bytesTransferred?: number;
}

const AUDIO_EXT = /\.(flac|mp3|m4a|alac|aac|ogg|opus|wav|aiff?|ape|wv|dsf|dff)$/i;
const LOSSLESS_EXT = /\.(flac|alac|wav|aiff?|ape|wv|dsf|dff)$/i;

/** "@@abcd\Music\Artist\Album (2020)\01 - Track.flac" → directory and file name (Soulseek paths use backslashes). */
export function splitSoulseekPath(filename: string) {
  const parts = filename.split(/[\\/]/);
  const name = parts.pop() ?? filename;
  return { directory: parts.join('\\'), name, folder: parts[parts.length - 1] ?? '' };
}

/** Group search responses into album folders and describe each one as a Release. */
export function groupResponses(responses: SlskdResponse[], opts: { maxQueueLength?: number; minFiles?: number } = {}): Release[] {
  const out: Release[] = [];
  for (const r of responses) {
    if (opts.maxQueueLength !== undefined && r.queueLength > opts.maxQueueLength) continue;
    const byDir = new Map<string, SlskdFile[]>();
    // cue sheets travel with the album: a folder of one or two long lossless files + cue is an image to split later
    const cues = new Map<string, SlskdFile[]>();
    for (const f of r.files ?? []) {
      if (f.isLocked) continue;
      const { directory } = splitSoulseekPath(f.filename);
      if (/\.cue$/i.test(f.filename)) {
        cues.set(directory, [...(cues.get(directory) ?? []), f]);
        continue;
      }
      if (!AUDIO_EXT.test(f.filename)) continue;
      byDir.set(directory, [...(byDir.get(directory) ?? []), f]);
    }
    for (const [directory, files] of byDir) {
      if (files.length < (opts.minFiles ?? 1)) continue;
      files.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }));
      const exts = new Map<string, number>();
      for (const f of files) {
        const e = (f.extension || f.filename.split('.').pop() || '').toLowerCase();
        exts.set(e, (exts.get(e) ?? 0) + 1);
      }
      const mainExt = [...exts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const main = files.filter((f) => f.filename.toLowerCase().endsWith(`.${mainExt}`));
      const bitDepth = Math.max(0, ...main.map((f) => f.bitDepth ?? 0)) || undefined;
      const sampleRate = Math.max(0, ...main.map((f) => f.sampleRate ?? 0)) || undefined;
      const bitrate = Math.round(main.reduce((n, f) => n + (f.bitRate ?? 0), 0) / Math.max(1, main.length)) || undefined;
      const { folder } = splitSoulseekPath(`${directory}\\x`);
      const fromName = musicFormatFromText(directory);
      const lossless = LOSSLESS_EXT.test(`.${mainExt}`);
      const format = mainExt === 'm4a' ? 'M4A' : mainExt.toUpperCase();
      const cueFiles = cues.get(directory) ?? [];
      const isImage = lossless && cueFiles.length > 0 && main.length <= cueFiles.length;
      const size = files.reduce((n, f) => n + f.size, 0) + cueFiles.reduce((n, f) => n + f.size, 0);
      out.push({
        guid: `${r.username}|${directory}`,
        indexerId: 0,
        indexer: r.username,
        title: folder || directory,
        size,
        quality: formatLabel({ format, bitDepth: lossless ? bitDepth ?? fromName.bitDepth : undefined, sampleRate: lossless ? sampleRate ?? fromName.sampleRate : undefined, bitrate: lossless ? undefined : bitrate }),
        resolution: 0,
        isRemux: false,
        seeders: null,
        leechers: null,
        protocol: 'soulseek',
        ageDays: 0,
        languages: [],
        approved: true,
        rejections: [],
        source: 'soulseek',
        music: {
          format,
          bitDepth: lossless ? bitDepth ?? fromName.bitDepth : undefined,
          sampleRate: sampleRate ?? fromName.sampleRate,
          bitrate: lossless ? undefined : bitrate,
          trackCount: isImage ? undefined : main.length,
          cue: isImage || undefined,
          username: r.username,
          directory,
          freeSlot: r.hasFreeUploadSlot,
          queueLength: r.queueLength,
          uploadSpeed: r.uploadSpeed,
          files: [...files, ...cueFiles].map((f) => ({ filename: f.filename, size: f.size, bitDepth: f.bitDepth, sampleRate: f.sampleRate, bitRate: f.bitRate, length: f.length })),
        },
      });
    }
  }
  return out;
}

export class Slskd {
  constructor(readonly conn: SlskdConnection) {}

  get configured() {
    return Boolean(this.conn.enabled && this.conn.url && this.conn.apiKey);
  }

  private async req<T>(method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
    if (!this.conn.url || !this.conn.apiKey) throw new Error('Soulseek (slskd) is not configured');
    let res: Response;
    try {
      res = await httpFetch(`${this.conn.url.replace(/\/+$/, '')}/api/v0${path}`, {
        method,
        headers: { 'X-API-Key': this.conn.apiKey, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new Error(`slskd: request failed (${(err as Error).message})`);
    }
    if (res.status === 401 || res.status === 403) throw new Error('slskd: invalid API key');
    if (!res.ok) throw new Error(`slskd: HTTP ${res.status}${await res.text().then((t) => (t ? ` – ${t.slice(0, 200)}` : ''), () => '')}`);
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async status(): Promise<{ version: string; appName: string; loggedIn?: boolean }> {
    const app = await this.req<{ version?: string; server?: { isLoggedIn?: boolean; state?: string } }>('GET', '/application', undefined, 10_000);
    return { version: app.version ?? '?', appName: 'slskd', loggedIn: app.server?.isLoggedIn };
  }

  /** slskd's own download directory. */
  async downloadsDirectory(): Promise<string | undefined> {
    const o = await this.req<{ directories?: { downloads?: string } }>('GET', '/options').catch(() => undefined);
    return o?.directories?.downloads;
  }

  /** Run a search and wait for it to finish (or the time limit), then return grouped album folders. */
  async search(text: string, opts: { timeoutSeconds?: number; maxQueueLength?: number } = {}): Promise<Release[]> {
    const id = randomUUID();
    const timeout = Math.min(60, Math.max(5, opts.timeoutSeconds ?? this.conn.searchTimeoutSeconds ?? 15));
    await this.req('POST', '/searches', { id, searchText: text, searchTimeout: timeout * 1000, responseLimit: 250, fileLimit: 20000, filterResponses: true, minimumResponseFileCount: 1 });
    const deadline = Date.now() + (timeout + 5) * 1000;
    for (;;) {
      const s = await this.req<{ isComplete?: boolean; state?: string }>('GET', `/searches/${id}`);
      if (s.isComplete || /Completed/i.test(s.state ?? '') || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const responses = await this.req<SlskdResponse[]>('GET', `/searches/${id}/responses`, undefined, 60_000);
    void this.req('DELETE', `/searches/${id}`).catch(() => undefined);
    return groupResponses(responses, { maxQueueLength: opts.maxQueueLength ?? this.conn.maxQueueLength });
  }

  /** Queue files from one peer. */
  download(username: string, files: { filename: string; size: number }[]) {
    return this.req('POST', `/transfers/downloads/${encodeURIComponent(username)}`, files.map((f) => ({ filename: f.filename, size: f.size })));
  }

  /** Current transfers for a peer, flattened. */
  async transfers(username: string): Promise<SlskdTransfer[]> {
    const r = await this.req<{ username: string; directories?: { directory: string; files: SlskdTransfer[] }[] }>('GET', `/transfers/downloads/${encodeURIComponent(username)}`).catch((e: Error) => {
      if (/HTTP 404/.test(e.message)) return { username, directories: [] };
      throw e;
    });
    return (r.directories ?? []).flatMap((d) => d.files.map((f) => ({ ...f, username })));
  }
}
