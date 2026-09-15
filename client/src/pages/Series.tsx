import { memo, useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Episode, Series } from '@shared/types';
import { api, fmtBytes } from '../api';
import { useApp } from '../App';
import { Page, ToolbarButton, ToolbarMenu, ToolbarSeparator, ToolbarText } from '../components/Layout';
import { Icon } from '../components/Icons';
import { LoadingIndicator, QualityLabel } from '../components/Labels';
import { DetailHeader } from '../components/DetailHeader';
import { TranscodeModal, type TranscodeItem } from '../components/TranscodeModal';
import { Cover, PosterSkeleton, cover3dEnabled, setCover3dEnabled } from '../components/Cover';

type SortKey = 'title' | 'romaji' | 'remux' | 'remuxPct' | 'year' | 'size';
type TypeFilter = 'all' | 'anime' | 'standard';
type PosterSize = 'small' | 'medium' | 'large';
const POSTER_WIDTH: Record<PosterSize, number> = { small: 130, medium: 170, large: 220 };
const SORT_LABEL: Record<SortKey, string> = { title: 'Title', romaji: 'Romaji title (AniDB)', remux: 'Remux count', remuxPct: 'Remux %', year: 'Year', size: 'Size on disk' };
const byTitle = (a: Series, b: Series) => a.title.localeCompare(b.title);
const romaji = (s: Series) => s.titleRomaji ?? s.title;
const SORTERS: Record<SortKey, (a: Series, b: Series) => number> = {
  title: byTitle,
  romaji: (a, b) => Number(Boolean(b.anidbIds?.length)) - Number(Boolean(a.anidbIds?.length)) || romaji(a).localeCompare(romaji(b)),
  remux: (a, b) => b.statistics.remuxFileCount - a.statistics.remuxFileCount || byTitle(a, b),
  remuxPct: (a, b) => pct(b) - pct(a) || b.statistics.remuxFileCount - a.statistics.remuxFileCount || byTitle(a, b),
  year: (a, b) => b.year - a.year || byTitle(a, b),
  size: (a, b) => b.statistics.sizeOnDisk - a.statistics.sizeOnDisk || byTitle(a, b),
};
function pct(s: Series) {
  return s.statistics.episodeFileCount ? s.statistics.remuxFileCount / s.statistics.episodeFileCount : 0;
}
const SeriesCard = memo(function SeriesCard({ s, onOpen }: { s: Series; onOpen: (id: number) => void }) {
  const complete = s.statistics.episodeCount > 0 && s.statistics.episodeFileCount >= s.statistics.episodeCount;
  return (
    <div className="poster" onClick={() => onOpen(s.id)}>
      {s.statistics.remuxFileCount > 0 && <span className="corner" title={`${s.statistics.remuxFileCount} remux episode(s)`} />}
      <Cover className="img" src={s.poster}>
        {s.title}
      </Cover>
      <div className="meta">
        <div className="title" title={s.title}>
          {s.title}
        </div>
        <div className="sub">
          <span>{s.year}</span>
          {s.statistics.remuxFileCount > 0 && <span className="badge remux sm">{s.statistics.remuxFileCount} remux</span>}
        </div>
        <div className={`progress md ${complete ? 'green' : ''}`} title="Episodes on disk">
          <div style={{ width: `${s.statistics.episodeCount ? (s.statistics.episodeFileCount / s.statistics.episodeCount) * 100 : 0}%` }} />
          <span className="text">
            {s.statistics.episodeFileCount} / {s.statistics.episodeCount}
          </span>
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

function SeriesList() {
  const { settings } = useApp();
  const [series, setSeries] = useState<Series[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const dq = useDeferredValue(q);
  const [type, setType] = useState<TypeFilter>(() => pref('rexarr.series.type', 'all'));
  const [sort, setSort] = useState<SortKey>(() => pref('rexarr.seriesSort', 'title'));
  const [remuxOnly, setRemuxOnly] = useState(() => localStorage.getItem('rexarr.seriesRemuxOnly') === '1');
  const [posterSize, setPosterSize] = useState<PosterSize>(() => pref('rexarr.posterSize', 'medium'));
  const [cover3d, setCover3d] = useState(cover3dEnabled);
  useEffect(() => localStorage.setItem('rexarr.posterSize', posterSize), [posterSize]);
  const nav = useNavigate();
  useEffect(() => localStorage.setItem('rexarr.seriesSort', sort), [sort]);
  useEffect(() => localStorage.setItem('rexarr.seriesRemuxOnly', remuxOnly ? '1' : '0'), [remuxOnly]);
  useEffect(() => localStorage.setItem('rexarr.series.type', type), [type]);

  const load = () => {
    setError(null);
    setBusy(true);
    api.series()
      .then(setSeries)
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };
  useEffect(load, []);

  const list = useMemo(() => {
    if (!series) return [];
    const needle = dq.trim().toLowerCase();
    const isAnime = (s: Series) => s.seriesType === 'anime' || Boolean(s.anidbIds?.length);
    const filtered = series.filter((s) => (!needle || s.title.toLowerCase().includes(needle) || (s.titleRomaji ?? '').toLowerCase().includes(needle)) && (type === 'all' || (type === 'anime' ? isAnime(s) : !isAnime(s))) && (!remuxOnly || s.statistics.remuxFileCount > 0));
    return [...filtered].sort(SORTERS[sort]);
  }, [series, dq, type, sort, remuxOnly]);
  const remuxSeries = series?.filter((s) => s.statistics.remuxFileCount > 0).length ?? 0;
  const openSeries = useCallback((id: number) => nav(`/series/${id}`), [nav]);

  if (settings && !settings.sonarr.enabled) {
    return (
      <Page title="Series">
        <div className="empty">
          <h3>Sonarr is not connected</h3>
          <p>
            Add your Sonarr URL and API key in <Link to="/settings">Settings</Link> to browse your series.
          </p>
        </div>
      </Page>
    );
  }

  return (
    <Page
      title="Series"
      toolbarLeft={
        <>
          <ToolbarButton icon={<Icon.Refresh />} label="Refresh" onClick={load} busy={busy} />
          {series && (
            <ToolbarText>
              {series.length} series · {remuxSeries} with remux
            </ToolbarText>
          )}
        </>
      }
      toolbarRight={
        <>
          <ToolbarText>
            <input type="search" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 180, height: 30, padding: '4px 10px' }} />
          </ToolbarText>
          <ToolbarSeparator />
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
          <ToolbarMenu icon={<Icon.Sort />} label="Sort" items={(Object.keys(SORT_LABEL) as SortKey[]).map((k) => ({ key: k, label: SORT_LABEL[k], selected: sort === k, onSelect: () => setSort(k) }))} />
          <ToolbarMenu
            icon={<Icon.Filter />}
            label="Filter"
            selected={remuxOnly || type !== 'all'}
            items={[
              { key: 'h1', header: true, label: 'Files' },
              { key: 'remux', label: 'Has remux', selected: remuxOnly, onSelect: () => setRemuxOnly(!remuxOnly) },
              { key: 'sep', separator: true, label: '' },
              { key: 'h2', header: true, label: 'Type' },
              { key: 'all', label: 'All', selected: type === 'all', onSelect: () => setType('all') },
              { key: 'anime', label: 'Anime', selected: type === 'anime', onSelect: () => setType('anime') },
              { key: 'standard', label: 'Standard', selected: type === 'standard', onSelect: () => setType('standard') },
            ]}
          />
        </>
      }
    >
      {error && (
        <div className="error">
          {error}. Check the Sonarr connection in <Link to="/settings">Settings</Link>.
        </div>
      )}
      {!series && !error && <PosterSkeleton />}
      <div className="poster-grid" style={{ ['--posterWidth' as string]: `${POSTER_WIDTH[posterSize]}px` }}>
        {list.map((s) => (
          <SeriesCard key={s.id} s={s} onOpen={openSeries} />
        ))}
      </div>
    </Page>
  );
}

let libraryCache: Series[] | null = null;

function SeriesDetail({ id }: { id: number }) {
  const { jobs, settings } = useApp();
  const [series, setSeries] = useState<Series | null>(null);
  const [episodes, setEpisodes] = useState<Episode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [modal, setModal] = useState<TranscodeItem[] | null>(null);
  const nav = useNavigate();

  const load = () => {
    setError(null);
    setBusy(true);
    Promise.all([api.seriesById(id), api.episodes(id)])
      .then(([s, e]) => {
        setSeries(s);
        setEpisodes(e);
        const withRemux = s.seasons.filter((x) => x.remuxCount > 0).map((x) => x.seasonNumber);
        setOpen(new Set(withRemux.length ? withRemux : s.seasons.slice(-1).map((x) => x.seasonNumber)));
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };
  useEffect(load, [id]);

  const busyEpisodeIds = useMemo(() => {
    const set = new Set<number>();
    for (const j of jobs) if (j.source.arr === 'sonarr' && j.source.arrId === id && !['done', 'failed', 'cancelled'].includes(j.status)) for (const e of j.source.episodeIds ?? []) set.add(e);
    return set;
  }, [jobs, id]);

  const mediaType = series?.seriesType === 'anime' ? 'anime' : 'tv';
  const toItem = (e: Episode): TranscodeItem => ({
    title: series?.title ?? '',
    subtitle: `S${String(e.seasonNumber).padStart(2, '0')}E${String(e.episodeNumber).padStart(2, '0')} · ${e.title}`,
    poster: series?.poster,
    size: e.file?.size,
    quality: e.file?.quality,
    isRemux: e.file?.isRemux,
    source: { kind: 'episode', arr: 'sonarr', arrId: id, episodeIds: [e.id], seasonNumber: e.seasonNumber, fileId: e.file?.id, arrPath: e.file?.path, localPath: e.file?.localPath },
  });

  const toggleSeason = (n: number) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
  const toggleEp = (eid: number) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(eid)) next.delete(eid);
      else next.add(eid);
      return next;
    });

  const selectedEps = episodes?.filter((e) => selected.has(e.id) && e.file) ?? [];
  const remuxTotal = series?.statistics.remuxFileCount ?? 0;

  // Previous / next series (alphabetical) for the header arrows, like Sonarr.
  const [all, setAll] = useState<Series[] | null>(libraryCache);
  useEffect(() => {
    if (libraryCache) return;
    api.series()
      .then((l) => {
        libraryCache = l;
        setAll(l);
      })
      .catch(() => {});
  }, []);
  const neighbours = useMemo(() => {
    if (!all) return { prev: null, next: null };
    const idx = all.findIndex((s) => s.id === id);
    if (idx < 0) return { prev: null, next: null };
    const prev = all[(idx - 1 + all.length) % all.length];
    const next = all[(idx + 1) % all.length];
    return { prev: prev && prev.id !== id ? { to: `/series/${prev.id}`, title: prev.title } : null, next: next && next.id !== id ? { to: `/series/${next.id}`, title: next.title } : null };
  }, [all, id]);

  return (
    <Page
      title={series?.title ?? 'Series'}
      flush
      toolbarLeft={
        <>
          <ToolbarButton icon={<Icon.ChevronRight />} label="Back" onClick={() => nav('/series')} title="Back to series" />
          <ToolbarSeparator />
          <ToolbarButton icon={<Icon.Refresh />} label="Refresh" onClick={load} busy={busy} />
          <ToolbarButton icon={<Icon.Search />} label="Search remux" wide to={`/search?kind=series&id=${id}`} />
          <ToolbarSeparator />
          <ToolbarButton icon={<Icon.Play />} label={selectedEps.length ? `Transcode ${selectedEps.length}` : 'Transcode'} wide selected={selectedEps.length > 0} disabled={!selectedEps.length} onClick={() => setModal(selectedEps.map(toItem))} />
          <ToolbarButton icon={<Icon.Square />} label="Clear" onClick={() => setSelected(new Set())} disabled={!selected.size} />
        </>
      }
    >
      {error && (
        <div className="error" style={{ margin: 20 }}>
          {error}
        </div>
      )}
      {!series && !error && <LoadingIndicator>Loading series…</LoadingIndicator>}
      {series && (
        <DetailHeader
          backdrop={series.fanart}
          poster={series.poster}
          title={series.title}
          year={series.year}
          endYear={series.endYear}
          runtimeMinutes={series.runtime}
          rating={series.rating}
          genres={series.genres}
          monitored={series.monitored}
          overview={series.overview}
          prev={neighbours.prev}
          next={neighbours.next}
          attribution="Metadata is provided by TheTVDB"
          badges={
            <>
              {(series.seriesType === 'anime' || series.anidbIds?.length) && <span className="badge purple" title={series.titleKanji ?? ''}>Anime{series.titleRomaji && series.titleRomaji !== series.title ? ` · ${series.titleRomaji}` : ''}</span>}
              {remuxTotal > 0 && <span className="badge remux">{remuxTotal} remux</span>}
            </>
          }
          pills={[
            { icon: <Icon.Folder />, text: series.path, title: 'Path' },
            { icon: <Icon.HardDrive />, text: fmtBytes(series.statistics.sizeOnDisk), title: 'Size on disk' },
            { icon: <Icon.Film />, text: `${series.statistics.episodeFileCount} / ${series.statistics.episodeCount} episodes`, title: 'Episodes on disk' },
            ...(series.qualityProfile ? [{ icon: <Icon.User />, text: series.qualityProfile, title: 'Quality profile' }] : []),
            { icon: <Icon.Bookmark />, text: series.monitored ? 'Monitored' : 'Unmonitored', title: 'Monitoring' },
            ...(series.status ? [{ icon: <Icon.StopSquare />, text: series.status[0].toUpperCase() + series.status.slice(1), title: 'Status' }] : []),
            ...(series.originalLanguage ? [{ icon: <Icon.Language />, text: series.originalLanguage, title: 'Original language' }] : []),
            ...(series.network ? [{ icon: <Icon.Tv />, text: series.network, title: 'Network' }] : []),
            { icon: <Icon.ExternalLink />, text: 'TheTVDB', href: `https://thetvdb.com/?tab=series&id=${series.tvdbId}`, title: 'Open on TheTVDB' },
            ...(series.imdbId ? [{ icon: <Icon.ExternalLink />, text: 'IMDb', href: `https://www.imdb.com/title/${series.imdbId}/`, title: 'Open on IMDb' }] : []),
            ...(series.anidbIds?.length ? [{ icon: <Icon.ExternalLink />, text: `AniDB${series.anidbIds.length > 1 ? ` (${series.anidbIds.length})` : ''}`, href: `https://anidb.net/anime/${series.anidbIds[0]}`, title: 'Open on AniDB' }] : []),
          ]}
        />
      )}
      {series && episodes && (
        <div style={{ padding: 20 }}>
          {[...series.seasons].reverse().map((season) => {
            const eps = episodes.filter((e) => e.seasonNumber === season.seasonNumber);
            const isOpen = open.has(season.seasonNumber);
            const withFile = eps.filter((e) => e.file);
            const size = withFile.reduce((a, e) => a + (e.file?.size ?? 0), 0);
            return (
              <div key={season.seasonNumber} className="season">
                <div className="seasonHeader">
                  <div className="left">
                    <span className="seasonNumber">{season.seasonNumber === 0 ? 'Specials' : `Season ${season.seasonNumber}`}</span>
                    <span className={`badge ${season.episodeFileCount >= season.episodeCount && season.episodeCount > 0 ? 'green' : ''}`}>
                      {season.episodeFileCount} / {season.episodeCount}
                    </span>
                    {season.remuxCount > 0 && <span className="badge remux">{season.remuxCount} remux</span>}
                    {!season.monitored && <span className="badge muted">Unmonitored</span>}
                    {size > 0 && <span className="sizeOnDisk">{fmtBytes(size)}</span>}
                  </div>
                  <button className="expandButton" onClick={() => toggleSeason(season.seasonNumber)} title={isOpen ? 'Collapse' : 'Expand'}>
                    {isOpen ? <Icon.ChevronDown /> : <Icon.ChevronRight />}
                  </button>
                  <div className="actions">
                    {withFile.length > 0 && (
                      <button className="iconButton" title="Transcode all episodes in this season" onClick={() => setModal(withFile.map(toItem))}>
                        <Icon.Play />
                      </button>
                    )}
                    <Link className="iconButton" to={`/search?kind=series&id=${id}&season=${season.seasonNumber}`} title="Search remux for this season">
                      <Icon.Search />
                    </Link>
                  </div>
                </div>
                {isOpen && (
                  <div className="episodes">
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th style={{ width: 30 }} />
                          <th style={{ width: 50 }}>#</th>
                          <th>Title</th>
                          <th>Air date</th>
                          <th>Media</th>
                          <th>Quality</th>
                          <th style={{ width: 60 }} />
                        </tr>
                      </thead>
                      <tbody>
                        {eps.map((e) => (
                          <tr key={e.id}>
                            <td>{e.file && <input type="checkbox" checked={selected.has(e.id)} onChange={() => toggleEp(e.id)} />}</td>
                            <td className="dim">{e.episodeNumber}</td>
                            <td>{e.title}</td>
                            <td className="dim">{e.airDate ?? '—'}</td>
                            <td className="dim small" title={e.file?.path}>
                              {e.file ? `${e.file.videoCodec ?? ''} ${e.file.audioCodec ?? ''}${e.file.audioChannels ? ` ${e.file.audioChannels}ch` : ''} · ${fmtBytes(e.file.size)}` : ''}
                            </td>
                            <td>{e.file ? <QualityLabel quality={e.file.quality} isRemux={e.file.isRemux} /> : <span className="badge red">{e.airDate && new Date(e.airDate) > new Date() ? 'Unaired' : 'Missing'}</span>}</td>
                            <td className="num">
                              {e.file ? (
                                <button className="iconButton" disabled={busyEpisodeIds.has(e.id)} onClick={() => setModal([toItem(e)])} title={busyEpisodeIds.has(e.id) ? 'Already queued' : 'Transcode'}>
                                  <Icon.Play />
                                </button>
                              ) : (
                                <Link className="iconButton" to={`/search?kind=series&id=${id}&episode=${e.id}&season=${e.seasonNumber}`} title="Search remux">
                                  <Icon.Search />
                                </Link>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="collapseButtonContainer" onClick={() => toggleSeason(season.seasonNumber)}>
                      <span style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}><Icon.ChevronDown /></span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {modal && settings && <TranscodeModal items={modal} mediaType={mediaType} onClose={() => setModal(null)} onQueued={() => setSelected(new Set())} />}
    </Page>
  );
}

export function SeriesPage() {
  const { id } = useParams();
  return id ? <SeriesDetail id={Number(id)} /> : <SeriesList />;
}
