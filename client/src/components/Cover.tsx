import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

/** Global toggle for the 3D cover effect (persisted per browser). */
export function cover3dEnabled(): boolean {
  try {
    return localStorage.getItem('rexarr.cover3d') !== '0';
  } catch {
    return true;
  }
}
export function setCover3dEnabled(on: boolean) {
  try {
    localStorage.setItem('rexarr.cover3d', on ? '1' : '0');
  } catch {
    /* ignore */
  }
  document.documentElement.dataset.cover3d = on ? 'on' : 'off';
}

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * Cover art rendered as a physical case: a lit left spine, a shaded right edge and a mouse-tracking tilt
 * with a moving glare. The image is lazy-loaded and fades in when decoded, so long grids scroll smoothly.
 */
export function Cover({ src, className, style, children, maxAngle = 12, scale = 1.04, title, eager }: { src?: string; className?: string; style?: CSSProperties; children?: ReactNode; maxAngle?: number; scale?: number; title?: string; eager?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const glare = useRef<HTMLDivElement>(null);
  const frame = useRef<number>(0);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    if (!document.documentElement.dataset.cover3d) document.documentElement.dataset.cover3d = cover3dEnabled() ? 'on' : 'off';
  }, []);
  useEffect(() => {
    setLoaded(false);
    setFailed(false);
    setAttempt(0);
    return () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
  }, [src]);
  /** A failed load is retried twice (1.5 s, 5 s) before showing the fallback. */
  const onError = () => {
    if (attempt < 2) {
      retryTimer.current = setTimeout(() => setAttempt((a) => a + 1), attempt === 0 ? 1500 : 5000);
    } else setFailed(true);
  };
  const imgSrc = src ? (attempt ? `${src}${src.includes('?') ? '&' : '?'}retry=${attempt}` : src) : undefined;
  // A cached image can be complete before React attaches onLoad; check once after mount / src change.
  useEffect(() => {
    const i = imgRef.current;
    if (i && i.complete && i.naturalWidth > 0) setLoaded(true);
  }, [imgSrc]);

  const move = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el || reducedMotion() || document.documentElement.dataset.cover3d === 'off') return;
    const r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width;
    const py = (e.clientY - r.top) / r.height;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const rx = (0.5 - py) * maxAngle;
      const ry = (px - 0.5) * maxAngle;
      el.style.transform = `perspective(900px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) scale(${scale})`;
      if (glare.current) {
        glare.current.style.opacity = '1';
        glare.current.style.background = `radial-gradient(circle at ${(px * 100).toFixed(1)}% ${(py * 100).toFixed(1)}%, rgba(255,255,255,0.28), rgba(255,255,255,0.06) 35%, rgba(0,0,0,0.12) 75%)`;
      }
    });
  };
  const leave = () => {
    const el = ref.current;
    if (!el) return;
    cancelAnimationFrame(frame.current);
    el.style.transform = '';
    if (glare.current) glare.current.style.opacity = '0';
  };

  return (
    <div ref={ref} className={`cover3d${className ? ` ${className}` : ''}${loaded ? ' loaded' : ''}`} style={style} onMouseMove={move} onMouseLeave={leave} title={title}>
      {src && !failed && <img key={attempt} ref={imgRef} className="coverImg" src={imgSrc} alt="" loading={eager ? 'eager' : 'lazy'} decoding="async" draggable={false} onLoad={() => setLoaded(true)} onError={onError} />}
      {(!src || failed || !loaded) && <div className="coverFallback">{!src || failed ? children : null}</div>}
      <div ref={glare} className="cover3dGlare" />
    </div>
  );
}

/** Placeholder grid shown while a library loads. */
export function PosterSkeleton({ count = 12 }: { count?: number }) {
  return (
    <div className="poster-grid" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="poster skeleton" style={{ animationDelay: `${(i % 6) * 80}ms` }}>
          <div className="img" />
          <div className="meta">
            <div className="title">&nbsp;</div>
            <div className="sub">&nbsp;</div>
          </div>
        </div>
      ))}
    </div>
  );
}
