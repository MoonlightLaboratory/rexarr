/**
 * The agent: Rexarr on a machine that has a drive, or spare CPU, and nothing else.
 *
 *   rexarr-agent --server http://nas:3939 --key <api key> [--name shelf-pi-1]
 *
 * It enrols once, then polls. Every poll says what it is running and how far along; the answer says what to
 * start and what to drop. Nothing listens on the agent and nothing is pushed to it, so a shelf of SBCs behind a
 * router needs no ports forwarded and no certificates.
 *
 * It holds no profiles, no library and no metadata, and decides nothing. The server sends a program and its
 * arguments, already rewritten into the paths this agent sees; the agent runs it and reports back. The two
 * machines reach the same files through a shared folder, which is why none of them ever travel over this wire.
 *
 * It will only ever run the two programs it was started with. A task naming anything else is refused - the
 * server is trusted to say "encode this", not to say "run this".
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { APP_VERSION } from '../../../shared/version.js';
import type { AgentCapabilities, DiscDrive, JobProgress, VideoEncoder } from '../../../shared/types.js';
import { ffmpegCapabilities } from '../ffmpeg/capabilities.js';
import { listDrives, listVirtualDrives, makemkvInfo, resolveMakemkv } from '../disc/makemkv.js';
import { runFfmpeg, type RunHandle } from '../ffmpeg/runner.js';

const run = promisify(execFile);

interface Options {
  server: string;
  key: string;
  name: string;
  configDir: string;
  ffmpeg: string;
  makemkv: string;
  concurrency: number;
  /** Disc images and DVD/Blu-ray folders to offer as drives, the way the server's own virtual drives work. */
  virtualDrives: string;
}

function usage(message?: string): never {
  if (message) console.error(`rexarr-agent: ${message}\n`);
  console.error(`Rexarr agent ${APP_VERSION}

  rexarr-agent --server <url> --key <api key> [options]

  --server <url>     the Rexarr server to report to, e.g. http://nas:3939
  --key <key>        its API key (Settings -> General -> Security)
  --name <name>      what to call this machine on the Agents page (default: its hostname)
  --config <dir>     where to keep this agent's id (default: ~/.rexarr-agent)
  --ffmpeg <path>    ffmpeg binary (default: ffmpeg on PATH)
  --makemkv <path>   makemkvcon binary (default: found where it usually lives)
  --virtual-drives <dir>  offer every disc image and DVD/Blu-ray folder in <dir> as a drive

Every setting can also come from the environment: REXARR_SERVER, REXARR_API_KEY,
REXARR_AGENT_NAME, REXARR_AGENT_CONFIG, REXARR_FFMPEG, REXARR_MAKEMKV,
REXARR_VIRTUAL_DRIVES.

The agent and the server must see the same files. Mount the share on both, and if
they mount it at different paths, set that agent's path mappings on the Agents page.`);
  process.exit(message ? 2 : 0);
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): Options {
  const flag = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (argv.includes('--help') || argv.includes('-h')) usage();
  const server = (flag('server') ?? env.REXARR_SERVER ?? '').replace(/\/+$/, '');
  const key = flag('key') ?? env.REXARR_API_KEY ?? '';
  if (!server) usage('--server is required (or REXARR_SERVER)');
  if (!/^https?:\/\//i.test(server)) usage(`--server must be a URL, e.g. http://nas:3939 (got "${server}")`);
  if (!key) usage('--key is required (or REXARR_API_KEY) – it is the server\'s API key, under Settings → General → Security');
  return {
    server,
    key,
    name: flag('name') ?? env.REXARR_AGENT_NAME ?? os.hostname(),
    configDir: flag('config') ?? env.REXARR_AGENT_CONFIG ?? path.join(os.homedir(), '.rexarr-agent'),
    ffmpeg: flag('ffmpeg') ?? env.REXARR_FFMPEG ?? 'ffmpeg',
    makemkv: flag('makemkv') ?? env.REXARR_MAKEMKV ?? '',
    concurrency: Number(flag('concurrency') ?? env.REXARR_AGENT_CONCURRENCY ?? 1) || 1,
    virtualDrives: flag('virtual-drives') ?? env.REXARR_VIRTUAL_DRIVES ?? '',
  };
}

/** The id is this agent's identity, so a restart rejoins as itself rather than appearing twice. */
function agentId(configDir: string): string {
  const file = path.join(configDir, 'agent-id');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch {
    /* first run */
  }
  const id = randomUUID();
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(file, `${id}\n`);
  return id;
}

async function capabilities(o: Options): Promise<AgentCapabilities> {
  const ff = await ffmpegCapabilities(o.ffmpeg, true).catch(() => undefined);
  const mk = await makemkvInfo(o.makemkv, true).catch(() => undefined);
  return {
    rip: Boolean(mk?.available),
    transcode: Boolean(ff?.available),
    makemkvVersion: mk?.version,
    ffmpegVersion: ff?.version,
    videoEncoders: ff?.videoEncoders as VideoEncoder[] | undefined,
    hardware: ff?.hwaccels?.join(', ') || undefined,
    platform: process.platform,
    arch: process.arch,
    cpus: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
  };
}

async function drives(o: Options): Promise<DiscDrive[]> {
  const real = await listDrives(resolveMakemkv(o.makemkv)).catch(() => []);
  // a folder of images stands in for drives, exactly as it does on the server, which is how a farm is tested
  const virtual = o.virtualDrives ? listVirtualDrives(o.virtualDrives) : [];
  return [...real, ...virtual];
}

/** makemkvcon reports progress on its own lines; this is enough of it to drive a percentage. */
function makemkvProgress(line: string, p: JobProgress): boolean {
  const m = line.match(/^PRGV:(\d+),(\d+),(\d+)/);
  if (!m) return false;
  const total = Number(m[3]) || 1;
  p.percent = Math.min(100, Math.round((Number(m[2]) / total) * 100));
  return true;
}

interface Running {
  id: string;
  handle: RunHandle;
  progress: JobProgress;
  log: string[];
  /** Raw stdout, kept only for a task that asked for it (a disc scan is read from it). */
  capture?: string;
  finished?: { exitCode: number | null; error?: string };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const o = parseArgs(argv);
  const id = agentId(o.configDir);
  const caps = await capabilities(o);
  const running = new Map<string, Running>();

  const post = async (url: string, body: unknown): Promise<Record<string, unknown>> => {
    const res = await fetch(`${o.server}${url}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': o.key },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}${text ? ` – ${text.slice(0, 300)}` : ''}`);
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  };

  console.log(`Rexarr agent ${APP_VERSION} on ${o.name} (${process.platform}/${process.arch})`);
  console.log(`  ripping:    ${caps.rip ? `yes – MakeMKV ${caps.makemkvVersion ?? ''}` : 'no – MakeMKV not found'}`);
  console.log(`  encoding:   ${caps.transcode ? `yes – ${caps.ffmpegVersion ?? 'ffmpeg'}` : 'no – ffmpeg not found'}`);
  console.log(`  reporting to ${o.server}`);
  if (!caps.rip && !caps.transcode) {
    console.error('Neither MakeMKV nor ffmpeg was found, so there is nothing this agent could do. Install one, or pass --ffmpeg / --makemkv.');
    process.exit(1);
  }

  const enrolBody = { id, name: o.name, version: APP_VERSION, capabilities: caps, drives: await drives(o) };
  for (;;) {
    try {
      const r = await post('/api/agents/enrol', enrolBody);
      if (!r.approved) console.log('Waiting to be approved on the server (Settings → Connections → Rip farm).');
      break;
    } catch (err) {
      console.error(`Could not reach ${o.server}: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }

  let lastDrives = 0;
  let wasApproved = false;
  for (;;) {
    // what has happened since the last poll, then clear it: the server has it once it answers
    const report = [...running.values()].map((t) => ({
      id: t.id,
      status: t.finished ? (t.finished.exitCode === 0 ? ('done' as const) : ('failed' as const)) : ('running' as const),
      progress: t.progress,
      log: t.log.splice(0, 100),
      exitCode: t.finished?.exitCode,
      error: t.finished?.error,
      // only once, with the final report: there is no point sending a half-read disc
      output: t.finished ? t.capture : undefined,
    }));
    const body: Record<string, unknown> = { running: [...running.keys()], tasks: report };
    // drives change when someone puts a disc in, so they go every time; capabilities rarely, so every minute
    if (Date.now() - lastDrives > 15_000 && caps.rip) {
      body.drives = await drives(o);
      lastDrives = Date.now();
    }

    let answer: Record<string, unknown>;
    try {
      answer = await post(`/api/agents/${id}/poll`, body);
    } catch (err) {
      console.error(`Poll failed: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 10_000));
      continue;
    }
    for (const t of report) if (t.status !== 'running') running.delete(t.id);

    if (answer.approved && !wasApproved) console.log('Approved – taking work.');
    wasApproved = Boolean(answer.approved);

    for (const taskId of (answer.cancel as string[]) ?? []) {
      const t = running.get(taskId);
      if (t) {
        console.log(`Cancelling ${taskId}`);
        t.handle.cancel();
      }
    }

    for (const task of (answer.start as { id: string; kind: string; label: string; program: string; args: string[]; durationSeconds?: number; capture?: boolean }[]) ?? []) {
      if (running.has(task.id)) continue;
      const program = task.program === 'ffmpeg' ? o.ffmpeg : task.program === 'makemkvcon' ? resolveMakemkv(o.makemkv) : '';
      if (!program) {
        // the server is trusted to say what to encode, not to name a program
        const refused = `refused: this agent runs ffmpeg and makemkvcon, not "${task.program}"`;
        console.error(refused);
        running.set(task.id, { id: task.id, handle: { done: Promise.resolve({ code: 1, signal: null }), kill: () => {}, cancel: () => {} }, progress: { percent: 0 } as JobProgress, log: [refused], finished: { exitCode: 1, error: refused } });
        continue;
      }
      console.log(`Starting ${task.kind}: ${task.label}`);
      const entry: Running = { id: task.id, handle: null as never, progress: { percent: 0 } as JobProgress, log: [] };
      const push = (line: string) => {
        if (entry.log.length < 500) entry.log.push(line);
      };
      if (task.program === 'ffmpeg') {
        entry.handle = runFfmpeg(
          program,
          task.args,
          task.durationSeconds ?? 0,
          (p) => {
            entry.progress = p;
          },
          push,
        );
      } else {
        if (task.capture) entry.capture = '';
        entry.handle = runMakemkv(program, task.args, entry, push);
      }
      running.set(task.id, entry);
      void entry.handle.done.then(({ code }) => {
        entry.finished = { exitCode: code };
        console.log(`Finished ${task.label}: exit ${code}`);
      });
    }

    await new Promise((r) => setTimeout(r, Number(answer.pollSeconds ?? 5) * 1000));
  }
}

function runMakemkv(program: string, args: string[], entry: Running, push: (l: string) => void): RunHandle {
  const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  const line = (l: string) => {
    if (!makemkvProgress(l, entry.progress)) push(l);
  };
  // a scan's answer is the whole of stdout, which only the server knows how to read
  if (entry.capture !== undefined) child.stdout!.on('data', (c: string) => {
    if (entry.capture!.length < 4_000_000) entry.capture += c;
  });
  const read = (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.search(/[\r\n]/)) >= 0) {
      const l = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (l) line(l);
    }
  };
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', read);
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', read);
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('error', (err) => {
      push(`could not start ${program}: ${err.message}`);
      resolve({ code: -1, signal: null });
    });
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  const stop = () => child.kill('SIGTERM');
  return { process: child, done, kill: () => child.kill('SIGKILL'), cancel: stop };
}

// run when this file is what was started, however it was reached (rexarr-agent, npm run agent, node main.js)
const started = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (started === import.meta.url || process.argv.includes('--agent')) {
  void main(process.argv.slice(2).filter((a) => a !== '--agent'));
}
