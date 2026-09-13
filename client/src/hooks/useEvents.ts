import { useEffect, useRef, useState } from 'react';
import type { DiscDrive, DiscRip, Job, ServerEvent } from '@shared/types';
import { api } from '../api';

export interface Toast {
  id: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

/** Keeps a live list of jobs via SSE (falls back to polling if the stream drops). */
export function useJobs() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [rips, setRips] = useState<DiscRip[]>([]);
  const [drives, setDrives] = useState<DiscDrive[]>([]);
  const [connected, setConnected] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);

  useEffect(() => {
    let es: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let stopped = false;

    const pushToast = (level: Toast['level'], message: string) => {
      const id = ++toastId.current;
      setToasts((t) => [...t, { id, level, message }]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
    };

    const connect = () => {
      if (stopped) return;
      es = new EventSource('/api/events');
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
        }
      };
      for (const t of ['jobs', 'job', 'job-removed', 'notice', 'rips', 'rip', 'rip-removed', 'drives']) es.addEventListener(t, handle as EventListener);
    };
    connect();
    return () => {
      stopped = true;
      es?.close();
      if (poll) clearInterval(poll);
    };
  }, []);

  const toast = (level: Toast['level'], message: string) => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, level, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  };

  return { jobs, rips, drives, connected, toasts, toast };
}
