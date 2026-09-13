import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { LookupResult, Release, Series } from '@shared/types';
import { api, type ReleaseSearch } from '../api';
import { useApp } from '../App';
import { Page, ToolbarText } from '../components/Layout';
import { Icon } from '../components/Icons';
import { ReleaseTable } from '../components/ReleaseTable';
import { ProfileSelect } from '../components/ProfileSelect';
import { LoadingIndicator } from '../components/Labels';

type Kind = 'movie' | 'series' | 'prowlarr';

interface Target {
  kind: 'movie' | 'series';
  arrId: number;
  title: string;
  poster?: string;
  seriesType?: string;
  seasons?: Series['seasons'];
}

export function SearchPage() {
  const { settings, profiles, toast } = useApp();
  const [params, setParams] = useSearchParams();
  const [kind, setKind] = useState<Kind>((params.get('kind') as Kind) || 'movie');
  const [q, setQ] = useState(params.get('q') ?? '');
  const [lookup, setLookup] = useState<LookupResult[] | null>(null);
  const [looking, setLooking] = useState(false);
  const [target, setTarget] = useState<Target | null>(null);
  const [season, setSeason] = useState<number | ''>(params.get('season') ? Number(params.get('season')) : '');
  const [episodeId, setEpisodeId] = useState<number | ''>(params.get('episode') ? Number(params.get('episode')) : '');
  const [results, setResults] = useState<ReleaseSearch | null>(null);
  const [searching, setSearching] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [profileId, setProfileId] = useState('');
  const [grabbing, setGrabbing] = useState<string | null>(null);
  const [adding, setAdding] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mediaType = target?.kind === 'movie' ? 'movie' : target?.seriesType === 'anime' ? 'anime' : 'tv';

  useEffect(() => {
    if (settings && !profileId) setProfileId(settings.defaultProfiles[mediaType] ?? profiles[0]?.id ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, profiles]);
  useEffect(() => {
    if (settings) setProfileId(settings.defaultProfiles[mediaType] ?? profileId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaType]);

  // Deep link from the library: /search?kind=series&id=12&season=2
  useEffect(() => {
    const id = params.get('id');
    if (!id) return;
    const k = params.get('kind') === 'movie' ? 'movie' : 'series';
    setKind(k);
    (k === 'movie' ? api.movie(Number(id)).then((m) => ({ kind: 'movie' as const, arrId: m.id, title: `${m.title} (${m.year})`, poster: m.poster })) : api.seriesById(Number(id)).then((s) => ({ kind: 'series' as const, arrId: s.id, title: s.title, poster: s.poster, seriesType: s.seriesType, seasons: s.seasons })))
      .then((t) => {
        setTarget(t);
        if (t.kind === 'series' && !params.get('season') && !params.get('episode')) setSeason(t.seasons?.filter((x) => x.seasonNumber > 0).slice(-1)[0]?.seasonNumber ?? '');
      })
      .catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const doLookup = async () => {
    if (!q.trim()) return;
    setError(null);
    setLookup(null);
    setResults(null);
    setTarget(null);
    if (kind === 'prowlarr') return doReleaseSearch({ kind: 'prowlarr', q, category: 'all' });
    setLooking(true);
    try {
      setLookup(await api.lookup(q, kind));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLooking(false);
    }
  };

  const doReleaseSearch = async (p: Record<string, string | number | undefined>) => {
    setSearching(true);
    setError(null);
    setResults(null);
    try {
      setResults(await api.releases({ ...p, all: showAll ? 1 : undefined }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSearching(false);
    }
  };

  const searchTarget = () => {
    if (!target) return;
    if (target.kind === 'movie') return doReleaseSearch({ kind: 'movie', id: target.arrId });
    if (episodeId !== '') return doReleaseSearch({ kind: 'episode', episodeId });
    if (season === '') return toast('warn', 'Pick a season first');
    return doReleaseSearch({ kind: 'season', seriesId: target.arrId, season });
  };

  const pick = async (r: LookupResult) => {
    setError(null);
    if (r.inLibrary && r.arrId) {
      if (r.kind === 'movie') setTarget({ kind: 'movie', arrId: r.arrId, title: `${r.title} (${r.year})`, poster: r.poster });
      else {
        const s = await api.seriesById(r.arrId);
        setTarget({ kind: 'series', arrId: s.id, title: s.title, poster: s.poster, seriesType: s.seriesType, seasons: s.seasons });
        setSeason(s.seasons.filter((x) => x.seasonNumber > 0).slice(-1)[0]?.seasonNumber ?? '');
      }
      setLookup(null);
      return;
    }
    // Not in the library yet: add it to Radarr/Sonarr first (monitored, no auto search).
    setAdding(r.externalId);
    try {
      const guessAnime = r.kind === 'series' && (r.seriesType === 'anime' || /anime|japan/i.test(r.overview));
      const added = await api.addToArr({ kind: r.kind, externalId: r.externalId, seriesType: guessAnime ? 'anime' : 'standard' });
      toast('info', `Added ${r.title} to ${r.kind === 'movie' ? 'Radarr' : 'Sonarr'}`);
      if (r.kind === 'movie') setTarget({ kind: 'movie', arrId: added.id, title: `${r.title} (${r.year})`, poster: r.poster });
      else {
        const s = added as Series;
        setTarget({ kind: 'series', arrId: s.id, title: s.title, poster: s.poster, seriesType: s.seriesType, seasons: s.seasons });
        setSeason(s.seasons.filter((x) => x.seasonNumber > 0).slice(-1)[0]?.seasonNumber ?? '');
      }
      setLookup(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAdding(null);
    }
  };

  const grab = async (r: Release) => {
    if (!profileId) return toast('warn', 'Pick an encoding profile first');
    setGrabbing(r.guid);
    try {
      const res = await api.grab({
        release: r,
        profileId,
        title: target?.title ?? r.title,
        poster: target?.poster,
        arrId: target?.arrId,
        seasonNumber: target?.kind === 'series' && season !== '' ? season : undefined,
        episodeIds: episodeId !== '' ? [episodeId] : r.episodeIds,
      });
      toast('info', res.note ?? `Grabbed. rexarr will encode it once ${r.source === 'radarr' ? 'Radarr' : 'Sonarr'} imports the download.`);
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setGrabbing(null);
    }
  };

  const disabled = (k: Kind) => (k === 'movie' ? !settings?.radarr.enabled : k === 'series' ? !settings?.sonarr.enabled : !settings?.prowlarr.enabled);

  return (
    <Page title="Search" toolbarLeft={<ToolbarText>{settings?.remuxOnly ? 'Showing Blu-ray remux releases only' : 'Showing all releases'}</ToolbarText>}>
      <div className="card mb">
        <div className="card-b">
          <div className="inline" style={{ gap: 10 }}>
            <div className="seg">
              {(['movie', 'series', 'prowlarr'] as Kind[]).map((k) => (
                <button
                  key={k}
                  className={kind === k ? 'active' : ''}
                  disabled={disabled(k)}
                  title={disabled(k) ? 'Not configured in Settings' : ''}
                  onClick={() => {
                    setKind(k);
                    setTarget(null);
                    setLookup(null);
                    setResults(null);
                    setParams({});
                  }}
                >
                  {k === 'movie' ? 'Movie (Radarr)' : k === 'series' ? 'Series (Sonarr)' : 'Raw (Prowlarr)'}
                </button>
              ))}
            </div>
            <input type="search" style={{ flex: 1, minWidth: 240 }} placeholder={kind === 'prowlarr' ? 'Search all indexers, e.g. "Blade Runner 2049 remux"' : kind === 'movie' ? 'Movie title…' : 'Series title…'} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && doLookup()} />
            <button className="btn primary" onClick={doLookup} disabled={looking || searching}>
              {looking || (kind === 'prowlarr' && searching) ? <span className="spinner" /> : <Icon.Search />} Search
            </button>
            <label className="check small">
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Include non-remux
            </label>
          </div>
          {!settings?.radarr.enabled && !settings?.sonarr.enabled && (
            <div className="warn mt">
              No *arr apps are connected yet. Configure Radarr and Sonarr in <Link to="/settings">Settings</Link>.
            </div>
          )}
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {lookup && (
        <div className="card mb">
          <div className="card-h">
            Results for “{q}” <span className="dim small">· pick a title to search its releases</span>
          </div>
          {lookup.length === 0 && <div className="empty">No matches.</div>}
          {lookup.slice(0, 12).map((r) => (
            <div key={`${r.kind}-${r.externalId}`} className="list-row">
              <div className="thumb" style={{ backgroundImage: r.poster ? `url(${r.poster})` : undefined }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>
                  {r.title} <span className="dim">({r.year})</span> {r.seriesType === 'anime' && <span className="badge purple">Anime</span>}
                </div>
                <div className="small dim truncate" style={{ maxWidth: 700 }}>
                  {r.overview}
                </div>
              </div>
              {r.inLibrary ? <span className="badge green">In library</span> : <span className="badge muted">Not added</span>}
              <button className="btn sm primary" onClick={() => pick(r)} disabled={adding === r.externalId}>
                {adding === r.externalId ? <span className="spinner" /> : r.inLibrary ? <Icon.Search /> : <Icon.Plus />} {r.inLibrary ? 'Find remux' : 'Add & find remux'}
              </button>
            </div>
          ))}
        </div>
      )}

      {target && (
        <div className="card mb">
          <div className="list-row" style={{ borderBottom: '1px solid var(--border)' }}>
            <div className="thumb" style={{ backgroundImage: target.poster ? `url(${target.poster})` : undefined }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 16 }}>
                {target.title} {target.seriesType === 'anime' && <span className="badge purple">Anime</span>}
              </div>
              <div className="small dim">{target.kind === 'movie' ? 'Interactive search via Radarr' : 'Interactive search via Sonarr'}</div>
            </div>
            {target.kind === 'series' && (
              <>
                <select style={{ width: 160 }} value={season} onChange={(e) => { setSeason(e.target.value === '' ? '' : Number(e.target.value)); setEpisodeId(''); }}>
                  <option value="">Season…</option>
                  {target.seasons?.map((s) => (
                    <option key={s.seasonNumber} value={s.seasonNumber}>
                      {s.seasonNumber === 0 ? 'Specials' : `Season ${s.seasonNumber}`} ({s.episodeFileCount}/{s.episodeCount})
                    </option>
                  ))}
                </select>
                {episodeId !== '' && <span className="badge blue">Single episode #{episodeId}</span>}
              </>
            )}
            <div style={{ width: 260 }}>
              <ProfileSelect profiles={profiles} value={profileId} onChange={setProfileId} mediaType={mediaType} />
            </div>
            <button className="btn primary" onClick={searchTarget} disabled={searching}>
              {searching ? <span className="spinner" /> : <Icon.Search />} Find releases
            </button>
          </div>
          {searching && <LoadingIndicator>Asking every indexer… this can take up to a minute.</LoadingIndicator>}
          {results && (
            <>
              <div className="card-h" style={{ borderTop: 'none' }}>
                <span>
                  {results.releases.length} release(s) shown · {results.remux} remux of {results.total} total
                </span>
                <span className="spacer" />
                <span className="small dim">Grab sends the release to {target.kind === 'movie' ? 'Radarr' : 'Sonarr'}; rexarr encodes with “{profiles.find((p) => p.id === profileId)?.name}” once imported.</span>
              </div>
              <ReleaseTable releases={results.releases} onGrab={grab} busyGuid={grabbing} />
            </>
          )}
        </div>
      )}

      {kind === 'prowlarr' && results && !target && (
        <div className="card">
          <div className="card-h">
            {results.releases.length} release(s) · {results.remux} remux of {results.total}
            <span className="spacer" />
            <div style={{ width: 260 }}>
              <ProfileSelect profiles={profiles} value={profileId} onChange={setProfileId} />
            </div>
          </div>
          <div className="info" style={{ margin: 12 }}>
            Prowlarr grabs go straight to your download client and are not imported by Radarr/Sonarr, so rexarr cannot track them automatically. Queue the finished file from the library or a job with a file path.
          </div>
          <ReleaseTable releases={results.releases} onGrab={grab} busyGuid={grabbing} />
        </div>
      )}
    </Page>
  );
}
