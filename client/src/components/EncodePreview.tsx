import { withBase } from '../base';
import { useEffect, useRef, useState } from 'react';
import type { Job } from '@shared/types';
import { fmtBytes, fmtDuration } from '../api';
import { useApp } from '../App';
import { Icon } from './Icons';
import { Modal } from './Modal';

const ACTIVE = ['probing', 'encoding', 'finalizing'];

/** Image that refreshes on an interval and keeps showing the last good frame while the next one loads. */
function RefreshingImage({ url, everyMs, alt, onTime }: { url: string; everyMs: number; alt: string; onTime?: (t: number | null) => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let stopped = false;
    let prev: string | null = null;
    const load = async () => {
      try {
        const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}`);
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          if (!stopped) setError(j.error ?? `HTTP ${res.status}`);
        } else {
          const blob = await res.blob();
          const next = URL.createObjectURL(blob);
          if (stopped) return URL.revokeObjectURL(next);
          setSrc(next);
          setError(null);
          const t = res.headers.get('X-Frame-Time');
          onTime?.(t ? Number(t) : null);
          if (prev) URL.revokeObjectURL(prev);
          prev = next;
        }
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      } finally {
        if (!stopped) setLoading(false);
      }
    };
    void load();
    const timer = setInterval(load, everyMs);
    return () => {
      stopped = true;
      clearInterval(timer);
      if (prev) URL.revokeObjectURL(prev);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, everyMs]);
  return (
    <div className="previewFrame">
      {src ? <img src={src} alt={alt} draggable={false} /> : <div className="previewEmpty">{loading ? <span className="spinner" /> : error ?? 'Waiting for the first frame…'}</div>}
      {src && error && <div className="previewStale" title={error}>paused</div>}
    </div>
  );
}

/** Before / after swipe: drag the divider (or move the mouse while holding) to reveal source vs encoded. */
function SwipeCompare({ left, right, leftLabel, rightLabel }: { left: string; right: string; leftLabel: string; rightLabel: string }) {
  const [x, setX] = useState(50);
  const box = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const move = (clientX: number) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    setX(Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100)));
  };
  return (
    <div
      ref={box}
      className="swipeCompare"
      onPointerDown={(e) => {
        dragging.current = true;
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        move(e.clientX);
      }}
      onPointerMove={(e) => dragging.current && move(e.clientX)}
      onPointerUp={() => (dragging.current = false)}
      onPointerCancel={() => (dragging.current = false)}
    >
      <img src={right} alt={rightLabel} draggable={false} />
      <img src={left} alt={leftLabel} draggable={false} className="swipeTop" style={{ clipPath: `inset(0 ${100 - x}% 0 0)` }} />
      <div className="swipeDivider" style={{ left: `${x}%` }}>
        <span />
      </div>
      <span className="swipeLabel left">{leftLabel}</span>
      <span className="swipeLabel right">{rightLabel}</span>
    </div>
  );
}

/** Loads both frames for a timestamp before swapping them in, so the two sides always match. */
function useFramePair(jobId: string, t: number, width: number) {
  const [pair, setPair] = useState<{ source: string; output: string; t: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const get = async (which: string) => {
          const res = await fetch(withBase(`/api/jobs/${jobId}/frame?which=${which}&t=${t.toFixed(1)}&w=${width}`));
          if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
          return URL.createObjectURL(await res.blob());
        };
        const [source, output] = await Promise.all([get('source'), get('output')]);
        if (cancelled) return;
        setPair((prev) => {
          if (prev) {
            URL.revokeObjectURL(prev.source);
            URL.revokeObjectURL(prev.output);
          }
          return { source, output, t };
        });
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [jobId, t, width]);
  return { pair, loading, error };
}

export function EncodePreviewModal({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const { jobs } = useApp();
  const job = jobs.find((j) => j.id === jobId);
  const [mode, setMode] = useState<'side' | 'swipe'>(() => (localStorage.getItem('rexarr.previewMode') as 'side' | 'swipe') || 'side');
  const [encodedT, setEncodedT] = useState<number | null>(null);
  const duration = job?.durationSeconds ?? 0;
  const [t, setT] = useState(() => Math.round((job?.durationSeconds ?? 0) * 0.25));
  useEffect(() => localStorage.setItem('rexarr.previewMode', mode), [mode]);
  if (!job) return null;
  const active = ACTIVE.includes(job.status);
  const done = job.status === 'done' && job.outputPath;
  const p = job.progress;
  return (
    <Modal title={`Preview · ${job.title}${job.subtitle ? ` · ${job.subtitle}` : ''}`} onClose={onClose} wide>
      <div className="inline mb" style={{ gap: 10 }}>
        <div className="seg sm">
          <button className={mode === 'side' ? 'active' : ''} onClick={() => setMode('side')}>
            Side by side
          </button>
          <button className={mode === 'swipe' ? 'active' : ''} onClick={() => setMode('swipe')} disabled={active}>
            Swipe
          </button>
        </div>
        <span className="badge">{job.profileName}</span>
        {active && (
          <span className="small dim">
            {p.percent.toFixed(1)}% · {p.fps ? `${p.fps.toFixed(0)} fps · ` : ''}
            {p.speed || ''}
            {p.etaSeconds !== null ? ` · ETA ${fmtDuration(p.etaSeconds)}` : ''}
          </span>
        )}
        {done && job.inputSizeBytes && job.outputSizeBytes ? (
          <span className="small dim">
            {fmtBytes(job.inputSizeBytes)} → {fmtBytes(job.outputSizeBytes)} ({((job.outputSizeBytes / job.inputSizeBytes) * 100).toFixed(0)}%)
          </span>
        ) : null}
      </div>

      {active && job.status === 'probing' && <div className="info small">Reading the source… the preview starts as soon as encoding begins.</div>}

      {active && job.status !== 'probing' && (
        <>
          <div className="previewGrid">
            <div>
              <div className="previewCaption">
                <span className="badge sm">Source · live</span>
                <span className="small muted">at {fmtDuration(p.outTimeSeconds)}</span>
              </div>
              {job.preview ? <RefreshingImage url={withBase(`/api/jobs/${job.id}/preview/live.jpg`)} everyMs={3000} alt="Current source frame" /> : <div className="previewFrame"><div className="previewEmpty">No live preview for this profile (video is copied).</div></div>}
            </div>
            <div>
              <div className="previewCaption">
                <span className="badge sm remux">Encoded</span>
                <span className="small muted">{encodedT !== null ? `at ${fmtDuration(encodedT)} (a few seconds behind)` : 'from the file being written'}</span>
              </div>
              <RefreshingImage url={withBase(`/api/jobs/${job.id}/preview/encoded.jpg?w=960`)} everyMs={7000} alt="Encoded frame" onTime={setEncodedT} />
            </div>
          </div>
          <div className="progress md mt">
            <div style={{ width: `${p.percent.toFixed(1)}%` }} />
            <span className="text">{p.percent.toFixed(1)}%</span>
          </div>
          <div className="small muted mt">The source frame refreshes every 3 s from the running encode; the encoded frame is read from the output file. They show nearby but not identical moments – open the preview again when the job is done for an exact before / after comparison.</div>
        </>
      )}

      {done && <CompareView job={job} t={t} setT={setT} duration={duration} mode={mode} />}

      {!active && !done && <div className="empty">{job.status === 'failed' ? `The encode failed: ${job.error ?? ''}` : job.status === 'cancelled' ? 'The encode was cancelled.' : job.status === 'waiting' ? (job.source.disc ? 'Waiting for the full-disc download; it is ripped with MakeMKV before encoding.' : 'Waiting for the *arr app to import the file.') : 'The preview becomes available when encoding starts.'}</div>}
    </Modal>
  );
}

function CompareView({ job, t, setT, duration, mode }: { job: Job; t: number; setT: (n: number) => void; duration: number; mode: 'side' | 'swipe' }) {
  const width = mode === 'swipe' ? 1600 : 960;
  const { pair, loading, error } = useFramePair(job.id, t, width);
  const marks = [0.1, 0.25, 0.5, 0.75, 0.9];
  return (
    <>
      {error && <div className="error small">{error}</div>}
      <div style={{ position: 'relative' }}>
        {loading && <span className="spinner previewSpinner" />}
        {pair ? (
          mode === 'swipe' ? (
            <SwipeCompare left={pair.source} right={pair.output} leftLabel="Source" rightLabel="Encoded" />
          ) : (
            <div className="previewGrid">
              <div>
                <div className="previewCaption">
                  <span className="badge sm">Source</span>
                  <span className="small muted">{fmtBytes(job.inputSizeBytes)}</span>
                </div>
                <div className="previewFrame">
                  <img src={pair.source} alt="Source frame" draggable={false} />
                </div>
              </div>
              <div>
                <div className="previewCaption">
                  <span className="badge sm remux">Encoded</span>
                  <span className="small muted">{fmtBytes(job.outputSizeBytes)}</span>
                </div>
                <div className="previewFrame">
                  <img src={pair.output} alt="Encoded frame" draggable={false} />
                </div>
              </div>
            </div>
          )
        ) : (
          <div className="previewFrame">
            <div className="previewEmpty">{loading ? <span className="spinner" /> : 'Loading frames…'}</div>
          </div>
        )}
      </div>
      <div className="inline mt" style={{ gap: 12, flexWrap: 'nowrap' }}>
        <button className="iconButton" title="Back 10 s" onClick={() => setT(Math.max(0, t - 10))}>
          <Icon.ChevronRight />
        </button>
        <input className="previewSlider" type="range" min={0} max={Math.max(1, Math.floor(duration))} step={1} value={t} onChange={(e) => setT(Number(e.target.value))} />
        <span className="mono small" style={{ minWidth: 90, textAlign: 'right' }}>
          {fmtClock(t)} / {fmtClock(duration)}
        </span>
      </div>
      <div className="inline small" style={{ gap: 6 }}>
        <span className="dim">Jump to</span>
        {marks.map((m) => (
          <button key={m} className="btn sm" onClick={() => setT(Math.round(duration * m))}>
            {Math.round(m * 100)}%
          </button>
        ))}
        <span className="spacer" />
        <span className="muted">Frames are taken from both files at the same timestamp.</span>
      </div>
    </>
  );
}

function fmtClock(s: number) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

/** Small live thumbnail for the Activity row while encoding. */
export function LiveThumb({ job, onClick }: { job: Job; onClick: () => void }) {
  const [bust, setBust] = useState(0);
  const [ok, setOk] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setBust((b) => b + 1), 5000);
    return () => clearInterval(t);
  }, []);
  return (
    <button className="liveThumb" onClick={onClick} title="Open preview">
      <img src={withBase(`/api/jobs/${job.id}/preview/live.jpg?_=${bust}`)} alt="" onLoad={() => setOk(true)} onError={() => setOk(false)} style={{ opacity: ok ? 1 : 0 }} />
      {!ok && <span className="liveThumbPoster" style={{ backgroundImage: job.poster ? `url(${job.poster})` : undefined }} />}
      <span className="liveDot" />
    </button>
  );
}
