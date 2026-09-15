import { memo, useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Movie } from '@shared/types';
import { api, fmtBytes } from '../api';
import { useApp } from '../App';
import { Page, ToolbarButton, ToolbarMenu, ToolbarSeparator, ToolbarText } from '../components/Layout';
import { Icon } from '../components/Icons';
import { LoadingIndicator, QualityLabel } from '../components/Labels';
import { TranscodeModal, type TranscodeItem } from '../components/TranscodeModal';
import { Cover, PosterSkeleton, cover3dEnabled, setCover3dEnabled } from '../components/Cover';

type Filter = 'all' | 'remux' | 'files' | 'missing' | 'anime';
type PosterSize = 'small' | 'medium' | 'large';
const POSTER_WIDTH: Record<PosterSize, number> = { small: 130, medium: 170, large: 220 };
type Sort = 'title' | 'romaji' | 'year' | 'size' | 'quality';
const FILTER_LABEL: Record<Filter, string> = { remux: 'Remux only', files: 'Has file', missing: 'Missing', anime: 'Anime (AniDB)', all: 'All' };
const SORT_LABEL: Record<Sort, string> = { title: 'Title', romaji: 'Romaji title (AniDB)', year: 'Year', size: 'Size on disk', quality: 'Quality' };

/** One poster card; memoised so live job updates do not re-render the whole grid. */
const MovieCard = memo(function MovieCard({ m, selected, busy, onOpen, onToggle, onTranscode }: { m: Movie; selected: boolean; busy: boolean; onOpen: (id: number) => void; onToggle: (id: number) => void; onTranscode: (m: Movie) => void }) {
  return (
    <div className={`poster${selected ? ' selected' : ''}`} onClick={() => onOpen(m.id)}>
      {m.file?.isRemux && <span className="corner" title="Blu-ray remux on disk" />}
      {busy && <span className="badge blue sm flag">In queue</span>}
      {m.file && (
        <div className="posterControls" onClick={(e) => e.stopPropagation()}>
          <label className="check" title="Select">
            <input type="checkbox" checked={selected} onChange={() => onToggle(m.id)} />
          </label>
          <button className="iconButton" style={{ color: 'var(--white)' }} title={busy ? 'Already in the queue' : 'Transcode'} disabled={busy} onClick={() => onTranscode(m)}>
            <Icon.Play />
          </button>
        </div>
      )}
      <Cover className="img" src={m.poster}>
        {m.title}
      </Cover>
      <div className="meta">
        <div className="title" title={m.title}>
          {m.title}
        </div>
        <div className="sub">
          <span>{m.year}</span>
          {m.file ? <QualityLabel quality={m.file.quality} isRemux={m.file.isRemux} size="sm" /> : <span className="badge sm red">Missing</span>}
        </div>
      </div>
    </div>
  );
});

function pref<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(key) as T) || fallback;
  } catch {
    return fallback;
  }
}

export function MoviesPage() {
  const { settings, jobs, toast } = useApp();
  const [movies, setMovies] = useState<Movie[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const dq = useDeferredValue(q);
  const [filter, setFilter] = useState<Filter>(() => pref('rexarr.movies.filter', 'remux'));
  const [sort, setSort] = useState<Sort>(() => pref('rexarr.movies.sort', 'title'));
  const [view, setView] = useState<'posters' | 'table'>(() => pref('rexarr.movies.view', 'posters'));
  const [posterSize, setPosterSize] = useState<PosterSize>(() => pref('rexarr.posterSize', 'medium'));
  const [cover3d, setCover3d] = useState(cover3dEnabled);
  const nav = useNavigate();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [modal, setModal] = useState<TranscodeItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => localStorage.setItem('rexarr.movies.filter', filter), [filter]);
  useEffect(() => localStorage.setItem('rexarr.movies.sort', sort), [sort]);
  useEffect(() => localStorage.setItem('rexarr.movies.view', view), [view]);
  useEffect(() => localStorage.setItem('rexarr.posterSize', posterSize), [posterSize]);

  const load = () => {
    setError(null);
    setBusy(true);
    api.movies()
      .then(setMovies)
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };
  useEffect(load, []);

  const busyMovieIds = useMemo(() => new Set(jobs.filter((j) => j.source.arr === 'radarr' && !['done', 'failed', 'cancelled'].includes(j.status)).map((j) => j.source.arrId)), [jobs]);

  const list = useMemo(() => {
    if (!movies) return [];
    const needle = dq.trim().toLowerCase();
    const filtered = movies.filter((m) => {
      if (needle && !m.title.toLowerCase().includes(needle) && !String(m.year).includes(needle)) return false;
      if (filter === 'remux') return m.file?.isRemux;
      if (filter === 'files') return m.hasFile;
      if (filter === 'missing') return !m.hasFile;
      if (filter === 'anime') return m.anime;
      return true;
    });
    const byTitle = (a: Movie, b: Movie) => a.title.localeCompare(b.title);
    const romaji = (m: Movie) => m.titleRomaji ?? m.title;
    return [...filtered].sort(
      sort === 'romaji' ? (a, b) => Number(Boolean(b.anime)) - Number(Boolean(a.anime)) || romaji(a).localeCompare(romaji(b)) : sort === 'year' ? (a, b) => b.year - a.year || byTitle(a, b) : sort === 'size' ? (a, b) => (b.file?.size ?? 0) - (a.file?.size ?? 0) || byTitle(a, b) : sort === 'quality' ? (a, b) => Number(b.file?.isRemux ?? false) - Number(a.file?.isRemux ?? false) || (b.file?.quality ?? '').localeCompare(a.file?.quality ?? '') || byTitle(a, b) : byTitle,
    );
  }, [movies, dq, filter, sort]);

  const toItem = (m: Movie): TranscodeItem => ({
    title: `${m.title} (${m.year})`,
    poster: m.poster,
    size: m.file?.size,
    quality: m.file?.quality,
    isRemux: m.file?.isRemux,
    anime: m.anime,
    source: { kind: 'movie', arr: 'radarr', arrId: m.id, fileId: m.file?.id, arrPath: m.file?.path, localPath: m.file?.localPath },
  });

  const toggle = useCallback(
    (id: number) =>
      setSelected((s) => {
      const n = new Set(s);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        return n;
      }),
    [],
  );

  const remuxCount = movies?.filter((m) => m.file?.isRemux).length ?? 0;
  const openMovie = useCallback((id: number) => nav(`/movies/${id}`), [nav]);
  const transcodeOne = useCallback((m: Movie) => setModal([toItem(m)]), []);

  if (settings && !settings.radarr.enabled) {
    return (
      <Page title="Movies">
        <div className="empty">
          <h3>Radarr is not connected</h3>
          <p>
            Add your Radarr URL and API key in <Link to="/settings">Settings</Link> to browse your movie library.
          </p>
        </div>
      </Page>
    );
  }

  return (
    <Page
      title="Movies"
      toolbarLeft={
        <>
          <ToolbarButton icon={<Icon.Refresh />} label="Refresh" onClick={load} busy={busy} />
          <ToolbarSeparator />
          <ToolbarButton icon={<Icon.CheckSquare />} label="Select all" onClick={() => setSelected(new Set(list.filter((m) => m.file).map((m) => m.id)))} disabled={!list.length} />
          <ToolbarButton icon={<Icon.Square />} label="Clear" onClick={() => setSelected(new Set())} disabled={!selected.size} />
          <ToolbarButton icon={<Icon.Play />} label={selected.size ? `Transcode ${selected.size}` : 'Transcode'} wide selected={selected.size > 0} disabled={!selected.size} onClick={() => setModal(list.filter((m) => selected.has(m.id) && m.file).map(toItem))} />
          {movies && (
            <ToolbarText>
              {movies.length} movies · {remuxCount} remux
            </ToolbarText>
          )}
        </>
      }
      toolbarRight={
        <>
          <ToolbarText>
            <input type="search" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 180, height: 30, padding: '4px 10px' }} />
          </ToolbarText>
          <ToolbarButton icon={<Icon.Grid />} label="Posters" selected={view === 'posters'} onClick={() => setView('posters')} />
          <ToolbarButton icon={<Icon.List />} label="Table" selected={view === 'table'} onClick={() => setView('table')} />
          <ToolbarSeparator />
          {view === 'posters' && (
            <ToolbarMenu
              icon={<Icon.Sliders />}
              label="Options"
              items={[
                { key: 'h', header: true, label: 'Poster size' },
                ...(['small', 'medium', 'large'] as PosterSize[]).map((k) => ({ key: k, label: `${k[0].toUpperCase()}${k.slice(1)}`, selected: posterSize === k, onSelect: () => setPosterSize(k) })),
                { key: 's', separator: true, label: '' },
                { key: '3d', label: '3D cover effect', selected: cover3d, onSelect: () => { setCover3dEnabled(!cover3d); setCover3d(!cover3d); } },
              ]}
            />
          )}
          <ToolbarMenu icon={<Icon.Sort />} label="Sort" items={(Object.keys(SORT_LABEL) as Sort[]).map((k) => ({ key: k, label: SORT_LABEL[k], selected: sort === k, onSelect: () => setSort(k) }))} />
          <ToolbarMenu icon={<Icon.Filter />} label="Filter" selected={filter !== 'all'} items={(Object.keys(FILTER_LABEL) as Filter[]).map((k) => ({ key: k, label: FILTER_LABEL[k], selected: filter === k, onSelect: () => setFilter(k) }))} />
        </>
      }
    >
      {error && (
        <div className="error">
          {error}. Check the Radarr connection in <Link to="/settings">Settings</Link>.
        </div>
      )}
      {!movies && !error && (view === 'posters' ? <PosterSkeleton /> : <LoadingIndicator>Loading library…</LoadingIndicator>)}
      {movies && list.length === 0 && (
        <div className="empty">
          <h3>Nothing here</h3>
          <p>{filter === 'remux' ? 'No movies have a Blu-ray remux file yet. Use Search to grab one.' : 'No movies match this filter.'}</p>
        </div>
      )}

      {view === 'posters' && (
        <div className="poster-grid" style={{ ['--posterWidth' as string]: `${POSTER_WIDTH[posterSize]}px` }}>
          {list.map((m) => (
            <MovieCard key={m.id} m={m} selected={selected.has(m.id)} busy={busyMovieIds.has(m.id)} onOpen={openMovie} onToggle={toggle} onTranscode={transcodeOne} />
          ))}
        </div>
      )}

      {view === 'table' && (
        <div className="card tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 30 }} />
                <th className={`sortable${sort === 'title' ? ' active' : ''}`} onClick={() => setSort('title')}>Title</th>
                <th className={`sortable${sort === 'year' ? ' active' : ''}`} onClick={() => setSort('year')}>Year</th>
                <th className={`sortable${sort === 'quality' ? ' active' : ''}`} onClick={() => setSort('quality')}>Quality</th>
                <th>Video</th>
                <th>Audio</th>
                <th className={`num sortable${sort === 'size' ? ' active' : ''}`} onClick={() => setSort('size')}>Size</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((m) => (
                <tr key={m.id}>
                  <td>{m.file && <input type="checkbox" checked={selected.has(m.id)} onChange={() => toggle(m.id)} />}</td>
                  <td>
                    <div><Link to={`/movies/${m.id}`}>{m.title}</Link></div>
                    <div className="small muted truncate" style={{ maxWidth: 480 }} title={m.file?.path}>
                      {m.file?.path ?? m.path}
                    </div>
                  </td>
                  <td className="dim">{m.year}</td>
                  <td>{m.file ? <QualityLabel quality={m.file.quality} isRemux={m.file.isRemux} /> : <span className="badge red">Missing</span>}</td>
                  <td className="dim">
                    {m.file?.videoCodec ?? '—'}
                    {m.file?.resolution ? ` · ${m.file.resolution}` : ''}
                  </td>
                  <td className="dim">
                    {m.file?.audioCodec ?? '—'}
                    {m.file?.audioChannels ? ` ${m.file.audioChannels}ch` : ''}
                  </td>
                  <td className="num dim">{fmtBytes(m.file?.size)}</td>
                  <td className="num">
                    {m.file && (
                      <button className="iconButton" onClick={() => setModal([toItem(m)])} disabled={busyMovieIds.has(m.id)} title={busyMovieIds.has(m.id) ? 'Already queued' : 'Transcode'}>
                        <Icon.Play />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal && <TranscodeModal items={modal} mediaType={modal.length && modal.every((i) => i.anime) ? 'anime' : 'movie'} onClose={() => setModal(null)} onQueued={() => setSelected(new Set())} />}
    </Page>
  );
}
