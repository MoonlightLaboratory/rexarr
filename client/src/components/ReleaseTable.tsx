import type { Release, ReleaseCategory } from '@shared/types';
import { fmtBytes } from '../api';
import { Icon } from './Icons';
import { ProtocolLabel, QualityLabel } from './Labels';

export const CATEGORY_LABEL: Record<ReleaseCategory, string> = { remux: 'Remux', disc: 'Disc / ISO', bluray: 'Blu-ray', web: 'WEB', hdtv: 'HDTV', dvd: 'DVD', other: 'Other', hires: 'Hi-Res', cd: 'CD Quality', mqa: 'MQA', lossy: 'Lossy' };

export type ReleaseSortKey = 'score' | 'protocol' | 'age' | 'title' | 'indexer' | 'size' | 'peers' | 'quality';

/** Sonarr's Peers label: primary > 50 seeders, info > 10, warning > 0, danger none. */
function peersKind(seeders: number) {
  return seeders > 50 ? 'primaryLabel' : seeders > 10 ? 'blue' : seeders > 0 ? 'warning' : 'red';
}

/** Sonarr's custom format score formatting: +120 / -10 / 0. */
function formatScore(n: number) {
  return n > 0 ? `+${n}` : String(n);
}

/** Tags worth a coloured label: dynamic range warning (gold), lossless audio success. */
function tagKind(t: string) {
  if (t === 'DV' || t.startsWith('HDR')) return 'warning';
  if (['TrueHD', 'DTS:X', 'DTS-HD MA', 'FLAC', 'LPCM', 'Atmos'].includes(t)) return 'green';
  return '';
}

function formatAge(days: number) {
  if (days < 1) return 'today';
  if (days < 60) return `${Math.round(days)} ${Math.round(days) === 1 ? 'day' : 'days'}`;
  if (days < 730) return `${Math.round(days / 30)} months`;
  return `${Math.round(days / 365)} years`;
}

/** Interactive search results, laid out like Sonarr's InteractiveSearch table. */
export function ReleaseTable({
  releases,
  onGrab,
  busyGuid,
  bestGuid,
  highlight,
  sort,
  onSort,
}: {
  releases: Release[];
  onGrab: (r: Release) => void;
  busyGuid?: string | null;
  bestGuid?: string;
  highlight?: string;
  sort?: ReleaseSortKey;
  onSort?: (key: ReleaseSortKey) => void;
}) {
  if (!releases.length) return <div className="empty">No results found</div>;
  const words = (highlight ?? '').toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  const th = (key: ReleaseSortKey, label: string, cls = '', title?: string) => (
    <th className={`${cls}${onSort ? ' sortable' : ''}${sort === key ? ' active' : ''}`} onClick={() => onSort?.(key)} title={title}>
      {label}
    </th>
  );
  return (
    <div className="tbl-wrap">
      <table className="tbl releaseTbl">
        <thead>
          <tr>
            {th('protocol', 'Source')}
            {th('age', 'Age')}
            {th('title', 'Title')}
            {th('indexer', 'Indexer')}
            {th('size', 'Size', 'num')}
            {th('peers', 'Peers')}
            <th>Languages</th>
            {th('quality', 'Quality')}
            {th('score', 'Score', 'num', 'rexarr score: source, resolution, what you searched for, availability')}
            <th className="iconCell" />
            <th className="iconCell" />
          </tr>
        </thead>
        <tbody>
          {releases.map((r) => (
            <tr key={`${r.indexerId}-${r.guid}`}>
              <td>
                <ProtocolLabel protocol={r.protocol} />
              </td>
              <td className="dim nowrap">{r.source === 'soulseek' ? '—' : formatAge(r.ageDays)}</td>
              <td className="releaseTitleCell">
                <div className="releaseTitle" title={r.title}>
                  <Highlight text={r.title} words={words} />
                </div>
                <div className="releaseLabels">
                  {r.guid === bestGuid && (
                    <span className="badge sm outline green" title="Highest score in the current view">
                      Best
                    </span>
                  )}
                  {r.category && r.category !== 'remux' && <span className={`badge sm ${r.isDisc ? 'purple' : 'outline'}`}>{r.isDisc ? `${r.discFormat === 'uhd' ? 'UHD Blu-ray' : r.discFormat === 'dvd' ? 'DVD' : 'Blu-ray'} disc` : CATEGORY_LABEL[r.category]}</span>}
                  {r.fullSeason && <span className="badge sm blue">{r.source === 'lidarr' ? 'Discography' : 'Season pack'}</span>}
                  {r.music?.trackCount ? <span className="badge sm">{r.music.trackCount} tracks</span> : null}
                  {r.music?.cue ? <span className="badge sm purple" title="One audio file per disc with a cue sheet. rexarr splits it into tracks after the download so Lidarr can import it.">image + cue</span> : null}
                  {r.tags?.map((t) => (
                    <span key={t} className={`badge sm ${tagKind(t)}`}>
                      {t}
                    </span>
                  ))}
                </div>
              </td>
              <td className="dim nowrap">{r.indexer}</td>
              <td className="num nowrap">{fmtBytes(r.size)}</td>
              <td className="nowrap">
                {r.protocol === 'torrent' ? <span className={`badge ${peersKind(r.seeders ?? 0)}`}>{`${r.seeders ?? 0} / ${r.leechers ?? 0}`}</span> : null}
                {r.source === 'soulseek' && (
                  <span className={`badge ${r.music?.freeSlot ? 'green' : (r.music?.queueLength ?? 0) > 10 ? 'red' : 'warning'}`} title={`${r.music?.freeSlot ? 'Free upload slot' : 'No free slot'} · ${r.music?.queueLength ?? 0} queued · ${Math.round((r.music?.uploadSpeed ?? 0) / 1024)} KB/s`}>
                    {r.music?.freeSlot ? 'slot free' : `queue ${r.music?.queueLength ?? 0}`}
                  </span>
                )}
              </td>
              <td>
                {r.languages.slice(0, 2).map((l) => (
                  <span key={l} className="badge">
                    {l}
                  </span>
                ))}
                {r.languages.length > 2 && (
                  <span className="badge" title={r.languages.slice(2).join(', ')}>
                    +{r.languages.length - 2}
                  </span>
                )}
              </td>
              <td>
                <QualityLabel quality={r.quality || (r.isRemux ? 'Remux' : 'Unknown')} isRemux={r.isRemux} />
              </td>
              <td className="num nowrap" title={r.scoreReasons?.join('\n')}>
                {r.score !== undefined ? formatScore(r.score) : ''}
              </td>
              <td className="iconCell">
                {!r.approved && r.rejections.length > 0 && (
                  <span className="rejectionIcon" title={r.rejections.join('\n')}>
                    <Icon.Alert />
                  </span>
                )}
              </td>
              <td className="iconCell">
                <button className="iconButton" disabled={busyGuid === r.guid} onClick={() => onGrab(r)} title={r.isDisc ? 'Grab, rip with MakeMKV and transcode when downloaded' : 'Grab and transcode when imported'}>
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

/** Mark the words the user filtered by. */
function Highlight({ text, words }: { text: string; words: string[] }) {
  if (!words.length) return <>{text}</>;
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return (
    <>
      {text.split(re).map((part, i) =>
        i % 2 ? (
          <mark key={i} className="hl">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}
