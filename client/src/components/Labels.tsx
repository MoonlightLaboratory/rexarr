import type { ReactNode } from 'react';

/** Colour a quality name the way the *arr apps do: remux gold, Blu-ray blue, WEB teal, HDTV grey, missing red. */
export function qualityClass(quality?: string, isRemux?: boolean): string {
  if (!quality) return 'red';
  if (isRemux || /remux/i.test(quality)) return 'remux';
  if (/bluray|brdisk|bd/i.test(quality)) return 'blue';
  if (/web/i.test(quality)) return 'teal';
  if (/dvd/i.test(quality)) return 'purple';
  // music (Lidarr quality names / format labels)
  if (/mqa/i.test(quality)) return 'purple';
  if (/(flac|alac|wav|aiff|ape|wavpack|wv)\b.*\b(24|32)\b|hi[- ]?res|24[ -]?bit|\/(88|96|176|192)/i.test(quality)) return 'remux';
  if (/flac|alac|wav|aiff|ape|wavpack|lossless/i.test(quality)) return 'green';
  if (/mp3|aac|opus|vorbis|ogg|m4a/i.test(quality)) return 'teal';
  return '';
}

/** "FLAC 24/96" from file details. */
export function musicFileLabel(f: { quality: string; codec?: string; bitDepth?: number; sampleRate?: number; bitrate?: number; lossless: boolean }) {
  const codec = (f.codec || f.quality.split(/[\s-]/)[0] || '').toUpperCase().replace('WAVPACK', 'WavPack');
  if (f.lossless && (f.bitDepth || f.sampleRate)) return `${codec} ${f.bitDepth ?? ''}${f.bitDepth && f.sampleRate ? '/' : ''}${f.sampleRate ? String(f.sampleRate / 1000).replace(/\.0$/, '') : ''}`.trim();
  if (!f.lossless && f.bitrate) return `${codec} ${Math.round(f.bitrate)}`;
  return f.quality;
}

export function QualityLabel({ quality, isRemux, size }: { quality?: string; isRemux?: boolean; size?: 'sm' | 'lg' }) {
  return <span className={`badge ${qualityClass(quality, isRemux)}${size ? ` ${size}` : ''}`}>{quality ?? 'Missing'}</span>;
}

export function ProtocolLabel({ protocol }: { protocol: string }) {
  if (protocol === 'soulseek')
    return (
      <span className="badge outline" style={{ color: 'var(--purple)', borderColor: 'var(--purple)' }}>
        soulseek
      </span>
    );
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
