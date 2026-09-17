/**
 * System services behind the *arr style System pages: application events, scheduled tasks,
 * config backups and rotating log files.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Writable } from 'node:stream';
import { DATA_DIR, PATHS, APP_VERSION, CONFIG_DIR } from './config.js';
import { store } from './store.js';
import type { AppEvent, ScheduledTask, BackupInfo, LogFileInfo } from '../../shared/types.js';

// ---------------------------------------------------------------------------------------------
// Events: a persisted ring buffer of notable things that happened (job done, rip failed, settings saved…)
// ---------------------------------------------------------------------------------------------
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');
const EVENTS_MAX = 500;
let events: AppEvent[] = [];
try {
  if (fs.existsSync(EVENTS_FILE)) events = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8')) as AppEvent[];
} catch {
  events = [];
}
let eventsTimer: NodeJS.Timeout | null = null;
function persistEvents() {
  if (eventsTimer) return;
  eventsTimer = setTimeout(() => {
    eventsTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(EVENTS_FILE, JSON.stringify(events));
    } catch {
      /* ignore */
    }
  }, 500);
}
let eventSeq = events.length ? Math.max(...events.map((e) => e.id)) : 0;

export const appEvents = {
  add(level: AppEvent['level'], source: string, message: string, details?: string): AppEvent {
    const ev: AppEvent = { id: ++eventSeq, time: new Date().toISOString(), level, source, message, details };
    events.unshift(ev);
    if (events.length > EVENTS_MAX) events.length = EVENTS_MAX;
    persistEvents();
    return ev;
  },
  list(limit = 200, level?: AppEvent['level']) {
    const l = level ? events.filter((e) => e.level === level) : events;
    return l.slice(0, limit);
  },
  clear() {
    events = [];
    persistEvents();
  },
};

// ---------------------------------------------------------------------------------------------
// Tasks: named recurring jobs with bookkeeping, like Sonarr's System → Tasks
// ---------------------------------------------------------------------------------------------
interface TaskDef {
  id: string;
  name: string;
  /** Interval in seconds; 0 = runs on demand only. */
  interval: () => number;
  run: () => Promise<string | void>;
}
interface TaskState {
  lastRun?: string;
  lastDurationMs?: number;
  lastResult?: string;
  lastError?: string;
  running: boolean;
  nextRun?: string;
}
const taskDefs = new Map<string, TaskDef>();
const taskState = new Map<string, TaskState>();

export const tasks = {
  register(def: TaskDef) {
    taskDefs.set(def.id, def);
    if (!taskState.has(def.id)) taskState.set(def.id, { running: false });
  },
  /** Record a run that happened elsewhere (e.g. the queue's own timer) so the page shows it. */
  markRun(id: string, durationMs: number, result?: string, error?: string) {
    const st = taskState.get(id);
    if (!st) return;
    st.lastRun = new Date().toISOString();
    st.lastDurationMs = durationMs;
    st.lastResult = result;
    st.lastError = error;
    const iv = taskDefs.get(id)?.interval() ?? 0;
    st.nextRun = iv > 0 ? new Date(Date.now() + iv * 1000).toISOString() : undefined;
  },
  async run(id: string): Promise<ScheduledTask> {
    const def = taskDefs.get(id);
    const st = taskState.get(id);
    if (!def || !st) throw new Error(`Unknown task ${id}`);
    if (st.running) return this.describe(id)!;
    st.running = true;
    const t0 = Date.now();
    try {
      const result = await def.run();
      this.markRun(id, Date.now() - t0, result ?? undefined, undefined);
    } catch (err) {
      this.markRun(id, Date.now() - t0, undefined, (err as Error).message);
      appEvents.add('error', 'Tasks', `${def.name} failed: ${(err as Error).message}`);
    } finally {
      st.running = false;
    }
    return this.describe(id)!;
  },
  describe(id: string): ScheduledTask | undefined {
    const def = taskDefs.get(id);
    const st = taskState.get(id);
    if (!def || !st) return undefined;
    const iv = def.interval();
    return { id, name: def.name, intervalSeconds: iv, lastRun: st.lastRun, lastDurationMs: st.lastDurationMs, lastResult: st.lastResult, lastError: st.lastError, running: st.running, nextRun: st.nextRun ?? (iv > 0 ? new Date(Date.now() + iv * 1000).toISOString() : undefined) };
  },
  list(): ScheduledTask[] {
    return [...taskDefs.keys()].map((id) => this.describe(id)!);
  },
  /** Kick off the timers for tasks with an interval. Intervals are re-read on every tick. */
  start() {
    const tick = async () => {
      for (const def of taskDefs.values()) {
        const st = taskState.get(def.id)!;
        const iv = def.interval();
        if (iv <= 0 || st.running) continue;
        const due = !st.lastRun || Date.now() - new Date(st.lastRun).getTime() >= iv * 1000;
        if (due) await this.run(def.id);
      }
    };
    setInterval(() => void tick(), 15_000).unref();
  },
};

// ---------------------------------------------------------------------------------------------
// Backups: gzip'd JSON bundle of every config file in the data directory
// ---------------------------------------------------------------------------------------------
/** Settings → General → Backups → Folder; relative paths are under the config directory, empty = default. */
export function backupDir(): string {
  const folder = store.settings.general?.backups.folder?.trim();
  if (!folder || process.env.REXARR_BACKUP_DIR) return PATHS.backups;
  return path.isAbsolute(folder) ? folder : path.join(CONFIG_DIR, folder);
}
const BACKUP_FILES = ['settings.json', 'profiles.json', 'jobs.json', 'rips.json', 'events.json', 'auto.json'];

export const backups = {
  list(): BackupInfo[] {
    const BACKUP_DIR = backupDir();
    if (!fs.existsSync(BACKUP_DIR)) return [];
    return fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => f.endsWith('.json.gz'))
      .map((f) => {
        const st = fs.statSync(path.join(BACKUP_DIR, f));
        return { name: f, sizeBytes: st.size, createdAt: st.mtime.toISOString(), type: f.startsWith('rexarr_scheduled') ? 'scheduled' : 'manual' } as BackupInfo;
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
  create(type: 'manual' | 'scheduled' = 'manual'): BackupInfo {
    const BACKUP_DIR = backupDir();
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const bundle: Record<string, unknown> = { version: APP_VERSION, createdAt: new Date().toISOString(), files: {} };
    for (const f of BACKUP_FILES) {
      const p = path.join(DATA_DIR, f);
      if (fs.existsSync(p)) {
        try {
          (bundle.files as Record<string, unknown>)[f] = JSON.parse(fs.readFileSync(p, 'utf8'));
        } catch {
          /* skip unreadable */
        }
      }
    }
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '_');
    const name = `rexarr_${type}_${APP_VERSION}_${stamp}.json.gz`;
    fs.writeFileSync(path.join(BACKUP_DIR, name), zlib.gzipSync(JSON.stringify(bundle)));
    // scheduled backups older than the retention period go (always keeping the newest 3); manual ones: newest 20
    const same = this.list().filter((b) => b.type === type);
    const retentionMs = (store.settings.general?.backups.retentionDays ?? 28) * 86400_000;
    for (const [i, old] of same.entries()) {
      if (type === 'scheduled' ? i >= 3 && Date.now() - new Date(old.createdAt).getTime() > retentionMs : i >= 20) this.remove(old.name);
    }
    appEvents.add('info', 'Backup', `${type === 'manual' ? 'Backup' : 'Scheduled backup'} created: ${name}`);
    return this.list().find((b) => b.name === name)!;
  },
  path(name: string) {
    if (!/^rexarr_[\w.-]+\.json\.gz$/.test(name)) throw new Error('invalid backup name');
    const p = path.join(backupDir(), name);
    if (!fs.existsSync(p)) throw new Error('backup not found');
    return p;
  },
  remove(name: string) {
    fs.unlinkSync(this.path(name));
  },
  /** Restore config files from a backup (buffer or stored name). Returns the files written. */
  restore(source: string | Buffer): string[] {
    const raw = typeof source === 'string' ? fs.readFileSync(this.path(source)) : source;
    const json = raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
    const bundle = JSON.parse(json) as { files?: Record<string, unknown> };
    if (!bundle.files || typeof bundle.files !== 'object') throw new Error('not a Rexarr backup');
    const written: string[] = [];
    for (const [f, content] of Object.entries(bundle.files)) {
      if (!BACKUP_FILES.includes(f)) continue;
      fs.writeFileSync(path.join(DATA_DIR, f), JSON.stringify(content, null, 2));
      written.push(f);
    }
    appEvents.add('warning', 'Backup', `Restored ${written.join(', ')} from backup – restart Rexarr to apply`);
    return written;
  },
};

// ---------------------------------------------------------------------------------------------
// Log files: pretty text log with size-based rotation (rexarr.txt, rexarr.0.txt … rexarr.4.txt)
// ---------------------------------------------------------------------------------------------
const LOG_DIR = PATHS.logs;
/** Settings → General → Logging → Log Size Limit. */
const logMaxBytes = () => Math.max(1, store.settings.general?.logging.sizeLimitMb ?? 2) * 1024 * 1024;
const LOG_KEEP = 5;
const LEVELS: Record<number, string> = { 10: 'Trace', 20: 'Debug', 30: 'Info', 40: 'Warn', 50: 'Error', 60: 'Fatal' };

function rotate() {
  const main = path.join(LOG_DIR, 'rexarr.txt');
  try {
    if (!fs.existsSync(main) || fs.statSync(main).size < logMaxBytes()) return;
    for (let i = LOG_KEEP - 1; i >= 0; i--) {
      const from = i === 0 ? main : path.join(LOG_DIR, `rexarr.${i - 1}.txt`);
      const to = path.join(LOG_DIR, `rexarr.${i}.txt`);
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
  } catch {
    /* ignore */
  }
}

/** A writable that receives pino JSON lines, echoes them to stdout and appends readable text to the log file. */
export function createLogStream(): Writable {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  let written = 0;
  return new Writable({
    write(chunk, _enc, cb) {
      const text = chunk.toString();
      process.stdout.write(text);
      const lines: string[] = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const j = JSON.parse(line) as { time?: number; level?: number; msg?: string; req?: { method: string; url: string }; res?: { statusCode: number }; responseTime?: number; err?: { message?: string } };
          // per-request lines only at Debug / Trace (Settings → General → Logging → Log Level)
          const verbose = store.settings.general?.logging.level !== 'info';
          if ((j.req || j.res) && (j.level ?? 30) < 40 && !verbose) continue;
          if (j.req && !j.res) {
            if (verbose) lines.push(`${new Date(j.time ?? Date.now()).toISOString().replace('T', ' ').slice(0, 19)}|Debug|${j.req.method} ${j.req.url}`);
            continue;
          }
          if (j.res && !j.msg?.includes('request completed')) continue;
          if (j.res) {
            if (verbose) lines.push(`${new Date(j.time ?? Date.now()).toISOString().replace('T', ' ').slice(0, 19)}|Debug|→ ${j.res.statusCode} in ${Math.round(j.responseTime ?? 0)} ms`);
            continue;
          }
          const t = new Date(j.time ?? Date.now()).toISOString().replace('T', ' ').slice(0, 19);
          const lvl = (LEVELS[j.level ?? 30] ?? 'Info').padEnd(5);
          const msg = j.err?.message ? `${j.msg ?? ''} ${j.err.message}`.trim() : (j.msg ?? '');
          lines.push(`${t}|${lvl}|${msg}`);
        } catch {
          lines.push(line);
        }
      }
      if (lines.length) {
        try {
          if (written === 0 || written > 64 * 1024) {
            rotate();
            written = 0;
          }
          const out = lines.join('\n') + '\n';
          fs.appendFileSync(path.join(LOG_DIR, 'rexarr.txt'), out);
          written += out.length;
        } catch {
          /* ignore */
        }
      }
      cb();
    },
  });
}

export const logs = {
  list(): LogFileInfo[] {
    if (!fs.existsSync(LOG_DIR)) return [];
    return fs
      .readdirSync(LOG_DIR)
      .filter((f) => /^rexarr(\.\d+)?\.txt$/.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(LOG_DIR, f));
        return { name: f, sizeBytes: st.size, modifiedAt: st.mtime.toISOString() };
      })
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  },
  read(name: string, maxBytes = 512 * 1024): string {
    if (!/^rexarr(\.\d+)?\.txt$/.test(name)) throw new Error('invalid log name');
    const p = path.join(LOG_DIR, name);
    if (!fs.existsSync(p)) throw new Error('log not found');
    const size = fs.statSync(p).size;
    const fd = fs.openSync(p, 'r');
    try {
      const len = Math.min(size, maxBytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const text = buf.toString('utf8');
      return size > maxBytes ? text.slice(text.indexOf('\n') + 1) : text;
    } finally {
      fs.closeSync(fd);
    }
  },
  clear() {
    if (!fs.existsSync(LOG_DIR)) return;
    for (const f of this.list()) fs.unlinkSync(path.join(LOG_DIR, f.name));
  },
};
