import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { LookupResult, SearchQuery, SmartSearchResult } from '@shared/types';
import { api } from '../api';
import { Icon } from './Icons';

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

/** The query asks for something release-specific ("2160p", "remux", "S01E05") – open release search, not the title page. */
function wantsReleases(q?: SearchQuery) {
  return Boolean(q && (Object.keys(q.wants).length || q.season !== undefined || q.episode !== undefined || q.absoluteEpisode !== undefined));
}

function Status({ r }: { r: LookupResult }) {
  const l = r.library;
  if (r.local && l) {
    return (
      <>
        {r.kind !== 'album' && l.quality ? <span className={`badge sm ${l.remux ? 'remux' : 'blue'}`}>{l.quality}</span> : null}
        <span className="badge sm">{r.local.files} {r.kind === 'movie' ? 'file' : r.kind === 'album' ? 'tracks' : 'eps'}</span>
      </>
    );
  }
  if (!r.inLibrary || !l) return null;
  if (r.kind === 'movie') return l.hasFile ? <span className={`badge sm ${l.remux ? 'remux' : 'blue'}`}>{l.quality}</span> : <span className="badge sm red">Missing</span>;
  return (
    <>
      <span className={`badge sm ${l.files && l.files >= (l.episodes ?? 0) ? 'green' : l.files ? 'blue' : 'red'}`}>
        {l.files ?? 0} / {l.episodes ?? 0}
      </span>
      {l.remuxFiles ? <span className="badge sm remux">{l.remuxFiles} remux</span> : null}
    </>
  );
}

/** Release words the query picked up, as short labels. */
function understoodLabels(q: SearchQuery): string[] {
  const out: string[] = [];
  if (q.season !== undefined) out.push(`S${String(q.season).padStart(2, '0')}${q.episode !== undefined ? `E${String(q.episode).padStart(2, '0')}` : ''}`);
  else if (q.episode !== undefined) out.push(`E${q.episode}`);
  if (q.absoluteEpisode !== undefined) out.push(`#${q.absoluteEpisode}`);
  if (q.wants.resolution) out.push(`${q.wants.resolution}p`);
  if (q.wants.category) out.push({ remux: 'Remux', disc: 'Disc', bluray: 'Blu-ray', web: 'WEB', hdtv: 'HDTV', dvd: 'DVD', other: 'Other', hires: 'Hi-Res', cd: 'CD Quality', mqa: 'MQA', lossy: 'Lossy' }[q.wants.category]);
  if (q.wants.dolbyVision) out.push('DV');
  if (q.wants.hdr) out.push('HDR');
  if (q.wants.atmos) out.push('Atmos');
  return out;
}

/**
 * Header search with a live popup: library titles as you type, TMDB / TVDB titles a moment later.
 * ↑↓ to move, Enter to open (release search when the query mentions quality or an episode), Esc to close.
 */
export function HeaderSearch() {
  const nav = useNavigate();
  const { pathname } = useLocation();
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [res, setRes] = useState<SmartSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingOnline, setLoadingOnline] = useState(false);
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);
  const seq = useRef(0);

  // "/" or Ctrl/Cmd+K focuses the search, like the *arr apps.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable);
      if ((e.key === '/' && !typing) || (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Close when clicking elsewhere or navigating.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);
  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    const text = q.trim();
    if (text.length < 2) {
      setRes(null);
      setLoading(false);
      setLoadingOnline(false);
      return;
    }
    const run = async (online: boolean) => {
      const id = ++seq.current;
      if (online) setLoadingOnline(true);
      else setLoading(true);
      try {
        const r = await api.smart(text, 'all', online);
        if (id !== seq.current) return;
        // keep the previous online answers while the library-only request for the same text comes back
        setRes((prev) => (online || !prev || prev.query.raw !== r.query.raw ? r : { ...r, online: prev.online }));
      } catch {
        /* the popup just stays as it was */
      } finally {
        if (id === seq.current) {
          setLoading(false);
          setLoadingOnline(false);
        }
      }
    };
    const t1 = setTimeout(() => void run(false), 120);
    const t2 = setTimeout(() => void run(true), 650);
    setActive(0);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [q]);

  const items = useMemo(() => [...(res?.library ?? []).slice(0, 6), ...(res?.local ?? []).slice(0, 4), ...(res?.online ?? []).slice(0, 5)], [res]);
  const libCount = Math.min(6, res?.library.length ?? 0);
  const localCount = Math.min(4, res?.local?.length ?? 0);
  const text = q.trim();
  const releaseHint = wantsReleases(res?.query);
  // Last row: the full search page.
  const total = items.length + (text ? 1 : 0);

  const close = (clear = true) => {
    setOpen(false);
    if (clear) {
      setQ('');
      setRes(null);
    }
    inputRef.current?.blur();
  };

  const goSearchPage = () => {
    if (!text) return;
    pushRecent(text);
    nav(`/search?q=${encodeURIComponent(text)}`);
    close();
  };

  const openItem = (r: LookupResult, releases = releaseHint) => {
    if (text) pushRecent(text);
    if (r.local) nav(`/local/${r.local.id}`);
    else if (r.inLibrary && r.arrId) {
      if (releases) nav(`/search?kind=${r.kind}&id=${r.arrId}&q=${encodeURIComponent(text)}`);
      else nav(r.kind === 'movie' ? `/movies/${r.arrId}` : r.kind === 'album' ? `/music/artist/${r.artistId}?album=${r.arrId}` : `/series/${r.arrId}`);
    } else {
      // Not in Radarr / Sonarr yet: the search page offers "Add & search".
      nav(`/search?q=${encodeURIComponent(text)}`);
    }
    close();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(total - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (!text) return;
      if (active < items.length && items[active]) openItem(items[active]);
      else goSearchPage();
    } else if (e.key === 'Escape') {
      if (open && text) setOpen(false);
      else close();
    } else if (e.key === 'Tab') setOpen(false);
  };

  const showRecent = open && !text && recent.length > 0;
  const showResults = open && text.length >= 2;

  return (
    <div className="headerSearch" ref={boxRef}>
      <Icon.Search />
      <input
        ref={inputRef}
        type="text"
        placeholder="Search"
        value={q}
        role="combobox"
        aria-expanded={showResults}
        aria-controls="headerSearchPopup"
        aria-autocomplete="list"
        onFocus={() => {
          setRecent(readRecent());
          setOpen(true);
        }}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
      />

      {showRecent && (
        <div className="headerSuggestions" id="headerSearchPopup">
          <div className="sectionTitle">Recent Searches</div>
          <ul className="list">
            {recent.map((r) => (
              <li
                key={r}
                className="listItem"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setQ(r);
                  inputRef.current?.focus();
                }}
              >
                <div className="addNewSeriesSuggestion">
                  <span className="searchIcon">
                    <Icon.Clock />
                  </span>
                  {r}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {showResults && (
        <div className="headerSuggestions" id="headerSearchPopup" role="listbox">
          {libCount > 0 && (
            <>
              <div className="sectionTitle">Existing Movies and Series</div>
              <ul className="list">{items.slice(0, libCount).map((r, i) => row(r, i))}</ul>
            </>
          )}
          {localCount > 0 && (
            <>
              <div className="sectionTitle">On Disk, Not in *arr</div>
              <ul className="list">{items.slice(libCount, libCount + localCount).map((r, i) => row(r, libCount + i))}</ul>
            </>
          )}
          <div className="sectionTitle">Add New</div>
          <ul className="list">
            {items.slice(libCount + localCount).map((r, i) => row(r, libCount + localCount + i))}
            {loadingOnline && items.length === libCount + localCount && <li className="loading">Searching TMDB / TVDB…</li>}
            <li className={`listItem${active === items.length ? ' highlighted' : ''}`} onMouseEnter={() => setActive(items.length)} onMouseDown={(e) => e.preventDefault()} onClick={goSearchPage} role="option" aria-selected={active === items.length}>
              <div className="addNewSeriesSuggestion">
                <span className="searchIcon">
                  <Icon.Search />
                </span>
                Search for {text}
                {res && wantsReleases(res.query) && (
                  <span className="tagContainer">
                    {understoodLabels(res.query).map((l) => (
                      <span key={l} className="badge sm">
                        {l}
                      </span>
                    ))}
                  </span>
                )}
              </div>
            </li>
          </ul>
          {res && !items.length && !loading && !loadingOnline && <div className="loading">No movies or series match '{res.query.title || text}'</div>}
        </div>
      )}
    </div>
  );

  function row(r: LookupResult, i: number) {
    return (
      <li
        key={r.local ? `local-${r.local.id}` : `${r.inLibrary ? 'lib' : 'new'}-${r.kind}-${r.externalId}`}
        className={`listItem${active === i ? ' highlighted' : ''}`}
        role="option"
        aria-selected={active === i}
        onMouseEnter={() => setActive(i)}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => openItem(r)}
      >
        <div className="result">
          <div className={`poster${r.kind === 'album' ? ' square' : ''}`} style={{ backgroundImage: r.poster ? `url(${r.poster})` : undefined }} />
          <div className="titles">
            <div className="title">
              {r.title} {r.year ? <span className="year">({r.year})</span> : null}
            </div>
            {r.matchedOn && <div className="alternateTitle">{r.matchedOn}</div>}
            <div className="tagContainer">
              <span className="badge sm">{r.kind === 'movie' ? 'Movie' : r.kind === 'album' ? 'Album' : 'Series'}</span>
              {r.artist && <span className="badge sm blue">{r.artist}</span>}
              {r.anime && <span className="badge sm purple">Anime</span>}
              <Status r={r} />
            </div>
          </div>
          {r.inLibrary && (
            <button
              className="releasesButton"
              title="Interactive search"
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                openItem(r, true);
              }}
            >
              <Icon.Search />
            </button>
          )}
        </div>
      </li>
    );
  }
}
