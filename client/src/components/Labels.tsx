import type { ReactNode } from 'react';

/** Colour a quality name the way the *arr apps do: remux gold, Blu-ray blue, WEB teal, HDTV grey, missing red. */
export function qualityClass(quality?: string, isRemux?: boolean): string {
  if (!quality) return 'red';
  if (isRemux || /remux/i.test(quality)) return 'remux';
  if (/bluray|brdisk|bd/i.test(quality)) return 'blue';
  if (/web/i.test(quality)) return 'teal';
  if (/dvd/i.test(quality)) return 'purple';
  return '';
}

export function QualityLabel({ quality, isRemux, size }: { quality?: string; isRemux?: boolean; size?: 'sm' | 'lg' }) {
  return <span className={`badge ${qualityClass(quality, isRemux)}${size ? ` ${size}` : ''}`}>{quality ?? 'Missing'}</span>;
}

export function ProtocolLabel({ protocol }: { protocol: string }) {
  const usenet = protocol === 'usenet';
  return (
    <span className="badge outline" style={{ color: usenet ? 'var(--usenetColor)' : 'var(--torrentColor)', borderColor: usenet ? 'var(--usenetColor)' : 'var(--torrentColor)' }}>
      {usenet ? 'usenet' : 'torrent'}
    </span>
  );
}

/** Ripple loading indicator in the spirit of the *arr apps. */
export function LoadingIndicator({ children, size = 50 }: { children?: ReactNode; size?: number }) {
  return (
    <div className="loading">
      <div className="ripple" style={{ width: size, height: size }}>
        <span />
        <span />
      </div>
      {children && <div className="loadingText">{children}</div>}
    </div>
  );
}
