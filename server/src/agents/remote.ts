/**
 * Running something on an agent, shaped exactly like running it here.
 *
 * `runFfmpeg` hands back a `RunHandle` - a promise that settles with an exit code, plus a way to stop it. An
 * agent task can offer the same thing: the queue then does not care which machine the encode is on, and every
 * piece of it that follows (the watchdog, the stall timeout, cancelling, the log, the progress bar) works
 * unchanged. The file itself is never in question, because both machines are looking at the same shared folder.
 */
import type { JobProgress, VideoEncoder } from '../../../shared/types.js';
import type { RunHandle } from '../ffmpeg/runner.js';
import { initialProgress } from '../ffmpeg/runner.js';
import { cancelTask, createTask, dropTask, isAvailable, listAgents, agentSettings } from './registry.js';

/**
 * An agent that could take this encode now: enabled, reporting in, with room and with the encoder the profile
 * asked for. The server keeps the first `localFirst` encodes for itself, so a single-agent farm does not send
 * everything away from the machine that has the library on it.
 */
export function pickAgentFor(encoders: string[], localRunning: number): { id: string; name: string } | undefined {
  const s = agentSettings();
  if (!s.enabled || localRunning < s.localFirst) return undefined;
  const able = listAgents().filter(
    (a) =>
      isAvailable(a) &&
      a.capabilities.transcode &&
      (!encoders.length || !(a.capabilities.videoEncoders ?? []).length || encoders.every((e) => (a.capabilities.videoEncoders ?? []).includes(e as VideoEncoder))),
  );
  // the one with the least on, so two agents share rather than one taking everything
  const best = able.sort((x, y) => x.running.length - y.running.length || x.name.localeCompare(y.name))[0];
  return best && { id: best.id, name: best.name };
}

/**
 * Run makemkvcon on the agent and hand back what it printed. A disc scan is its stdout and nothing else, so
 * the agent captures it verbatim and the server does the reading - the agent still knows nothing about discs.
 */
export function readOnAgent(opts: {
  agentId: string;
  ownerId: string;
  label: string;
  args: string[];
  onLog?: (line: string) => void;
}): { done: Promise<{ code: number | null; stdout: string }>; cancel: () => void } {
  let settle: (r: { code: number | null; stdout: string }) => void;
  const done = new Promise<{ code: number | null; stdout: string }>((resolve) => {
    settle = resolve;
  });
  const task = createTask(
    { kind: 'scan', ownerId: opts.ownerId, label: opts.label, program: 'makemkvcon', args: opts.args, agentId: opts.agentId, capture: true },
    {
      onLog: (lines) => opts.onLog && lines.forEach(opts.onLog),
      onFinish: (code, error, output) => {
        if (error) opts.onLog?.(error);
        settle({ code, stdout: output ?? '' });
        setTimeout(() => dropTask(task.id), 60_000).unref();
      },
    },
  );
  return {
    done,
    cancel: () => {
      cancelTask(task.id);
      settle({ code: null, stdout: '' });
    },
  };
}

export function runOnAgent(opts: {
  agentId: string;
  agentName: string;
  kind: 'rip' | 'transcode';
  ownerId: string;
  label: string;
  program: 'ffmpeg' | 'makemkvcon';
  args: string[];
  durationSeconds?: number;
  onProgress: (p: JobProgress) => void;
  onLog: (line: string) => void;
}): RunHandle {
  let settle: (r: { code: number | null; signal: null }) => void;
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    settle = resolve as typeof settle;
  });
  const progress = initialProgress();
  const task = createTask(
    {
      kind: opts.kind,
      ownerId: opts.ownerId,
      label: opts.label,
      program: opts.program,
      args: opts.args,
      durationSeconds: opts.durationSeconds,
      agentId: opts.agentId,
    },
    {
      onLog: (lines) => lines.forEach(opts.onLog),
      onProgress: (p) => opts.onProgress({ ...progress, ...p }),
      onFinish: (code, error) => {
        if (error) opts.onLog(error);
        settle({ code, signal: null });
        // it is reported and done with; nothing needs the task after this
        setTimeout(() => dropTask(task.id), 60_000).unref();
      },
    },
  );
  const stop = () => {
    cancelTask(task.id);
    settle({ code: null, signal: null });
  };
  return { done, kill: stop, cancel: stop, agentName: opts.agentName };
}
