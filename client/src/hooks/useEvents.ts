import { withBase } from '../base';
import { useEffect, useRef, useState } from 'react';
import type { DiscDrive, DiscRip, Job, ServerEvent } from '@shared/types';
import { api } from '../api';

export interface Toast {
  id: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  /** How many times this message arrived while visible. */
  count: number;
}

const MAX_TOASTS = 4;
/** Errors stay longer; hovering a toast pauses its timer. */
const TOAST_MS: Record<Toast['level'], number> = { info: 5000, warn: 9000, error: 15000 };

/** Keeps a live list of jobs via SSE (falls back to polling if the stream drops). */
export function useJobs() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [rips, setRips] = useState<DiscRip[]>([]);
  const [drives, setDrives] = useState<DiscDrive[]>([]);
  const [connected, setConnected] = useState(false);
  const [queuePaused, setQueuePaused] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismissToast = (id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((t) => t.filter((x) => x.id !== id));
  };
  const schedule = (id: number, level: Toast['level']) => {
    clearTimeout(timers.current.get(id));
    timers.current.set(id, setTimeout(() => dismissToast(id), TOAST_MS[level]));
  };
  const pauseToast = (id: number) => clearTimeout(timers.current.get(id));
  const resumeToast = (id: number) => {
    const t = toastsRef.current.find((x) => x.id === id);
    if (t) schedule(id, t.level);
  };
  const toastsRef = useRef<Toast[]>([]);
  toastsRef.current = toasts;

  const pushToast = (level: Toast['level'], message: string) => {
    const existing = toastsRef.current.find((t) => t.level === level && t.message === message);
    if (existing) {
      // same message again: bump the counter and restart its timer instead of stacking duplicates
      setToasts((list) => list.map((t) => (t.id === existing.id ? { ...t, count: t.count + 1 } : t)));
      schedule(existing.id, level);
      return;
    }
    const id = ++toastId.current;
    setToasts((list) => {
      const next = [...list, { id, level, message, count: 1 }];
      // keep the newest few; errors are dropped last
      while (next.length > MAX_TOASTS) {
        const drop = next.findIndex((t) => t.level !== 'error');
        const [gone] = next.splice(drop >= 0 ? drop : 0, 1);
        clearTimeout(timers.current.get(gone.id));
        timers.current.delete(gone.id);
      }
      return next;
    });
    schedule(id, level);
  };

  useEffect(() => {
    let es: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      es = new EventSource(withBase('/api/events'));
      es.onopen = () => {
        setConnected(true);
        if (poll) {
          clearInterval(poll);
          poll = null;
        }
      };
      es.onerror = () => {
        setConnected(false);
        es?.close();
        if (!poll) poll = setInterval(() => api.jobs().then(setJobs).catch(() => {}), 5000);
        setTimeout(connect, 3000);
      };
      const handle = (e: MessageEvent) => {
        const ev = JSON.parse(e.data) as ServerEvent;
        switch (ev.type) {
          case 'jobs':
            setJobs(ev.jobs);
            break;
          case 'job':
            setJobs((list) => {
              const idx = list.findIndex((j) => j.id === ev.job.id);
              if (idx < 0) return [ev.job, ...list];
              const next = [...list];
              next[idx] = ev.job;
              return next;
            });
            break;
          case 'job-removed':
            setJobs((list) => list.filter((j) => j.id !== ev.id));
            break;
          case 'notice':
            pushToast(ev.level, ev.message);
            break;
          case 'rips':
            setRips(ev.rips);
            break;
          case 'rip':
            setRips((list) => {
              const idx = list.findIndex((r) => r.id === ev.rip.id);
              if (idx < 0) return [ev.rip, ...list];
              const next = [...list];
              next[idx] = ev.rip;
              return next;
            });
            break;
          case 'rip-removed':
            setRips((list) => list.filter((r) => r.id !== ev.id));
            break;
          case 'drives':
            setDrives(ev.drives);
            break;
          case 'queue':
            setQueuePaused(ev.paused);
            break;
        }
      };
      for (const t of ['jobs', 'job', 'job-removed', 'notice', 'rips', 'rip', 'rip-removed', 'drives', 'queue']) es.addEventListener(t, handle as EventListener);
    };
    connect();
    return () => {
      stopped = true;
      es?.close();
      if (poll) clearInterval(poll);
    };
  }, []);

  const toast = pushToast;

  return { jobs, rips, drives, connected, queuePaused, toasts, toast, toastControls: { dismiss: dismissToast, pause: pauseToast, resume: resumeToast } };
}
