import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { LocalFile, LocalItem, LocalMetaCandidate } from '@shared/types';
import { api, fmtBytes } from '../api';
import { useApp } from '../App';
import { Page, ToolbarButton, ToolbarSeparator } from '../components/Layout';
import { Icon } from '../components/Icons';
import { LoadingIndicator, QualityLabel } from '../components/Labels';
import { DetailHeader } from '../components/DetailHeader';
import { TranscodeModal, type TranscodeItem } from '../components/TranscodeModal';
import { Modal } from '../components/Modal';
import { Cover } from '../components/Cover';

type Item = Omit<LocalItem, 'files'> & { files: (LocalFile & { exists: boolean })[] };

const KIND = { movie: 'Movie', series: 'Series', album: 'Album' } as const;
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

function fileLabel(it: Item, f: LocalFile) {
  if (it.kind === 'series') {
    if (f.season !== undefined && f.episode !== undefined) return `S${String(f.season).padStart(2, '0')}E${String(f.episode).padStart(2, '0')}`;
    if (f.absolute !== undefined) return `#${f.absolute}`;
    return f.episode !== undefined ? `E${f.episode}` : '';
  }
  if (it.kind === 'album') return `${f.disc ? `${f.disc}-` : ''}${f.track ?? ''}`;
  return '';
}

/** A title found on disk outside Radarr / Sonarr / Lidarr: its files, encode, and a way into the *arr apps. */
export function LocalItemPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const { jobs, toast } = useApp();
  const [it, setIt] = useState<Item | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [modal, setModal] = useState<TranscodeItem[] | null>(null);
  const [fixing, setFixing] = useState(false);

  const load = () =>
    api
      .localItem(id)
      .then((r) => setIt(r))
      .catch((e) => setError(e.message));
  useEffect(() => {
    setIt(null);
    setError(null);
    setSelected(new Set());
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  const meta = it?.meta?.status === 'matched' ? it.meta : undefined;
  const posterUrl = it?.poster ? `api/local/items/${it.id}/poster` : meta?.poster;

  const queued = useMemo(() => new Set(jobs.filter((j) => !['failed', 'cancelled', 'done'].includes(j.status)).map((j) => j.source.localPath)), [jobs]);
  const groups = useMemo(() => {
    if (!it) return [];
    const key = (f: LocalFile) => (it.kind === 'series' ? (f.season !== undefined ? `Season ${f.season}` : 'Episodes') : it.kind === 'album' ? (f.disc ? `Disc ${f.disc}` : '') : '');
    const map = new Map<string, Item['files']>();
    for (const f of it.files) map.set(key(f), [...(map.get(key(f)) ?? []), f]);
    return [...map.entries()];
  }, [it]);

  const items = (files: LocalFile[]): TranscodeItem[] =>
    files.map((f) => ({
      title: it!.artist ? `${it!.artist} – ${it!.title}` : it!.title,
      subtitle: [fileLabel(it!, f), baseName(f.path)].filter(Boolean).join(' · '),
      poster: posterUrl,
      size: f.size,
      quality: f.quality,
      isRemux: f.isRemux,
      anime: it!.anime,
      source: { kind: 'file', localPath: f.path },
    }));

  const mediaType = it?.kind === 'album' ? 'music' : it?.anime ? 'anime' : it?.kind === 'series' ? 'tv' : 'movie';
  const chosen = it?.files.filter((f) => selected.has(f.path)) ?? [];

  return (
    <Page
      title={it ? it.title : 'Local media'}
      toolbarLeft={
        <>
          <ToolbarButton icon={<Icon.ArrowLeftCircle />} label="Back" onClick={() => nav(-1)} />
          <ToolbarSeparator />
          <ToolbarButton icon={<Icon.Play />} label={chosen.length ? `Encode ${chosen.length}` : 'Encode All'} wide disabled={!it} onClick={() => it && setModal(items(chosen.length ? chosen : it.files.filter((f) => f.exists && !queued.has(f.path))))} />
          <ToolbarButton icon={<Icon.Refresh />} label="Fix Match" wide disabled={!it} onClick={() => setFixing(true)} />
          <ToolbarButton
            icon={<Icon.Search />}
            label={it?.kind === 'album' ? 'Find in Lidarr' : it?.kind === 'series' ? 'Find in Sonarr' : 'Find in Radarr'}
            wide
            disabled={!it}
            onClick={() => it && nav(`/search?q=${encodeURIComponent([it.artist, it.title, it.year].filter(Boolean).join(' '))}`)}
          />
        </>
      }
    >
      {error && <div className="error">{error}</div>}
      {!it && !error && <LoadingIndicator>Loading…</LoadingIndicator>}
      {it && (
        <>
          <DetailHeader
            poster={posterUrl}
            backdrop={meta?.backdrop}
            square={it.kind === 'album'}
            title={meta?.title && it.kind !== 'album' ? meta.title : it.title}
            year={it.year ?? meta?.year}
            runtimeMinutes={meta?.runtimeMinutes}
            rating={meta?.rating}
            genres={meta?.genres ?? []}
            overview={meta?.overview ?? ''}
            attribution={meta ? `Found on disk – metadata from ${meta.source === 'musicbrainz' ? 'MusicBrainz and Cover Art Archive' : meta.source === 'sonarr' ? 'TheTVDB via Sonarr' : 'TMDb'}${meta.source === 'radarr' ? ' via Radarr' : ''}` : 'Found on disk – not managed by Radarr, Sonarr or Lidarr'}
            badges={
              <>
                <span className="badge lg">{KIND[it.kind]}</span>
                {(meta?.artist ?? it.artist) && <span className="badge lg blue">{meta?.artist ?? it.artist}</span>}
                {meta?.type && <span className="badge lg">{meta.type}</span>}
                {meta?.originalTitle && meta.originalTitle !== meta.title && <span className="badge lg outline">{meta.originalTitle}</span>}
                {it.anime && <span className="badge lg purple">Anime</span>}
                <span className="badge lg outline">Local</span>
              </>
            }
            pills={[
              { icon: <Icon.Folder />, text: it.folder, title: 'Folder' },
              { icon: <Icon.HardDrive />, text: fmtBytes(it.size) },
              ...(meta?.url ? [{ icon: <Icon.ExternalLink />, text: meta.source === 'musicbrainz' ? 'MusicBrainz' : meta.source === 'sonarr' ? 'TheTVDB' : 'TMDb', href: meta.url }] : []),
              ...(it.meta?.status === 'none' ? [{ icon: <Icon.Alert />, text: 'No metadata match – use Fix Match' }] : []),
              { icon: <Icon.Disc />, text: `${it.files.length} ${it.kind === 'movie' ? (it.files.length === 1 ? 'file' : 'files') : it.kind === 'album' ? 'tracks' : 'episodes'}` },
            ]}
          />
          {groups.map(([name, files]) => (
            <div key={name || 'files'} className="card mt">
              {name && <div className="card-h">{name}</div>}
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th style={{ width: 30 }}>
                        <input
                          type="checkbox"
                          checked={files.every((f) => selected.has(f.path))}
                          onChange={(e) => {
                            const next = new Set(selected);
                            for (const f of files) e.target.checked ? next.add(f.path) : next.delete(f.path);
                            setSelected(next);
                          }}
                        />
                      </th>
                      {it.kind !== 'movie' && <th style={{ width: 70 }}>#</th>}
                      <th style={{ width: '100%' }}>File</th>
                      {it.kind !== 'album' && <th>Quality</th>}
                      <th className="num">Size</th>
                      <th style={{ width: 50 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {files.map((f) => (
                      <tr key={f.path} className={f.exists ? '' : 'dim'}>
                        <td>
                          <input
                            type="checkbox"
                            checked={selected.has(f.path)}
                            onChange={(e) => {
                              const next = new Set(selected);
                              e.target.checked ? next.add(f.path) : next.delete(f.path);
                              setSelected(next);
                            }}
                          />
                        </td>
                        {it.kind !== 'movie' && <td className="dim">{fileLabel(it, f)}</td>}
                        <td className="truncate" style={{ maxWidth: 0 }} title={f.path}>
                          {baseName(f.path)}
                          {!f.exists && <span className="badge sm red" style={{ marginLeft: 8 }}>missing</span>}
                        </td>
                        {it.kind !== 'album' && <td>{f.quality ? <QualityLabel quality={f.quality} isRemux={f.isRemux} size="sm" /> : <span className="dim">–</span>}</td>}
                        <td className="num dim" style={{ whiteSpace: 'nowrap' }}>{fmtBytes(f.size)}</td>
                        <td>
                          <button
                            className="iconButton"
                            title={queued.has(f.path) ? 'Already in the queue' : 'Encode'}
                            disabled={!f.exists || queued.has(f.path)}
                            onClick={() => setModal(items([f]))}
                          >
                            <Icon.Play />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </>
      )}
      {fixing && it && (
        <FixMatchModal
          it={it}
          onClose={() => setFixing(false)}
          onDone={() => {
            setFixing(false);
            void load();
          }}
        />
      )}
      {modal && (
        <TranscodeModal
          items={modal}
          mediaType={mediaType}
          onClose={() => setModal(null)}
          onQueued={() => {
            setSelected(new Set());
            toast('info', `Queued ${modal.length} file(s)`);
          }}
        />
      )}
    </Page>
  );
}

/** Pick the right TMDb / MusicBrainz entry for a local title. */
function FixMatchModal({ it, onClose, onDone }: { it: Item; onClose: () => void; onDone: () => void }) {
  const { toast } = useApp();
  const [q, setQ] = useState(it.kind === 'album' && it.artist ? `${it.title}` : it.title);
  const [list, setList] = useState<LocalMetaCandidate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const search = (text?: string) => {
    setBusy(true);
    api
      .localCandidates(it.id, text)
      .then(setList)
      .catch((e) => toast('error', e.message))
      .finally(() => setBusy(false));
  };
  useEffect(() => search(), []); // eslint-disable-line react-hooks/exhaustive-deps
  const choose = (c: LocalMetaCandidate) =>
    api
      .localMatch(it.id, { candidate: c })
      .then(() => {
        toast('info', `Matched to ${c.title}${c.year ? ` (${c.year})` : ''}`);
        onDone();
      })
      .catch((e) => toast('error', e.message));
  return (
    <Modal
      title={`Fix Match · ${it.title}`}
      onClose={onClose}
      wide
      footer={
        <>
          {it.meta && (
            <button className="btn" onClick={() => api.localMatch(it.id, { clear: true }).then(onDone).catch((e) => toast('error', e.message))}>
              Clear match
            </button>
          )}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="inline mb" style={{ flexWrap: 'nowrap' }}>
        <input type="search" autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search(q)} placeholder={it.kind === 'album' ? 'Album title (add the artist to narrow it)' : 'Title'} />
        <button className="btn" onClick={() => search(q)} disabled={busy}>
          {busy ? <span className="spinner" /> : <Icon.Search />} Search
        </button>
      </div>
      {list && list.length === 0 && <div className="empty">No matches.</div>}
      <div className="fixMatchList">
        {list?.map((c) => {
          const current = it.meta?.externalId === c.externalId;
          return (
            <div key={`${c.source}-${c.externalId}`} className={`fixMatchRow${current ? ' current' : ''}`} onClick={() => choose(c)} role="button">
              <div className={`fixMatchPoster${it.kind === 'album' ? ' square' : ''}`}>
                <Cover className="img" src={c.poster} maxAngle={4} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="fixMatchTitle">
                  {c.title} {c.year ? <span className="dim">({c.year})</span> : null}
                  {current && <span className="badge sm green" style={{ marginLeft: 8 }}>current</span>}
                </div>
                <div className="small dim">
                  {[c.artist, c.type, c.originalTitle && c.originalTitle !== c.title ? c.originalTitle : '', c.source === 'musicbrainz' ? 'MusicBrainz' : c.source === 'sonarr' ? 'TheTVDB' : 'TMDb'].filter(Boolean).join(' · ')}
                </div>
                {c.overview && <div className="small fixMatchOverview">{c.overview}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
