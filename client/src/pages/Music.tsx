import { memo, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { Album, Artist, Track } from '@shared/types';
import { api, fmtBytes, type MediaMetadata } from '../api';
import { useApp } from '../App';
import { Page, ToolbarButton, ToolbarMenu, ToolbarSeparator, ToolbarText, type MenuItemDef } from '../components/Layout';
import { Icon } from '../components/Icons';
import { LoadingIndicator, QualityLabel, musicFileLabel } from '../components/Labels';
import { Cover, PosterSkeleton } from '../components/Cover';
import { DetailHeader } from '../components/DetailHeader';
import { Modal } from '../components/Modal';
import { TranscodeModal, type TranscodeItem } from '../components/TranscodeModal';

type Sort = 'name' | 'size' | 'albums';
type Filter = 'all' | 'files' | 'missing';

const fmtDuration = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const ArtistCard = memo(function ArtistCard({ a, onOpen }: { a: Artist; onOpen: (id: number) => void }) {
  const pct = a.statistics.trackCount ? Math.round((a.statistics.trackFileCount / a.statistics.trackCount) * 100) : 0;
  return (
    <div className="poster square" onClick={() => onOpen(a.id)}>
      <Cover className="img" src={a.poster}>
        {a.name}
      </Cover>
      <div className="progressBar" title={`${a.statistics.trackFileCount} / ${a.statistics.trackCount} tracks`}>
        <div className={pct >= 100 ? 'complete' : ''} style={{ width: `${pct}%` }} />
      </div>
      <div className="meta">
        <div className="title" title={a.name}>
          {a.name}
        </div>
        <div className="sub">
          <span>
            {a.statistics.albumCount} album{a.statistics.albumCount === 1 ? '' : 's'}
          </span>
          <span>{fmtBytes(a.statistics.sizeOnDisk)}</span>
        </div>
      </div>
    </div>
  );
});

/** Artists (Lidarr). */
export function MusicPage() {
  const { settings } = useApp();
  const nav = useNavigate();
  const [artists, setArtists] = useState<Artist[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [importing, setImporting] = useState(false);
  const dq = useDeferredValue(q);
  const [sort, setSort] = useState<Sort>('name');
  const [filter, setFilter] = useState<Filter>('all');

  const load = () => {
    setError(null);
    api.artists().then(setArtists).catch((e) => setError(e.message));
  };
  useEffect(() => {
    if (settings?.lidarr.enabled) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.lidarr.enabled]);

  const list = useMemo(() => {
    const words = dq.toLowerCase().split(/\s+/).filter(Boolean);
    return (artists ?? [])
      .filter((a) => (filter === 'files' ? a.statistics.trackFileCount > 0 : filter === 'missing' ? a.statistics.trackFileCount < a.statistics.trackCount : true))
      .filter((a) => words.every((w) => `${a.name} ${a.genres.join(' ')}`.toLowerCase().includes(w)))
      .sort((a, b) => (sort === 'size' ? b.statistics.sizeOnDisk - a.statistics.sizeOnDisk : sort === 'albums' ? b.statistics.albumCount - a.statistics.albumCount : (a.sortName ?? a.name).localeCompare(b.sortName ?? b.name)));
  }, [artists, dq, sort, filter]);

  const sortItems: MenuItemDef[] = (
    [
      ['name', 'Name'],
      ['albums', 'Albums'],
      ['size', 'Size on disk'],
    ] as [Sort, string][]
  ).map(([k, label]) => ({ key: k, label, selected: sort === k, onSelect: () => setSort(k) }));
  const filterItems: MenuItemDef[] = (
    [
      ['all', 'All'],
      ['files', 'Has files'],
      ['missing', 'Missing tracks'],
    ] as [Filter, string][]
  ).map(([k, label]) => ({ key: k, label, selected: filter === k, onSelect: () => setFilter(k) }));

  return (
    <Page
      title="Music"
      toolbarLeft={
        <>
          <ToolbarButton icon={<Icon.Refresh />} label="Refresh" onClick={load} />
          <ToolbarButton icon={<Icon.Search />} label="Search Album" wide to="/search?scope=music" />
          <ToolbarButton icon={<Icon.Folder />} label="Import Folder" wide onClick={() => setImporting(true)} disabled={!settings?.lidarr.enabled} />
          <ToolbarSeparator />
          <input type="search" className="toolbarFilter" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />
          {artists && <ToolbarText>{list.length} artists</ToolbarText>}
        </>
      }
      toolbarRight={
        <>
          <ToolbarMenu icon={<Icon.Sort />} label="Sort" items={sortItems} />
          <ToolbarMenu icon={<Icon.Filter />} label="Filter" items={filterItems} selected={filter !== 'all'} />
        </>
      }
    >
      {!settings?.lidarr.enabled && (
        <div className="info">
          Connect <strong>Lidarr</strong> in <Link to="/settings">Settings → Connections</Link> to browse artists and albums, search releases (and Soulseek), and encode music with fre:ac.
        </div>
      )}
      {error && <div className="error">{error}</div>}
      {settings?.lidarr.enabled && !artists && !error && <PosterSkeleton />}
      {artists && list.length === 0 && <div className="empty">No artists match.</div>}
      {importing && <ImportFolderModal onClose={() => setImporting(false)} />}
      <div className="poster-grid square" style={{ ['--posterWidth' as string]: '170px' }}>
        {list.map((a) => (
          <ArtistCard key={a.id} a={a} onOpen={(id) => nav(`/music/artist/${id}`)} />
        ))}
      </div>
    </Page>
  );
}

/** Import a download folder into Lidarr; album images with a cue sheet are split into tracks first. */
function ImportFolderModal({ onClose }: { onClose: () => void }) {
  const { toast } = useApp();
  const [p, setP] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await api.importMusicFolder(p.trim());
      toast('info', r.images ? `${r.message}${r.encodings?.some((e) => e !== 'utf-8') ? ` (cue sheet: ${r.encodings.join(', ')})` : ''}` : r.message);
      onClose();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Import Folder"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !p.trim()} onClick={go}>
            {busy ? <span className="spinner" /> : <Icon.Folder />} Import
          </button>
        </>
      }
    >
      <div className="field stack">
        <label>Folder</label>
        <input autoFocus value={p} onChange={(e) => setP(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && p.trim() && go()} placeholder="/Volumes/Downloads/Artist - Album (FLAC+CUE)" className="mono" />
        <div className="help">
          The folder as rexarr sees it (path mappings translate it for Lidarr). Albums that are one audio file with a <span className="mono">.cue</span> sheet are split into tagged FLAC tracks with fre:ac first, in <span className="mono">rexarr-split/</span> inside the folder; Lidarr moves the tracks into your library. Use this for downloads that already left Lidarr's queue – new downloads are split automatically.
        </div>
      </div>
    </Modal>
  );
}

function MetadataModal({ path, onClose }: { path: string; onClose: () => void }) {
  const [meta, setMeta] = useState<MediaMetadata | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.mediaMetadata(path).then(setMeta).catch((e) => setError(e.message));
  }, [path]);
  const audio = meta?.streams?.find((s) => s.codec_type === 'audio');
  const tags = { ...(audio?.tags ?? {}), ...(meta?.format?.tags ?? {}) };
  return (
    <Modal title={path.split('/').pop()} onClose={onClose} wide>
      {error && <div className="error">{error}</div>}
      {!meta && !error && <LoadingIndicator />}
      {meta && (
        <>
          <div className="metaGrid">
            <div>
              <div className="dim small">Format</div>
              {meta.format?.format_long_name ?? meta.format?.format_name}
            </div>
            {audio && (
              <div>
                <div className="dim small">Audio</div>
                {audio.codec_long_name ?? audio.codec_name} · {audio.bits_per_raw_sample && audio.bits_per_raw_sample !== '0' ? `${audio.bits_per_raw_sample} bit · ` : ''}
                {audio.sample_rate ? `${Number(audio.sample_rate) / 1000} kHz · ` : ''}
                {audio.channel_layout ?? `${audio.channels} ch`}
              </div>
            )}
            <div>
              <div className="dim small">Duration</div>
              {meta.format?.duration ? fmtDuration(Number(meta.format.duration) * 1000) : '—'}
            </div>
            <div>
              <div className="dim small">Bitrate / size</div>
              {meta.format?.bit_rate ? `${Math.round(Number(meta.format.bit_rate) / 1000)} kbps` : '—'} · {fmtBytes(Number(meta.format?.size ?? 0))}
            </div>
            <div>
              <div className="dim small">MQA</div>
              {meta.mqa ? (meta.mqa.detected ? <span className="badge purple">MQA{meta.mqa.originalSampleRate ? ` · ${meta.mqa.originalSampleRate / 1000} kHz` : ''}</span> : 'Not MQA') : 'Not scanned'}
            </div>
            <div>
              <div className="dim small">Artwork</div>
              {meta.streams?.some((s) => s.disposition?.attached_pic) ? 'Embedded' : 'None'}
            </div>
          </div>
          <table className="tbl metaTags">
            <thead>
              <tr>
                <th>Tag</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(tags)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, v]) => (
                  <tr key={k}>
                    <td className="dim nowrap">{k}</td>
                    <td className="mono small">{v}</td>
                  </tr>
                ))}
              {Object.keys(tags).length === 0 && (
                <tr>
                  <td colSpan={2} className="dim">
                    No tags
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}
    </Modal>
  );
}

function AlbumRow({ album, artist, open, onToggle, onTranscode }: { album: Album; artist: Artist; open: boolean; onToggle: () => void; onTranscode: (items: TranscodeItem[]) => void }) {
  const { toast, jobs } = useApp();
  const [tracks, setTracks] = useState<Track[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [meta, setMeta] = useState<string | null>(null);
  const load = () => api.album(album.id).then((r) => setTracks(r.tracks)).catch((e) => toast('error', e.message));
  useEffect(() => {
    if (open && !tracks) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const files = (tracks ?? []).filter((t) => t.file);
  const mqaCount = files.filter((t) => t.file?.mqa?.detected).length;
  const pct = album.statistics.trackCount ? Math.round((album.statistics.trackFileCount / album.statistics.trackCount) * 100) : 0;
  const queued = new Set(jobs.filter((j) => !['done', 'failed', 'cancelled'].includes(j.status)).map((j) => j.source.localPath));
  const scan = async () => {
    setScanning(true);
    try {
      const r = await api.scanMqa({ albumId: album.id });
      const found = Object.values(r).filter((x) => 'detected' in x && x.detected).length;
      const errors = Object.values(r).filter((x) => 'error' in x).length;
      toast(found ? 'info' : 'info', `${found ? `MQA in ${found} of ${Object.keys(r).length} tracks` : 'No MQA found'}${errors ? ` · ${errors} file(s) could not be read` : ''}`);
      await load();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setScanning(false);
    }
  };
  const transcodeItems = (list: Track[]): TranscodeItem[] =>
    list
      .filter((t) => t.file)
      .map((t) => ({
        title: `${artist.name} – ${album.title}`,
        subtitle: `${t.trackNumber}. ${t.title}`,
        poster: album.cover,
        size: t.file!.size,
        quality: musicFileLabel(t.file!),
        source: { kind: 'track', arr: 'lidarr', arrId: artist.id, albumId: album.id, trackIds: [t.id], fileId: t.file!.id, arrPath: t.file!.path, localPath: t.file!.localPath },
      }));

  return (
    <div className="card albumCard">
      <div className="albumHeader" onClick={onToggle}>
        <div className="albumCover">
          <Cover className="img" src={album.cover} maxAngle={6}>
            {album.title}
          </Cover>
        </div>
        <div className="albumInfo">
          <div className="albumTitle">
            {album.title}
            {album.year ? <span className="dim"> ({album.year})</span> : null}
          </div>
          <div className="albumLabels">
            <span className="badge">{album.albumType}</span>
            {album.secondaryTypes?.map((t) => (
              <span key={t} className="badge outline">
                {t}
              </span>
            ))}
            <span className={`badge ${pct >= 100 ? 'green' : album.statistics.trackFileCount ? 'primaryLabel' : 'red'}`}>
              {album.statistics.trackFileCount} / {album.statistics.trackCount}
            </span>
            {album.statistics.sizeOnDisk > 0 && <span className="badge">{fmtBytes(album.statistics.sizeOnDisk)}</span>}
            {mqaCount > 0 && <span className="badge purple">MQA</span>}
          </div>
        </div>
        <div className="albumActions" onClick={(e) => e.stopPropagation()}>
          <Link className="iconButton" to={`/search?kind=album&id=${album.id}`} title="Interactive search (Lidarr + Soulseek)">
            <Icon.Search />
          </Link>
          <button className="iconButton" title="Encode album" disabled={!album.statistics.trackFileCount} onClick={async () => onTranscode(transcodeItems(tracks ?? (await api.album(album.id)).tracks))}>
            <Icon.Play />
          </button>
          <button className="iconButton" onClick={onToggle} title={open ? 'Collapse' : 'Show tracks'}>
            {open ? <Icon.ChevronDown /> : <Icon.ChevronRight />}
          </button>
        </div>
      </div>
      {open && (
        <div className="albumTracks">
          {!tracks && <LoadingIndicator />}
          {tracks && (
            <>
              <div className="albumToolbar">
                <button className="btn sm" onClick={scan} disabled={scanning || !files.length} title="Check lossless stereo files for an MQA stream">
                  {scanning ? <span className="spinner" /> : <Icon.Eye />} Scan for MQA
                </button>
                <span className="small dim">{files.length ? `${files.length} file(s) · ${[...new Set(files.map((t) => musicFileLabel(t.file!)))].join(', ')}` : 'No files yet'}</span>
              </div>
              <table className="tbl trackTbl">
                <thead>
                  <tr>
                    <th className="num">#</th>
                    <th>Title</th>
                    <th className="num">Duration</th>
                    <th>Quality</th>
                    <th className="num">Size</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {tracks.map((t) => (
                    <tr key={t.id}>
                      <td className="num dim">{album.mediumCount && album.mediumCount > 1 ? `${t.mediumNumber}-` : ''}{t.trackNumber}</td>
                      <td>
                        {t.title}
                        {t.explicit && <span className="badge sm outline">E</span>}
                      </td>
                      <td className="num dim nowrap">{fmtDuration(t.durationMs)}</td>
                      <td className="nowrap">
                        {t.file ? <QualityLabel quality={musicFileLabel(t.file)} size="sm" /> : <span className="badge sm red">Missing</span>}
                        {t.file?.mqa?.detected && (
                          <span className="badge sm purple" title={t.file.mqa.originalSampleRate ? `Original ${t.file.mqa.originalSampleRate / 1000} kHz` : 'MQA stream'}>
                            MQA
                          </span>
                        )}
                      </td>
                      <td className="num dim nowrap">{t.file ? fmtBytes(t.file.size) : ''}</td>
                      <td className="iconCell nowrap">
                        {t.file && (
                          <>
                            <button className="iconButton" title="Tags and file details" onClick={() => setMeta(t.file!.localPath)}>
                              <Icon.Eye />
                            </button>
                            <button className="iconButton" title={queued.has(t.file.localPath) ? 'Already in the queue' : 'Encode'} disabled={queued.has(t.file.localPath)} onClick={() => onTranscode(transcodeItems([t]))}>
                              <Icon.Play />
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}
      {meta && <MetadataModal path={meta} onClose={() => setMeta(null)} />}
    </div>
  );
}

/** One artist: header + albums with tracks. */
export function ArtistPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const [data, setData] = useState<{ artist: Artist; albums: Album[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<number>>(() => new Set(params.get('album') ? [Number(params.get('album'))] : []));
  const [modal, setModal] = useState<TranscodeItem[] | null>(null);
  const [type, setType] = useState<string>('all');
  useEffect(() => {
    setData(null);
    api.artist(Number(id)).then(setData).catch((e) => setError(e.message));
  }, [id]);
  if (error) return <Page title="Artist"><div className="error">{error}</div></Page>;
  if (!data) return <Page title="Artist"><LoadingIndicator /></Page>;
  const { artist, albums } = data;
  const types = [...new Set(albums.map((a) => a.albumType))];
  const shown = albums.filter((a) => type === 'all' || a.albumType === type);
  const typeItems: MenuItemDef[] = [{ key: 'all', label: 'All', selected: type === 'all', onSelect: () => setType('all') }, ...types.map((t) => ({ key: t, label: t, selected: type === t, onSelect: () => setType(t) }))];
  return (
    <Page
      title={artist.name}
      flush
      toolbarLeft={
        <>
          <ToolbarButton icon={<Icon.ArrowLeftCircle />} label="Artists" to="/music" />
          <ToolbarSeparator />
          <ToolbarButton icon={<Icon.ChevronDown />} label="Expand All" wide onClick={() => setOpen(new Set(shown.map((a) => a.id)))} />
          <ToolbarButton icon={<Icon.ChevronRight />} label="Collapse All" wide onClick={() => setOpen(new Set())} />
        </>
      }
      toolbarRight={<ToolbarMenu icon={<Icon.Filter />} label="Type" items={typeItems} selected={type !== 'all'} />}
    >
      <DetailHeader
        backdrop={artist.fanart}
        poster={artist.poster}
        square
        title={artist.name}
        rating={artist.rating}
        genres={artist.genres.slice(0, 4)}
        monitored={artist.monitored}
        overview={artist.overview}
        attribution="Metadata is provided by MusicBrainz via Lidarr"
        pills={[
          { icon: <Icon.Folder />, text: artist.path },
          { icon: <Icon.HardDrive />, text: fmtBytes(artist.statistics.sizeOnDisk) },
          { icon: <Icon.Disc />, text: `${artist.statistics.trackFileCount} / ${artist.statistics.trackCount} tracks` },
          ...(artist.status ? [{ icon: <Icon.Bookmark />, text: artist.status === 'ended' ? 'Inactive' : 'Continuing' }] : []),
          { icon: <Icon.ExternalLink />, text: 'MusicBrainz', href: `https://musicbrainz.org/artist/${artist.foreignArtistId}` },
        ]}
      />
      <div className="innerContentBody">
        {shown.map((a) => (
          <AlbumRow
            key={a.id}
            album={a}
            artist={artist}
            open={open.has(a.id)}
            onToggle={() =>
              setOpen((s) => {
                const n = new Set(s);
                if (n.has(a.id)) n.delete(a.id);
                else n.add(a.id);
                return n;
              })
            }
            onTranscode={setModal}
          />
        ))}
        {shown.length === 0 && <div className="empty">No albums.</div>}
      </div>
      {modal && <TranscodeModal items={modal} mediaType="music" onClose={() => setModal(null)} />}
    </Page>
  );
}
