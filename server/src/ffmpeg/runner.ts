import { spawn, type ChildProcess } from 'node:child_process';
import type { JobProgress } from '../../../shared/types.js';

export interface RunHandle {
  process: ChildProcess;
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  cancel: () => void;
}

export function initialProgress(): JobProgress {
  return { percent: 0, fps: 0, speed: '', bitrate: '', outTimeSeconds: 0, etaSeconds: null, frame: 0, sizeBytes: 0 };
}

/**
 * Spawn ffmpeg with `-progress pipe:1` and stream parsed progress + stderr lines back.
 */
export function runFfmpeg(
  ffmpegPath: string,
  args: string[],
  durationSeconds: number,
  onProgress: (p: JobProgress) => void,
  onLog: (line: string) => void,
): RunHandle {
  const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const progress = initialProgress();
  const startedAt = Date.now();
  let cancelled = false;

  let buf = '';
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq);
      const val = line.slice(eq + 1).trim();
      switch (key) {
        case 'frame':
          progress.frame = Number(val) || 0;
          break;
        case 'fps':
          progress.fps = Number(val) || 0;
          break;
        case 'bitrate':
          progress.bitrate = val;
          break;
        case 'total_size':
          progress.sizeBytes = Number(val) || 0;
          break;
        case 'out_time_us':
        case 'out_time_ms': {
          // ffmpeg reports both; out_time_ms is actually microseconds in every released version.
          const us = Number(val);
          if (Number.isFinite(us) && us >= 0) progress.outTimeSeconds = us / 1_000_000;
          break;
        }
        case 'speed':
          progress.speed = val;
          break;
        case 'progress': {
          if (durationSeconds > 0) {
            progress.percent = Math.min(100, (progress.outTimeSeconds / durationSeconds) * 100);
            const speed = parseFloat(progress.speed);
            if (speed > 0) progress.etaSeconds = Math.max(0, (durationSeconds - progress.outTimeSeconds) / speed);
            else {
              const elapsed = (Date.now() - startedAt) / 1000;
              progress.etaSeconds = progress.percent > 0 ? Math.max(0, (elapsed / progress.percent) * (100 - progress.percent)) : null;
            }
          }
          if (val === 'end') progress.percent = 100;
          onProgress({ ...progress });
          break;
        }
      }
    }
  });

  let errBuf = '';
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => {
    errBuf += chunk;
    let idx: number;
    while ((idx = errBuf.search(/[\r\n]/)) >= 0) {
      const line = errBuf.slice(0, idx).trim();
      errBuf = errBuf.slice(idx + 1);
      if (line) onLog(line);
    }
  });

  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('error', (err) => {
      onLog(`spawn error: ${err.message}`);
      resolve({ code: -1, signal: null });
    });
    child.on('close', (code, signal) => {
      if (errBuf.trim()) onLog(errBuf.trim());
      resolve({ code: cancelled ? null : code, signal });
    });
  });

  return {
    process: child,
    done,
    cancel: () => {
      cancelled = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 5000).unref();
    },
  };
}
