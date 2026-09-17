import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { Episode, LookupResult, Release, ReleaseCategory, SearchQuery, Series, SmartSearchResult } from '@shared/types';
import { api, fmtBytes, type ReleaseSearch } from '../api';
import { useApp } from '../App';
import { Page, ToolbarButton, ToolbarMenu, ToolbarSeparator, type MenuItemDef } from '../components/Layout';
import { Icon } from '../components/Icons';
import { CATEGORY_LABEL, ReleaseTable, type ReleaseSortKey } from '../components/ReleaseTable';
import { ProfileSelect } from '../components/ProfileSelect';
import { LoadingIndicator, QualityLabel } from '../components/Labels';
import { Cover } from '../components/Cover';
import { Modal } from '../components/Modal';

type Scope = 'all' | 'movie' | 'series' | 'music' | 'local' | 'indexers';
type LocalSort = 'relevance' | 'title' | 'year' | 'size' | 'files' | 'modified' | 'kind';
type LocalKind = 'all' | 'movie' | 'series' | 'album';
type LocalMatch = 'all' | 'matched' | 'unmatched' | 'remux';
const LOCAL_SORT_KEY = 'rexarr.search.localSort';
/** "best" = remux + full disc when there are any, otherwise everything – ranked by score. */
type CategoryFilter = 'best' | ReleaseCategory | 'all';

interface Target {
  kind: 'movie' | 'series' | 'album';
  /** Albums: artist id / name. */
  artistId?: number;
  artist?: string;
  arrId: number;
  title: string;
  year?: number;
  poster?: string;
  overview?: string;
  seriesType?: string;
  /** AniDB says it is anime (movies have no anime type in Radarr). */
  anime?: boolean;
  seasons?: Series['seasons'];
  library?: LookupResult['library'];
}

const SCOPE_LABEL: Record<Scope, string> = { all: 'All', movie: 'Movies', series: 'Series', music: 'Music', local: 'Local files', indexers: 'Indexers' };
const APP_FOR: Record<'movie' | 'series' | 'album', string> = { movie: 'Radarr', series: 'Sonarr', album: 'Lidarr' };
const KIND_LABEL: Record<'movie' | 'series' | 'album', string> = { movie: 'Movie', series: 'Series', album: 'Album' };
const RECENT_KEY = 'rexarr.recentSearches';

function readRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
  } catch {
    return [];
  }
}
function pushRecent(q: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([q, ...readRecent().filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 8)));
  } catch {
    /* ignore */
  }
}

/** What Rexarr understood from the search text, as Sonarr labels. */
function Understood({ q }: { q: SearchQuery }) {
  const labels: string[] = [];
  if (q.kind) labels.push(q.kind === 'movie' ? 'Movie' : 'Series');
  if (q.anime) labels.push('Anime');
  if (q.year) labels.push(String(q.year));
  if (q.season !== undefined) labels.push(`Season ${q.season}`);
  if (q.episode !== undefined) labels.push(`Episode ${q.episode}`);
  if (q.absoluteEpisode !== undefined) labels.push(`Absolute episode ${q.absoluteEpisode}`);
  if (q.tmdbId) labels.push(`TMDB ${q.tmdbId}`);
  if (q.tvdbId) labels.push(`TVDB ${q.tvdbId}`);
  if (q.imdbId) labels.push(q.imdbId);
  if (q.wants.resolution) labels.push(`${q.wants.resolution}p`);
  if (q.wants.category) labels.push(CATEGORY_LABEL[q.wants.category]);
  if (q.wants.dolbyVision) labels.push('Dolby Vision');
  if (q.wants.hdr) labels.push('HDR');
  if (q.wants.atmos) labels.push('Atmos');
  if (q.wants.codec) labels.push(q.wants.codec.toUpperCase());
  if (q.wants.dualAudio) labels.push('Dual audio');
  if (!labels.length) return null;
  return (
    <div className="searchUnderstood">
      {q.title && <span className="badge outline blue">{q.title}</span>}
      {labels.map((l) => (
        <span key={l} className="badge outline blue">
          {l}
        </span>
      ))}
    </div>
  );
}

/** Library state as Sonarr labels. */
function LibraryLabels({ r }: { r: LookupResult | Target }) {
  const l = r.library;
  if (!l) return null;
  if ('local' in r && r.local) {
    return (
      <>
        {r.kind !== 'album' && l.quality ? <QualityLabel quality={l.quality} isRemux={l.remux} size="lg" /> : null}
        <span className="badge lg">{r.local.files} {r.kind === 'movie' ? (r.local.files === 1 ? 'file' : 'files') : r.kind === 'album' ? 'tracks' : 'episodes'}</span>
        <span className="badge lg">{fmtBytes(r.local.size)}</span>
      </>
    );
  }
  if (r.kind === 'movie') return l.hasFile ? <QualityLabel quality={l.quality} isRemux={l.remux} size="lg" /> : <span className="badge lg red">Missing</span>;
  return (
    <>
      <span className={`badge lg ${l.files && l.files >= (l.episodes ?? 0) ? 'green' : l.files ? 'primaryLabel' : 'red'}`} title={r.kind === 'album' ? 'Track files / tracks' : 'Episode files / episodes'}>
        {l.files ?? 0} / {l.episodes ?? 0}
      </span>
      {l.remuxFiles ? <span className="badge lg remux">{l.remuxFiles} remux</span> : null}
    </>
  );
}

/** One title, laid out like Sonarr's AddNewSeriesSearchResult. */
function SearchResult({ r, active, onOpen, onHover }: { r: LookupResult; active: boolean; onOpen: () => void; onHover: () => void }) {
  return (
    <div className={`searchResult${active ? ' active' : ''}`} onClick={onOpen} onMouseEnter={onHover} role="option" aria-selected={active}>
      <div className={`searchResultPoster${r.kind === 'album' ? ' square' : ''}`}>
        <Cover className="img" src={r.poster} maxAngle={8}>
          {!r.poster && <span>{r.title}</span>}
        </Cover>
      </div>
      <div className="searchResultContent">
        <div className="searchResultTitleRow">
          <div className="searchResultTitle">
            {r.title}
            {r.year ? <span className="searchResultYear">({r.year})</span> : null}
            {r.inLibrary && (
              <span className="alreadyExistsIcon" title={`Already in ${APP_FOR[r.kind]}`}>
                <Icon.Check />
              </span>
            )}
          </div>
        </div>
        <div className="searchResultLabels">
          <span className="badge lg">{KIND_LABEL[r.kind]}</span>
          {r.artist && <span className="badge lg blue">{r.artist}</span>}
          {r.anime && <span className="badge lg purple">Anime</span>}
          <LibraryLabels r={r} />
          {r.local ? <span className="badge lg outline" title="On disk, not managed by an *arr app">Local</span> : !r.inLibrary && <span className="badge lg outline">Not in {APP_FOR[r.kind]}</span>}
        </div>
        {r.matchedOn && <div className="searchResultAlternate">Matched on “{r.matchedOn}”</div>}
        {r.local && <div className="searchResultAlternate mono">{r.local.folder}</div>}
        <div className="searchResultOverview">{r.overview}</div>
      </div>
    </div>
  );
}

/** Sonarr-style add modal: confirm before a title is added to Radarr / Sonarr. */
function AddModal({ r, busy, onAdd, onClose }: { r: LookupResult; busy: boolean; onAdd: (seriesType: 'standard' | 'anime' | 'daily') => void; onClose: () => void }) {
  const guessAnime = r.kind === 'series' && (r.anime || r.seriesType === 'anime' || /anime|japan/i.test(r.overview));
  const [seriesType, setSeriesType] = useState<'standard' | 'anime' | 'daily'>(guessAnime ? 'anime' : 'standard');
  return (
    <Modal
      title={`${r.title}${r.year ? ` (${r.year})` : ''}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => onAdd(seriesType)} disabled={busy}>
            {busy ? <span className="spinner" /> : null} Add {KIND_LABEL[r.kind]} and Search Releases
          </button>
        </>
      }
    >
      <div className="addModalBody">
        <div className={`addModalPoster${r.kind === 'album' ? ' square' : ''}`}>
          <Cover className="img" src={r.poster} maxAngle={6} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="addModalOverview">{r.overview || 'No overview.'}</div>
          {r.kind === 'series' && (
            <div className="field stack">
              <label>Series Type</label>
              <select value={seriesType} onChange={(e) => setSeriesType(e.target.value as typeof seriesType)}>
                <option value="standard">Standard</option>
                <option value="anime">Anime / Absolute</option>
                <option value="daily">Daily / Date</option>
              </select>
              <div className="help">Anime uses absolute episode numbers, which most anime Blu-ray releases follow.</div>
            </div>
          )}
          <div className="help">
            {r.kind === 'album' ? `Lidarr adds the album${r.artist ? ` and ${r.artist}` : ''} (artist unmonitored except this album) with your default quality and metadata profiles, without starting its own search.` : `${APP_FOR[r.kind]} adds it as monitored with your default quality profile and root folder, without starting its own search.`}
          </div>
        </div>
      </div>
    </Modal>
  );
}

export function SearchPage() {
  const { settings, profiles, toast } = useApp();
  const [params, setParams] = useSearchParams();
  const inputRef = useRef<HTMLInputElement>(null);

  const [q, setQ] = useState(params.get('q') ?? '');
  const [scope, setScope] = useState<Scope>(params.get('scope') === 'indexers' ? 'indexers' : params.get('scope') === 'local' ? 'local' : params.get('scope') === 'music' || params.get('kind') === 'album' ? 'music' : 'all');
  // Local files scope: every title on disk outside the *arr apps, sortable and filterable
  const [localList, setLocalList] = useState<LookupResult[] | null>(null);
  const [localSort, setLocalSortState] = useState<{ key: LocalSort; desc: boolean }>(() => {
    try {
      return { key: 'title', desc: false, ...JSON.parse(localStorage.getItem(LOCAL_SORT_KEY) ?? '{}') };
    } catch {
      return { key: 'title', desc: false };
    }
  });
  const setLocalSort = (key: LocalSort) =>
    setLocalSortState((prev) => {
      // picking the active key again flips the direction; size / files / modified / year start biggest or newest first
      const next = prev.key === key ? { key, desc: !prev.desc } : { key, desc: ['size', 'files', 'modified', 'year', 'relevance'].includes(key) };
      try {
        localStorage.setItem(LOCAL_SORT_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  const [localKind, setLocalKind] = useState<LocalKind>('all');
  const [localMatch, setLocalMatch] = useState<LocalMatch>('all');
  const [includeSoulseek, setIncludeSoulseek] = useState(true);
  const [releaseSource, setReleaseSource] = useState<'all' | 'lidarr' | 'soulseek'>('all');
  const [smart, setSmart] = useState<SmartSearchResult | null>(null);
  const [looking, setLooking] = useState(false);
  const [lookingOnline, setLookingOnline] = useState(false);
  const [active, setActive] = useState(0);
  const [adding, setAdding] = useState<LookupResult | null>(null);
  const [addBusy, setAddBusy] = useState(false);
  const [recent, setRecent] = useState<string[]>(readRecent);
  const seq = useRef(0);

  const [target, setTarget] = useState<Target | null>(null);
  const [season, setSeason] = useState<number | ''>(params.get('season') ? Number(params.get('season')) : '');
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [episodeId, setEpisodeId] = useState<number | ''>(params.get('episode') ? Number(params.get('episode')) : '');

  const [results, setResults] = useState<ReleaseSearch | null>(null);
  const [resultsQuery, setResultsQuery] = useState<SearchQuery | null>(null);
  const [searching, setSearching] = useState(false);
  const [category, setCategory] = useState<CategoryFilter | null>(null);
  const [resolution, setResolution] = useState<number>(0);
  const [text, setText] = useState('');
  const [sort, setSort] = useState<ReleaseSortKey>('score');
  const [profileId, setProfileId] = useState('');
  const [grabbing, setGrabbing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mediaType = target?.kind === 'album' || scope === 'music' ? 'music' : target?.kind === 'movie' ? 'movie' : target?.seriesType === 'anime' ? 'anime' : 'tv';
  useEffect(() => {
    if (settings) setProfileId(settings.defaultProfiles[mediaType] ?? profiles[0]?.id ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, profiles, mediaType]);

  const configured = { movie: Boolean(settings?.radarr.enabled), series: Boolean(settings?.sonarr.enabled), music: Boolean(settings?.lidarr.enabled), indexers: Boolean(settings?.prowlarr.enabled) };

  // ---------- title search (as you type: library instantly, TMDB / TVDB shortly after) ----------
  const runSmart = async (text: string, online: boolean) => {
    const id = ++seq.current;
    if (online) setLookingOnline(true);
    else setLooking(true);
    try {
      const res = await api.smart(text, scope === 'indexers' || scope === 'local' ? 'all' : scope, online);
      if (id !== seq.current) return;
      setSmart((prev) => (online || !prev || prev.query.raw !== res.query.raw ? res : { ...res, online: prev.online }));
      setError(res.errors.length ? res.errors.join(' · ') : null);
    } catch (e) {
      if (id === seq.current) setError((e as Error).message);
    } finally {
      if (id === seq.current) {
        setLooking(false);
        setLookingOnline(false);
      }
    }
  };

  useEffect(() => {
    if (scope === 'indexers' || scope === 'local' || target) return;
    const text = q.trim();
    if (text.length < 2) {
      setSmart(null);
      return;
    }
    const t1 = setTimeout(() => void runSmart(text, false), 150);
    const t2 = setTimeout(() => void runSmart(text, true), 700);
    setActive(0);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, scope]);

  const localShown = useMemo(() => {
    if (!localList) return [];
    const list = localList.filter(
      (r) =>
        (localKind === 'all' || r.kind === localKind) &&
        (localMatch === 'all' || (localMatch === 'matched' ? r.local?.matched : localMatch === 'unmatched' ? !r.local?.matched : r.library?.remux)),
    );
    const { key, desc } = localSort;
    const kindOrder = { movie: 0, series: 1, album: 2 };
    const val = (r: LookupResult): number | string =>
      key === 'relevance' ? r.score ?? 0 : key === 'year' ? r.year || 0 : key === 'size' ? r.local?.size ?? 0 : key === 'files' ? r.local?.files ?? 0 : key === 'modified' ? r.local?.modified ?? 0 : key === 'kind' ? kindOrder[r.kind] : `${r.artist ? `${r.artist} ` : ''}${r.title}`.toLowerCase();
    return [...list].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), undefined, { numeric: true });
      return (desc ? -c : c) || a.title.localeCompare(b.title, undefined, { numeric: true });
    });
  }, [localList, localSort, localKind, localMatch]);
  const hits = useMemo(() => (scope === 'local' ? localShown : smart ? [...smart.library, ...(smart.local ?? []), ...smart.online] : []), [smart, scope, localShown]);

  useEffect(() => {
    if (scope !== 'local' || target) return;
    let stale = false;
    const t = setTimeout(
      () =>
        api
          .localSearch(q.trim())
          .then((l) => {
            if (stale) return;
            setLocalList(l);
            setActive(0);
            // a typed query sorts by relevance until another sort is picked
            if (q.trim() && localSort.key === 'title') setLocalSortState({ key: 'relevance', desc: true });
          })
          .catch((e) => !stale && setError((e as Error).message)),
      q.trim() ? 150 : 0,
    );
    return () => {
      stale = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, scope, target]);
  const nav = useNavigate();

  // Header search (/search?q=…) while already on this page.
  const qParam = params.get('q');
  useEffect(() => {
    if (qParam === null) return;
    setQ(qParam);
    if (params.get('id')) return; // header popup "find releases" for a library title: handled below
    setTarget(null);
    setResults(null);
    inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qParam]);

  // ---------- deep links: /search?kind=movie&id=2, /search?kind=series&id=5&season=2&episode=123 ----------
  const idParam = params.get('id');
  useEffect(() => {
    const id = idParam;
    if (!id || target?.arrId === Number(id)) return;
    const k = params.get('kind') === 'movie' ? 'movie' : params.get('kind') === 'album' ? 'album' : 'series';
    (k === 'album'
      ? api.album(Number(id)).then(({ album: a }): Target => ({ kind: 'album', arrId: a.id, artistId: a.artistId, artist: a.artist, title: a.title, year: a.year, poster: a.cover, overview: a.overview, library: { hasFile: a.statistics.trackFileCount > 0, remux: false, files: a.statistics.trackFileCount, episodes: a.statistics.trackCount, sizeOnDisk: a.statistics.sizeOnDisk } }))
      : k === 'movie'
      ? api.movie(Number(id)).then((m): Target => ({ kind: 'movie', arrId: m.id, title: m.title, year: m.year, poster: m.poster, overview: m.overview, anime: m.anime, library: { hasFile: m.hasFile, remux: Boolean(m.file?.isRemux), quality: m.file?.quality, sizeOnDisk: m.file?.size } }))
      : api.seriesById(Number(id)).then((s): Target => ({ kind: 'series', arrId: s.id, title: s.title, year: s.year, poster: s.poster, overview: s.overview, seriesType: s.seriesType, seasons: s.seasons, library: { hasFile: s.statistics.episodeFileCount > 0, remux: s.statistics.remuxFileCount > 0, files: s.statistics.episodeFileCount, episodes: s.statistics.episodeCount, remuxFiles: s.statistics.remuxFileCount } }))
    )
      .then(async (t) => {
        const text = params.get('q');
        if (text) {
          // From the header popup: understand the query ("S01E05 2160p remux") and search straight away.
          const parsed = await api.smart(text, t.kind === 'album' ? 'music' : t.kind, false).catch(() => null);
          const hit = parsed?.library.find((h) => h.arrId === t.arrId);
          return openTarget({ ...t, anime: hit?.anime ?? t.anime, library: hit?.library ?? t.library }, parsed?.query ?? null);
        }
        if (t.kind === 'album') return openTarget(t, null);
        setTarget(t);
        if (t.kind === 'series' && !params.get('season') && !params.get('episode')) setSeason(t.seasons?.filter((x) => x.seasonNumber > 0).slice(-1)[0]?.seasonNumber ?? '');
      })
      .catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idParam]);

  // Episodes of the chosen season, for the episode picker.
  useEffect(() => {
    if (target?.kind !== 'series' || season === '') {
      setEpisodes([]);
      return;
    }
    let cancelled = false;
    api
      .episodes(target.arrId, season)
      .then((eps) => !cancelled && setEpisodes(eps.sort((a, b) => a.episodeNumber - b.episodeNumber)))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [target, season]);

  // ---------- releases ----------
  const releaseSearch = async (p: Record<string, string | number | undefined>, query: SearchQuery | null) => {
    setSearching(true);
    setError(null);
    setResults(null);
    setResultsQuery(query);
    setCategory(null);
    setResolution(query?.wants.resolution ?? 0);
    setText('');
    setSort('score');
    try {
      setResults(await api.releases({ ...p, filter: 'all', q: query?.raw }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSearching(false);
    }
  };

  const searchTarget = (t: Target | null = target, s: number | '' = season, ep: number | '' = episodeId, query: SearchQuery | null = smart?.query ?? resultsQuery) => {
    if (!t) return;
    const extra = { anime: t.seriesType === 'anime' || t.anime ? 1 : undefined };
    if (t.kind === 'album') return releaseSearch({ kind: 'album', albumId: t.arrId, soulseek: includeSoulseek && settings?.slskd.enabled ? 1 : undefined }, query);
    if (t.kind === 'movie') return releaseSearch({ kind: 'movie', id: t.arrId, ...extra }, query);
    if (ep !== '') return releaseSearch({ kind: 'episode', episodeId: ep, episodeSeason: s === '' ? undefined : s, ...extra }, query);
    if (s === '') return toast('warn', 'Pick a season first');
    return releaseSearch({ kind: 'season', seriesId: t.arrId, season: s, ...extra }, query);
  };

  const remember = () => {
    if (!q.trim()) return;
    pushRecent(q.trim());
    setRecent(readRecent());
  };

  /** Library titles open straight away; new titles go through the add modal first. */
  const open = async (r: LookupResult) => {
    setError(null);
    remember();
    if (r.local) {
      nav(`/local/${r.local.id}`);
      return;
    }
    if (!r.inLibrary || !r.arrId) {
      setAdding(r);
      return;
    }
    try {
      const query = smart?.query ?? null;
      if (r.kind === 'movie') return openTarget({ kind: 'movie', arrId: r.arrId, title: r.title, year: r.year, poster: r.poster, overview: r.overview, anime: r.anime, library: r.library }, query);
      if (r.kind === 'album') return openTarget({ kind: 'album', arrId: r.arrId, artistId: r.artistId, artist: r.artist, title: r.title, year: r.year, poster: r.poster, overview: r.overview, library: r.library }, query);
      const s = await api.seriesById(r.arrId);
      return openTarget({ kind: 'series', arrId: s.id, title: s.title, year: s.year, poster: s.poster, overview: s.overview, seriesType: s.seriesType, anime: r.anime, seasons: s.seasons, library: r.library }, query);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const add = async (r: LookupResult, seriesType: 'standard' | 'anime' | 'daily') => {
    setAddBusy(true);
    try {
      const query = smart?.query ?? null;
      if (r.kind === 'album') {
        const a = await api.addAlbum(r.foreignId!);
        toast('info', `Added ${r.title} to Lidarr`);
        setAdding(null);
        return openTarget({ kind: 'album', arrId: a.id, artistId: a.artistId, artist: r.artist, title: a.title, year: a.year, poster: a.cover ?? r.poster, overview: a.overview, library: { hasFile: false, remux: false, files: 0, episodes: a.statistics.trackCount } }, query);
      }
      const added = await api.addToArr({ kind: r.kind, externalId: r.externalId, seriesType });
      toast('info', `Added ${r.title} to ${APP_FOR[r.kind]}`);
      setAdding(null);
      if (r.kind === 'movie') return openTarget({ kind: 'movie', arrId: added.id, title: r.title, year: r.year, poster: r.poster, overview: r.overview, anime: r.anime }, query);
      const s = added as Series;
      return openTarget({ kind: 'series', arrId: s.id, title: s.title, year: s.year, poster: s.poster, overview: s.overview, seriesType: s.seriesType, anime: r.anime, seasons: s.seasons }, query);
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setAddBusy(false);
    }
  };

  /** Show a title and search its releases, with season / episode taken from the query when it has them. */
  const openTarget = async (t: Target, query: SearchQuery | null) => {
    setTarget(t);
    setParams({ kind: t.kind, id: String(t.arrId) }, { replace: true });

    // Season / episode from the query ("S02E05", "season 2", "- 12"), otherwise the latest season.
    let s: number | '' = '';
    let ep: number | '' = '';
    if (t.kind === 'series') {
      const real = t.seasons?.filter((x) => x.seasonNumber > 0) ?? [];
      const chosen: number | undefined = query?.season !== undefined && t.seasons?.some((x) => x.seasonNumber === query.season) ? query.season : query?.episode !== undefined || query?.absoluteEpisode !== undefined ? (real[0]?.seasonNumber ?? 1) : real.slice(-1)[0]?.seasonNumber;
      s = chosen ?? '';
      const wantedEp = query?.episode ?? query?.absoluteEpisode;
      if (wantedEp !== undefined && chosen !== undefined) {
        const eps = await api.episodes(t.arrId, chosen).catch(() => [] as Episode[]);
        ep = eps.find((e) => e.episodeNumber === wantedEp)?.id ?? '';
      }
    }
    setSeason(s);
    setEpisodeId(ep);
    void searchTarget(t, s, ep, query);
  };

  const submit = () => {
    const text = q.trim();
    if (!text && scope !== 'local') return;
    if (scope === 'indexers') {
      remember();
      setTarget(null);
      return releaseSearch({ kind: 'prowlarr', q: text, category: 'all' }, null);
    }
    if (hits[active]) return open(hits[active]);
    if (scope !== 'local') void runSmart(text, true);
  };

  const clearTarget = () => {
    setTarget(null);
    setResults(null);
    setEpisodeId('');
    setParams({}, { replace: true });
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const grab = async (r: Release) => {
    if (!profileId) return toast('warn', 'Pick an encoding profile first');
    setGrabbing(r.guid);
    try {
      const res = await api.grab({
        release: r,
        profileId,
        title: target ? `${target.kind === 'album' && target.artist ? `${target.artist} – ` : ''}${target.title}${target.year ? ` (${target.year})` : ''}` : r.title,
        poster: target?.poster,
        arrId: target?.kind === 'album' ? target.artistId : target?.arrId,
        albumId: target?.kind === 'album' ? target.arrId : undefined,
        seasonNumber: target?.kind === 'series' && season !== '' ? season : undefined,
        episodeIds: episodeId !== '' ? [episodeId] : r.episodeIds,
      });
      toast('info', res.note ?? `Grabbed. Rexarr will encode it once ${r.source === 'radarr' ? 'Radarr' : r.source === 'lidarr' ? 'Lidarr' : 'Sonarr'} imports the download.`);
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setGrabbing(null);
    }
  };

  // ---------- release filtering / sorting ----------
  const all = results?.releases ?? [];
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of all) c[r.category ?? 'other'] = (c[r.category ?? 'other'] ?? 0) + 1;
    return c;
  }, [all]);
  const musicResults = all.some((r) => r.source === 'lidarr' || r.source === 'soulseek') || target?.kind === 'album';
  const lossless = musicResults ? (counts.hires ?? 0) + (counts.cd ?? 0) + (counts.mqa ?? 0) : (counts.remux ?? 0) + (counts.disc ?? 0);
  const otherCount = (counts.hdtv ?? 0) + (counts.dvd ?? 0) + (counts.other ?? 0);
  const [sourceFilter, setSourceFilter] = [releaseSource, setReleaseSource];
  const defaultCategory: CategoryFilter = resultsQuery?.wants.category ?? (musicResults ? 'best' : settings?.remuxOnly === false ? 'all' : settings?.searchDiscReleases === false ? 'remux' : 'best');
  const activeCategory = category ?? defaultCategory;
  const inCategory = (r: Release) => {
    if (sourceFilter !== 'all' && r.source !== sourceFilter) return false;
    if (activeCategory === 'all') return true;
    if (activeCategory === 'best') return lossless ? (musicResults ? ['hires', 'cd', 'mqa'].includes(r.category ?? '') : r.category === 'remux' || r.category === 'disc') : true;
    if (activeCategory === 'other') return r.category === 'hdtv' || r.category === 'dvd' || r.category === 'other';
    return r.category === activeCategory;
  };
  const byCategory = all.filter(inCategory);
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = byCategory
    .filter((r) => !resolution || bucket(r.resolution) === resolution)
    .filter((r) => words.every((w) => `${r.title} ${r.indexer} ${(r.tags ?? []).join(' ')} ${r.languages.join(' ')}`.toLowerCase().includes(w)))
    .sort((a, b) => {
      switch (sort) {
        case 'size':
          return b.size - a.size;
        case 'peers':
          return (b.seeders ?? -1) - (a.seeders ?? -1);
        case 'age':
          return a.ageDays - b.ageDays;
        case 'quality':
          return b.resolution - a.resolution || (b.score ?? 0) - (a.score ?? 0);
        case 'protocol':
          return a.protocol.localeCompare(b.protocol) || (b.score ?? 0) - (a.score ?? 0);
        case 'title':
          return a.title.localeCompare(b.title);
        case 'indexer':
          return a.indexer.localeCompare(b.indexer) || (b.score ?? 0) - (a.score ?? 0);
        default:
          return (b.score ?? 0) - (a.score ?? 0);
      }
    });
  const bestGuid = sort === 'score' && shown[0] && (shown[0].score ?? 0) > 0 ? shown[0].guid : undefined;
  const defaultResolution = resultsQuery?.wants.resolution ?? 0;
  const filterActive = activeCategory !== defaultCategory || resolution !== defaultResolution;

  const musicFilterItems: MenuItemDef[] = [
    { key: 'h-type', header: true, label: 'Format' },
    ...(
      [
        ['best', `Best (${lossless || all.length})`],
        ['hires', `Hi-Res lossless (${counts.hires ?? 0})`],
        ['cd', `CD quality lossless (${counts.cd ?? 0})`],
        ['mqa', `MQA (${counts.mqa ?? 0})`],
        ['lossy', `Lossy (${counts.lossy ?? 0})`],
        ['all', `All (${all.length})`],
      ] as [CategoryFilter, string][]
    ).map(([k, label]) => ({ key: `c-${k}`, label, selected: activeCategory === k, onSelect: () => setCategory(k) })),
    { key: 's1', separator: true, label: '' },
    { key: 'h-src', header: true, label: 'Source' },
    ...(
      [
        ['all', `All (${all.length})`],
        ['lidarr', `Lidarr indexers (${all.filter((r) => r.source === 'lidarr').length})`],
        ['soulseek', `Soulseek (${all.filter((r) => r.source === 'soulseek').length})`],
      ] as ['all' | 'lidarr' | 'soulseek', string][]
    ).map(([k, label]) => ({ key: `s-${k}`, label, selected: sourceFilter === k, onSelect: () => setSourceFilter(k) })),
  ];
  const filterItems: MenuItemDef[] = musicResults ? musicFilterItems : [
    { key: 'h-type', header: true, label: 'Release type' },
    ...(
      [
        ['best', `Best (${lossless || all.length})`],
        ['remux', `Remux (${counts.remux ?? 0})`],
        ['disc', `Disc / ISO (${counts.disc ?? 0})`],
        ['bluray', `Blu-ray (${counts.bluray ?? 0})`],
        ['web', `WEB (${counts.web ?? 0})`],
        ...(otherCount ? [['other', `Other (${otherCount})`]] : []),
        ['all', `All (${all.length})`],
      ] as [CategoryFilter, string][]
    ).map(([k, label]) => ({ key: `c-${k}`, label, selected: activeCategory === k, onSelect: () => setCategory(k) })),
    { key: 's1', separator: true, label: '' },
    { key: 'h-res', header: true, label: 'Resolution' },
    ...[0, 2160, 1080, 720, 480].map((res) => ({
      key: `r-${res}`,
      label: res === 0 ? 'Any' : `${res === 480 ? 'SD' : `${res}p`} (${byCategory.filter((r) => bucket(r.resolution) === res).length})`,
      selected: resolution === res,
      onSelect: () => setResolution(res),
    })),
  ];
  const sortItems: MenuItemDef[] = (
    [
      ['score', 'Score'],
      ['quality', 'Quality'],
      ['size', 'Size'],
      ['peers', 'Peers'],
      ['age', 'Age'],
      ['indexer', 'Indexer'],
      ['title', 'Title'],
    ] as [ReleaseSortKey, string][]
  ).map(([k, label]) => ({ key: k, label, selected: sort === k, onSelect: () => setSort(k) }));

  const scopeItems: MenuItemDef[] = (['all', 'movie', 'series', 'music', 'local', 'indexers'] as Scope[]).map((s) => ({
    key: s,
    label: SCOPE_LABEL[s],
    selected: scope === s,
    disabled: s === 'all' ? !configured.movie && !configured.series : s === 'local' ? !settings?.localMedia?.enabled : !configured[s],
    onSelect: () => {
      setScope(s);
      setResults(null);
      if (s === 'indexers') setTarget(null);
    },
  }));

  const localSortItems: MenuItemDef[] = (
    [
      ['relevance', 'Relevance'],
      ['title', 'Title'],
      ['year', 'Year'],
      ['size', 'Size'],
      ['files', 'Files'],
      ['modified', 'Date Modified'],
      ['kind', 'Type'],
    ] as [LocalSort, string][]
  )
    .filter(([k]) => k !== 'relevance' || q.trim())
    .map(([k, label]) => ({ key: k, label: localSort.key === k ? `${label} ${localSort.desc ? '↓' : '↑'}` : label, selected: localSort.key === k, onSelect: () => setLocalSort(k) }));
  const countKind = (k: LocalKind) => (localList ?? []).filter((r) => k === 'all' || r.kind === k).length;
  const localFilterItems: MenuItemDef[] = [
    { key: 'h-kind', header: true, label: 'Type' },
    ...(
      [
        ['all', 'All'],
        ['movie', 'Movies'],
        ['series', 'Series'],
        ['album', 'Albums'],
      ] as [LocalKind, string][]
    ).map(([k, label]) => ({ key: `k-${k}`, label: `${label} (${countKind(k)})`, selected: localKind === k, onSelect: () => setLocalKind(k) })),
    { key: 's1', separator: true, label: '' },
    { key: 'h-meta', header: true, label: 'Show' },
    ...(
      [
        ['all', 'Everything'],
        ['matched', 'With metadata'],
        ['unmatched', 'No metadata match'],
        ['remux', 'Has a remux'],
      ] as [LocalMatch, string][]
    ).map(([k, label]) => ({ key: `m-${k}`, label, selected: localMatch === k, onSelect: () => setLocalMatch(k) })),
  ];

  const releasePanel = results && (
    <>
      <div className="releaseFilterRow">
        <span className="releaseSummary">
          {shown.length} of {all.length} releases
          <span className="dim">
            {' '}
            · {activeCategory === 'best' ? (lossless ? (musicResults ? 'lossless' : 'remux and disc') : musicResults ? 'no lossless release found, showing all' : 'no remux or disc found, showing all') : CATEGORY_LABEL[activeCategory as ReleaseCategory] ?? 'all'}
            {sourceFilter !== 'all' ? ` · ${sourceFilter === 'soulseek' ? 'Soulseek' : 'Lidarr indexers'}` : ''}
            {resolution ? ` · ${resolution === 480 ? 'SD' : `${resolution}p`}` : ''}
            {resultsQuery && (resultsQuery.wants.resolution || resultsQuery.wants.category || resultsQuery.wants.hdr || resultsQuery.wants.dolbyVision) ? ` · ranked for “${resultsQuery.raw}”` : ''}
          </span>
          {filterActive && (
            <button
              className="btn sm"
              style={{ marginLeft: 10 }}
              onClick={() => {
                setCategory(null);
                setResolution(defaultResolution);
              }}
            >
              Reset filter
            </button>
          )}
        </span>
        <input type="search" className="releaseText" placeholder="Filter releases" value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      {shown.some((r) => r.isDisc) && (
        <div className="info">
          Disc releases are downloaded by {target?.kind === 'series' ? 'Sonarr' : 'Radarr'}, then ripped with MakeMKV, transcoded and imported. The download folder must be reachable by Rexarr (path mappings).
        </div>
      )}
      {shown.length === 0 && all.length > 0 ? (
        <div className="empty">
          <div>All results are hidden by the applied filter</div>
          <button
            className="btn sm mt"
            onClick={() => {
              setCategory('all');
              setResolution(0);
              setText('');
            }}
          >
            Show all {all.length}
          </button>
        </div>
      ) : (
        <ReleaseTable releases={shown} onGrab={grab} busyGuid={grabbing} bestGuid={bestGuid} highlight={text} sort={sort} onSort={setSort} />
      )}
    </>
  );

  return (
    <Page
      title="Search"
      toolbarLeft={
        <>
          <ToolbarMenu icon={<Icon.Search />} label={SCOPE_LABEL[scope]} items={scopeItems} align="left" />
          {target && (
            <>
              <ToolbarSeparator />
              <ToolbarButton icon={<Icon.ArrowLeftCircle />} label="New Search" onClick={clearTarget} wide />
              <ToolbarButton icon={<Icon.Refresh />} label="Search Again" onClick={() => searchTarget()} busy={searching} wide />
            </>
          )}
        </>
      }
      toolbarRight={
        scope === 'local' && !target ? (
          <>
            <ToolbarMenu icon={<Icon.Sort />} label="Sort" items={localSortItems} />
            <ToolbarMenu icon={<Icon.Filter />} label="Filter" items={localFilterItems} selected={localKind !== 'all' || localMatch !== 'all'} />
          </>
        ) : results ? (
          <>
            <ToolbarMenu icon={<Icon.Sort />} label="Sort" items={sortItems} />
            <ToolbarMenu icon={<Icon.Filter />} label="Filter" items={filterItems} selected={filterActive} />
          </>
        ) : undefined
      }
    >
      {adding && <AddModal r={adding} busy={addBusy} onAdd={(t) => add(adding, t)} onClose={() => setAdding(null)} />}

      {!target && (
        <div className="searchInputContainer">
          <div className="searchIconContainer">{looking || lookingOnline || (scope === 'indexers' && searching) ? <span className="spinner" /> : <Icon.Search />}</div>
          <input
            ref={inputRef}
            autoFocus={!params.get('id')}
            type="text"
            className="searchInput"
            placeholder={scope === 'local' ? 'Filter local files by title or artist – leave empty to browse all' : scope === 'indexers' ? 'eg. Akira 1988 2160p remux' : scope === 'movie' ? 'eg. Blade Runner 2049, tmdb:335984' : scope === 'series' ? 'eg. Frieren S01E05, tvdb:424536' : 'eg. Blade Runner 2049 2160p remux, Frieren S01E05, tt1856101'}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
              else if (e.key === 'ArrowDown' && hits.length) {
                e.preventDefault();
                setActive((a) => Math.min(hits.length - 1, a + 1));
              } else if (e.key === 'ArrowUp' && hits.length) {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === 'Escape') setQ('');
            }}
          />
          <button
            className="clearLookupButton"
            onClick={() => {
              setQ('');
              setSmart(null);
              setResults(null);
              inputRef.current?.focus();
            }}
            title="Clear"
          >
            <Icon.X />
          </button>
        </div>
      )}

      {!target && smart && scope !== 'indexers' && scope !== 'local' && q.trim().length >= 2 && <Understood q={smart.query} />}
      {error && <div className="error">{error}</div>}

      {scope === 'local' && !target && (
        <div role="listbox">
          {!localList && <LoadingIndicator>Loading local files…</LoadingIndicator>}
          {localList && (
            <fieldset className="fieldSet searchSection">
              <legend>
                {localShown.length === localList.length ? `${localList.length} local ${localList.length === 1 ? 'title' : 'titles'}` : `${localShown.length} of ${localList.length} local titles`}
                <span className="dim small" style={{ marginLeft: 6 }}>· sorted by {localSortItems.find((i) => i.selected)?.label ?? 'title'}</span>
              </legend>
              {localShown.map((r, i) => (
                <SearchResult key={`local-${r.local?.id}`} r={r} active={active === i} onOpen={() => open(r)} onHover={() => setActive(i)} />
              ))}
              {!localShown.length && (
                <div className="searchMessage">
                  <div className="noResultsText">{q.trim() ? `No local files match '${q.trim()}'` : 'No local files'}</div>
                  <div>
                    {localList.length ? 'Try another filter.' : (
                      <>
                        Add folders in <Link to="/settings">Settings → Local media</Link> and rescan.
                      </>
                    )}
                  </div>
                </div>
              )}
            </fieldset>
          )}
        </div>
      )}

      {!target && !q.trim() && !results && scope !== 'local' && (
        <div className="searchMessage">
          <div className="searchHelpText">It's easy to find a Blu-ray remux, just start typing the name of the movie or series.</div>
          <div>
            You can also search by id (<code>tmdb:335984</code>, <code>tvdb:424536</code>, <code>tt1856101</code>) and add <code>S01E05</code>, <code>2160p</code>, <code>remux</code>, <code>iso</code> or <code>dv</code> to narrow the releases.
          </div>
          {recent.length > 0 && (
            <div className="searchRecent">
              <div className="dim">Recent searches</div>
              <div>
                {recent.map((r) => (
                  <button key={r} className="btn sm" onClick={() => setQ(r)}>
                    {r}
                  </button>
                ))}
                <button
                  className="btn sm"
                  onClick={() => {
                    try {
                      localStorage.removeItem(RECENT_KEY);
                    } catch {
                      /* ignore */
                    }
                    setRecent([]);
                  }}
                >
                  <Icon.Trash /> Clear
                </button>
              </div>
            </div>
          )}
          {!configured.movie && !configured.series && (
            <div className="warn mt">
              No *arr apps are connected yet. Configure Radarr and Sonarr in <Link to="/settings">Settings</Link>.
            </div>
          )}
        </div>
      )}

      {!target && smart && scope !== 'indexers' && scope !== 'local' && q.trim().length >= 2 && (
        <div role="listbox">
          {smart.library.length > 0 && (
            <fieldset className="fieldSet searchSection">
              <legend>In Your Library</legend>
              {smart.library.map((r, i) => (
                <SearchResult key={`lib-${r.kind}-${r.externalId}`} r={r} active={active === i} onOpen={() => open(r)} onHover={() => setActive(i)} />
              ))}
            </fieldset>
          )}
          {smart.local?.length > 0 && (
            <fieldset className="fieldSet searchSection">
              <legend>On Disk, Not in *arr</legend>
              {smart.local.map((r, i) => (
                <SearchResult key={`local-${r.local?.id}`} r={r} active={active === smart.library.length + i} onOpen={() => open(r)} onHover={() => setActive(smart.library.length + i)} />
              ))}
            </fieldset>
          )}
          {(smart.online.length > 0 || lookingOnline) && (
            <fieldset className="fieldSet searchSection">
              <legend>
                Add New {lookingOnline && <span className="spinner" style={{ width: 14, height: 14, marginLeft: 8 }} />}
              </legend>
              {smart.online.map((r, i) => (
                <SearchResult key={`new-${r.kind}-${r.externalId}`} r={r} active={active === smart.library.length + (smart.local?.length ?? 0) + i} onOpen={() => open(r)} onHover={() => setActive(smart.library.length + (smart.local?.length ?? 0) + i)} />
              ))}
            </fieldset>
          )}
          {!hits.length && !looking && !lookingOnline && (
            <div className="searchMessage">
              <div className="noResultsText">Couldn't find any results for '{smart.query.title || q}'</div>
              <div>{scope !== 'all' ? 'Try searching All.' : configured.indexers ? 'Try the Indexers scope for a raw search.' : 'Check the spelling, or search by TMDB / TVDB id.'}</div>
            </div>
          )}
        </div>
      )}

      {target && (
        <>
          <div className="searchTarget">
            <div className={`searchResultPoster sm${target.kind === 'album' ? ' square' : ''}`}>
              <Cover className="img" src={target.poster} maxAngle={6} />
            </div>
            <div className="searchResultContent">
              <div className="searchResultTitle">
                <Link to={target.kind === 'movie' ? `/movies/${target.arrId}` : target.kind === 'album' ? `/music/artist/${target.artistId}?album=${target.arrId}` : `/series/${target.arrId}`}>{target.title}</Link>
                {target.year ? <span className="searchResultYear">({target.year})</span> : null}
              </div>
              <div className="searchResultLabels">
                <span className="badge lg">{KIND_LABEL[target.kind]}</span>
                {target.artist && <span className="badge lg blue">{target.artist}</span>}
                {(target.seriesType === 'anime' || target.anime) && <span className="badge lg purple">Anime</span>}
                <LibraryLabels r={target} />
                {target.kind === 'movie' && target.library?.sizeOnDisk ? <span className="badge lg">{fmtBytes(target.library.sizeOnDisk)}</span> : null}
              </div>
              <div className="searchTargetForm">
                {target.kind === 'series' && (
                  <>
                    <div className="formGroup">
                      <label>Season</label>
                      <select
                        value={season}
                        onChange={(e) => {
                          setSeason(e.target.value === '' ? '' : Number(e.target.value));
                          setEpisodeId('');
                        }}
                      >
                        <option value="">Select season</option>
                        {target.seasons?.map((s) => (
                          <option key={s.seasonNumber} value={s.seasonNumber}>
                            {s.seasonNumber === 0 ? 'Specials' : `Season ${s.seasonNumber}`} ({s.episodeFileCount}/{s.episodeCount}
                            {s.remuxCount ? ` · ${s.remuxCount} remux` : ''})
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="formGroup">
                      <label>Episode</label>
                      <select value={episodeId} onChange={(e) => setEpisodeId(e.target.value === '' ? '' : Number(e.target.value))} disabled={season === ''}>
                        <option value="">Whole season</option>
                        {episodes.map((ep) => (
                          <option key={ep.id} value={ep.id}>
                            {String(ep.episodeNumber).padStart(2, '0')} - {ep.title}
                            {ep.file ? ` (${ep.file.quality})` : ' (missing)'}
                          </option>
                        ))}
                      </select>
                    </div>
                  </>
                )}
                <div className="formGroup">
                  <label>{target.kind === 'album' ? 'Music Profile' : 'Encoding Profile'}</label>
                  <ProfileSelect profiles={profiles} value={profileId} onChange={setProfileId} mediaType={mediaType} />
                </div>
                {target.kind === 'album' && settings?.slskd.enabled && (
                  <div className="formGroup">
                    <label>&nbsp;</label>
                    <label className="check" style={{ paddingTop: 7 }}>
                      <input type="checkbox" checked={includeSoulseek} onChange={(e) => setIncludeSoulseek(e.target.checked)} /> Also search Soulseek
                    </label>
                  </div>
                )}
                <div className="formGroup">
                  <label>&nbsp;</label>
                  <button className="btn primary" onClick={() => searchTarget()} disabled={searching}>
                    {searching ? <span className="spinner" /> : <Icon.Search />} {results ? 'Search Again' : 'Interactive Search'}
                  </button>
                </div>
              </div>
            </div>
          </div>
          {searching && <LoadingIndicator>Searching indexers through {APP_FOR[target.kind]}{target.kind === 'album' && includeSoulseek && settings?.slskd.enabled ? ' and Soulseek' : ''}…</LoadingIndicator>}
          {releasePanel}
        </>
      )}

      {scope === 'indexers' && !target && (searching || results) && (
        <>
          <div className="searchTargetForm" style={{ margin: '20px 0 0' }}>
            <div className="formGroup">
              <label>Encoding Profile</label>
              <ProfileSelect profiles={profiles} value={profileId} onChange={setProfileId} />
            </div>
          </div>
          <div className="info mt">Prowlarr grabs go straight to your download client and are not imported by Radarr / Sonarr, so Rexarr cannot track them. For a tracked grab, search the title under All.</div>
          {searching && <LoadingIndicator>Searching every indexer in Prowlarr…</LoadingIndicator>}
          {releasePanel}
        </>
      )}
    </Page>
  );
}

function bucket(res: number) {
  return res >= 2000 ? 2160 : res >= 1000 ? 1080 : res >= 700 ? 720 : res > 0 ? 480 : 0;
}
