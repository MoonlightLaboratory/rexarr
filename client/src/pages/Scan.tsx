import { useEffect, useRef, useState } from 'react';
import type { BarcodeLookup } from '@shared/types';
import { api } from '../api';
import { Icon } from '../components/Icons';

/**
 * The page a phone opens from the QR code on Settings → Experiments: point the camera at a disc's barcode, or
 * type the number in, and confirm what Rexarr found. Deliberately standalone – no sidebar, big targets, one job.
 *
 * The camera needs a secure context (https, or localhost), which plain http on a LAN is not; there the page falls
 * back to typing the number, which works everywhere.
 */
type Phase = { state: 'idle' } | { state: 'looking'; code: string } | { state: 'found'; result: BarcodeLookup } | { state: 'done'; title: string } | { state: 'error'; message: string; code?: string };

const canScan = () => typeof window !== 'undefined' && 'BarcodeDetector' in window && window.isSecureContext;

export function ScanPage() {
  const [phase, setPhase] = useState<Phase>({ state: 'idle' });
  const [manual, setManual] = useState('');
  const [camera, setCamera] = useState(false);
  const video = useRef<HTMLVideoElement | null>(null);
  const stream = useRef<MediaStream | null>(null);

  const stop = () => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    setCamera(false);
  };
  useEffect(() => stop, []); // eslint-disable-line react-hooks/exhaustive-deps

  const lookup = async (code: string) => {
    setPhase({ state: 'looking', code });
    try {
      const result = await api.barcodeLookup(code);
      setPhase({ state: 'found', result });
    } catch (e) {
      setPhase({ state: 'error', message: (e as Error).message, code });
    }
  };

  const start = async () => {
    if (!canScan()) return;
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      stream.current = s;
      setCamera(true);
      if (video.current) {
        video.current.srcObject = s;
        await video.current.play().catch(() => undefined);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const detector = new (window as any).BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'] });
      const tick = async () => {
        if (!stream.current || !video.current) return;
        try {
          const codes = await detector.detect(video.current);
          const value = codes?.[0]?.rawValue;
          if (value) {
            stop();
            void lookup(value);
            return;
          }
        } catch {
          /* a frame that cannot be read is not worth stopping for */
        }
        setTimeout(tick, 350);
      };
      void tick();
    } catch (e) {
      setPhase({ state: 'error', message: `The camera did not open: ${(e as Error).message}` });
      stop();
    }
  };

  const confirm = async (choice: { kind: 'movie' | 'series'; title: string; year?: number; externalId?: number; arrId?: number; seasonNumber?: number }) => {
    if (phase.state !== 'found') return;
    const p = phase.result.product;
    try {
      const { expected } = await api.expectDisc({ code: p.code, product: p.product, seasonNumber: choice.seasonNumber ?? p.seasonNumber, ...choice });
      setPhase({ state: 'done', title: expected.title });
    } catch (e) {
      setPhase({ state: 'error', message: (e as Error).message, code: p.code });
    }
  };

  return (
    <div className="scanPage">
      <h1 className="scanTitle">Scan a disc</h1>

      {phase.state === 'idle' && (
        <>
          {canScan() ? (
            camera ? (
              <>
                <video ref={video} className="scanVideo" playsInline muted />
                <button className="btn scanBtn" onClick={stop}>
                  Stop the camera
                </button>
              </>
            ) : (
              <button className="btn primary scanBtn" onClick={start}>
                <Icon.Search /> Use the camera
              </button>
            )
          ) : (
            <p className="scanNote">
              This browser will not give the page a camera{typeof window !== 'undefined' && !window.isSecureContext ? ' because the page is not served over HTTPS' : ''}. Type
              the number under the barcode instead.
            </p>
          )}
          <form
            className="scanForm"
            onSubmit={(e) => {
              e.preventDefault();
              if (manual.trim()) void lookup(manual.trim());
            }}
          >
            <input type="text" inputMode="numeric" autoComplete="off" placeholder="Barcode number" value={manual} onChange={(e) => setManual(e.target.value)} />
            <button className="btn" type="submit" disabled={!manual.trim()}>
              Look it up
            </button>
          </form>
        </>
      )}

      {phase.state === 'looking' && (
        <p className="scanNote">
          <span className="spinner" /> Looking up {phase.code}…
        </p>
      )}

      {phase.state === 'found' && (
        <div className="scanResult">
          <p className="scanProduct">{phase.result.product.product}</p>
          <p className="scanNote">
            {phase.result.product.code} · {phase.result.product.source}
          </p>
          {phase.result.inLibrary ? (
            <button className="btn primary scanBtn" onClick={() => confirm({ kind: phase.result.inLibrary!.kind, title: phase.result.inLibrary!.title, year: phase.result.inLibrary!.year, arrId: phase.result.inLibrary!.id, seasonNumber: phase.result.inLibrary!.season })}>
              Expect “{phase.result.inLibrary.title}” (already in your library)
            </button>
          ) : phase.result.lookup.length ? (
            <>
              <p className="scanNote">Not in your library yet – pick what it is and Rexarr will add it:</p>
              {phase.result.lookup.map((l) => (
                <button key={`${l.kind}${l.externalId}`} className="btn scanBtn" onClick={() => confirm({ kind: l.kind, title: l.title, year: l.year, externalId: l.externalId })}>
                  {l.title} {l.year ? `(${l.year})` : ''} · {l.kind}
                </button>
              ))}
            </>
          ) : (
            <p className="scanNote">Nothing in Radarr or Sonarr matches “{phase.result.product.title}”. Search for it on the Discs page instead.</p>
          )}
          <button className="btn scanBtn" onClick={() => setPhase({ state: 'idle' })}>
            Scan another
          </button>
        </div>
      )}

      {phase.state === 'done' && (
        <div className="scanResult">
          <p className="scanProduct">
            <Icon.Check /> {phase.title} is expected
          </p>
          <p className="scanNote">Put the disc in a drive when you are ready – Rexarr knows what it is.</p>
          <button className="btn primary scanBtn" onClick={() => (setManual(''), setPhase({ state: 'idle' }))}>
            Scan another
          </button>
        </div>
      )}

      {phase.state === 'error' && (
        <div className="scanResult">
          <p className="scanNote scanError">{phase.message}</p>
          <button className="btn scanBtn" onClick={() => (setManual(''), setPhase({ state: 'idle' }))}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
