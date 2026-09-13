import type { Release } from '@shared/types';
import { fmtBytes } from '../api';
import { Icon } from './Icons';
import { ProtocolLabel, QualityLabel } from './Labels';

export function ReleaseTable({ releases, onGrab, busyGuid }: { releases: Release[]; onGrab: (r: Release) => void; busyGuid?: string | null }) {
  if (!releases.length) return <div className="empty">No releases.</div>;
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>Title</th>
            <th>Quality</th>
            <th>Indexer</th>
            <th className="num">Size</th>
            <th className="num">Peers</th>
            <th className="num">Age</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {releases.map((r) => (
            <tr key={`${r.indexerId}-${r.guid}`}>
              <td style={{ maxWidth: 520 }}>
                <div className="truncate" title={r.title}>
                  {r.title}
                </div>
                <div className="small muted inline" style={{ gap: 6 }}>
                  {r.languages.slice(0, 3).map((l) => (
                    <span key={l}>{l}</span>
                  ))}
                  {r.fullSeason && <span className="badge blue">Season pack</span>}
                  {!r.approved && r.rejections.length > 0 && (
                    <span className="badge red" title={r.rejections.join('\n')}>
                      Rejected by *arr
                    </span>
                  )}
                </div>
              </td>
              <td>
                <QualityLabel quality={r.quality || (r.isRemux ? 'Remux' : 'Unknown')} isRemux={r.isRemux} />
              </td>
              <td className="dim" style={{ whiteSpace: 'nowrap' }}>
                {r.indexer} <ProtocolLabel protocol={r.protocol} />
              </td>
              <td className="num">{fmtBytes(r.size)}</td>
              <td className="num dim">{r.protocol === 'usenet' ? '—' : `${r.seeders ?? 0} / ${r.leechers ?? 0}`}</td>
              <td className="num dim">{r.ageDays}d</td>
              <td className="num">
                <button className="iconButton" disabled={busyGuid === r.guid} onClick={() => onGrab(r)} title={r.rejections.join('\n') || 'Grab and transcode when imported'} style={{ color: r.isRemux ? 'var(--themeBlue)' : undefined }}>
                  {busyGuid === r.guid ? <span className="spinner" /> : <Icon.Download />}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
