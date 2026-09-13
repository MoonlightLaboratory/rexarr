import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { DiscDrive, DiscRip, LookupResult, MakemkvInfo, RipMedia, RipOptions, RipStatus } from '@shared/types';
import { api, fmtAge, fmtBytes, fmtDuration } from '../api';
import { useApp } from '../App';
import { Page, ToolbarButton } from '../components/Layout';
import { Icon } from '../components/Icons';
import { Modal } from '../components/Modal';
import { ProfileSelect } from '../components/ProfileSelect';

const STATUS_LABEL: Record<RipStatus, string> = { inserted: 'Inserted', scanning: 'Reading disc', ready: 'Ready to rip', ripping: 'Ripping', transcoding: 'Transcoding', delivering: 'Importing', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' };
const STATUS_CLASS: Record<RipStatus, string> = { inserted: 'blue', scanning: 'teal', ready: 'green', ripping: 'remux', transcoding: 'remux', delivering: 'teal', done: 'green', failed: 'red', cancelled: 'muted' };
const ACTIVE: RipStatus[] = ['inserted', 'scanning', 'ready', 'ripping', 'transcoding', 'delivering'];

function DriveRow({ d, onEject, busy }: { d: DiscDrive; onEject: () => void; busy: boolean }) {
  const cls = d.state === 'loaded' ? 'green' : d.state === 'open' ? 'blue' : d.state === 'loading' ? 'teal' : 'muted';
  return (
    <div className="list-row">
      <Icon.Disc />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{d.name || `Drive ${d.index}`}</div>
        <div className="small muted">{d.path}</div>
      </div>
      {d.discLabel && <span className="badge remux">{d.discLabel}</span>}
      <span className={`badge ${cls}`}>{d.state}</span>
      <button className="iconButton" onClick={onEject} disabled={busy} title="Eject">
        <Icon.Eject />
      </button>
    </div>
  );
}

function IdentifyBox({ media, discType, onChange }: { media: RipMedia; discType: string; onChange: (m: Partial<RipMedia>) => void }) {
  const { settings } = useApp();
  const [q, setQ] = useState(media.title);
  const [results, setResults] = useState<LookupResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const kind = media.kind === 'series' ? 'series' : 'movie';
  const canSearch = kind === 'movie' ? settings?.radarr.enabled : settings?.sonarr.enabled;

  const search = async () => {
    if (!q.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      setResults(await api.lookup(q, kind));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const pick = (r: LookupResult) => {
    onChange({ kind: r.kind, title: r.title, year: r.year, externalId: r.externalId, arrId: r.arrId, poster: r.poster, seriesType: (r.seriesType as RipMedia['seriesType']) ?? undefined });
    setQ(r.title);
    setResults(null);
  };

  return (
    <div>
      <div className="inline mb" style={{ gap: 8 }}>
        <div className="seg">
          {(['movie', 'series'] as const).map((k) => (
            <button key={k} className={media.kind === k ? 'active' : ''} onClick={() => onChange({ kind: k, externalId: undefined, arrId: undefined })}>
              {k === 'movie' ? 'Movie' : 'Series'}
            </button>
          ))}
        </div>
        <input type="search" style={{ flex: 1, minWidth: 200 }} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} placeholder={`Search ${kind === 'movie' ? 'Radarr' : 'Sonarr'}…`} />
        <button className="btn sm" onClick={search} disabled={busy || !canSearch} title={canSearch ? '' : 'Connect Radarr / Sonarr in Settings'}>
          {busy ? <span className="spinner" /> : <Icon.Search />} Identify
        </button>
        {media.kind === 'series' && (
          <>
            <label className="small dim">Season</label>
            <input type="number" min={0} style={{ width: 70 }} value={media.seasonNumber ?? 1} onChange={(e) => onChange({ seasonNumber: Number(e.target.value) })} />
            <label className="small dim">First ep.</label>
            <input type="number" min={0} style={{ width: 70 }} value={media.episodeStart ?? 1} onChange={(e) => onChange({ episodeStart: Number(e.target.value) })} />
          </>
        )}
      </div>
      {err && <div className="error small">{err}</div>}
      <div className="list-row" style={{ padding: '6px 0', border: 'none' }}>
        <div className="thumb" style={{ backgroundImage: media.poster ? `url(${media.poster})` : undefined }} />
        <div style={{ minWidth: 0 }}>
          {media.externalId ? (
            <>
              <div style={{ fontWeight: 600 }}>
                {media.title} {media.year ? <span className="dim">({media.year})</span> : null} {media.seriesType === 'anime' && <span className="badge purple">Anime</span>}
              </div>
              <div className="small dim">
                {media.kind === 'movie' ? 'TMDB' : 'TVDB'} {media.externalId} · {media.arrId ? 'already in library' : 'will be added on import'} · {discType}
              </div>
            </>
          ) : (
            <div className="small" style={{ color: '#f5d38a' }}>
              Not identified yet – search above so the files are named correctly and can be imported. Current guess: “{media.title || '?'}”.
            </div>
          )}
        </div>
      </div>
      {results && (
        <div className="card mb" style={{ maxHeight: 260, overflow: 'auto' }}>
          {results.length === 0 && <div className="empty">No matches.</div>}
          {results.slice(0, 8).map((r) => (
            <div key={`${r.kind}-${r.externalId}`} className="list-row" style={{ padding: '6px 12px' }}>
              <div className="thumb" style={{ width: 28, height: 42, backgroundImage: r.poster ? `url(${r.poster})` : undefined }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontWeight: 600 }}>{r.title}</span> <span className="dim">({r.year})</span> {r.inLibrary && <span className="badge green">In library</span>}
              </div>
              <button className="btn sm primary" onClick={() => pick(r)}>
                Use
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RipCard({ rip, onLog }: { rip: DiscRip; onLog: (r: DiscRip) => void }) {
  const { profiles, toast } = useApp();
  const [media, setMedia] = useState<RipMedia>(rip.media);
  const [selected, setSelected] = useState<number[]>(rip.selectedTitleIds);
  const [profileId, setProfileId] = useState(rip.profileId ?? '');
  const [options, setOptions] = useState<RipOptions>(rip.options);
  const [busy, setBusy] = useState(false);
  const editable = ['ready', 'failed', 'cancelled'].includes(rip.status);

  // Re-sync the draft whenever the server changes the rip (scan finished, identification, etc.).
  useEffect(() => {
    setMedia(rip.media);
    setSelected(rip.selectedTitleIds);
    setProfileId(rip.profileId ?? '');
    setOptions(rip.options);
  }, [rip.id, rip.status, rip.titles.length, rip.media.externalId, rip.profileId]);

  const mediaType = media.kind === 'series' ? (media.seriesType === 'anime' ? 'anime' : 'tv') : 'movie';
  const totalSelected = rip.titles.filter((t) => selected.includes(t.id)).reduce((a, t) => a + t.sizeBytes, 0);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast('info', ok);
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const start = () => act(() => api.startRip(rip.id, { media, selectedTitleIds: selected, profileId: profileId || undefined, options }), 'Rip started');
  const changeMedia = (m: Partial<RipMedia>) => {
    setMedia((x) => {
      const next = { ...x, ...m };
      if (m.kind && m.kind !== x.kind && rip.titles.length) {
        setSelected(m.kind === 'series' ? rip.titles.map((t) => t.id) : [[...rip.titles].sort((a, b) => b.durationSeconds - a.durationSeconds)[0].id]);
      }
      return next;
    });
  };

  const active = ACTIVE.includes(rip.status);
  return (
    <div className="card mb">
      <div className="card-h">
        <Icon.Disc />
        <span>{rip.media.title || rip.label || 'Unknown disc'}</span>
        {rip.media.year && <span className="dim">({rip.media.year})</span>}
        <span className={`badge ${STATUS_CLASS[rip.status]}`}>{STATUS_LABEL[rip.status]}</span>
        <span className="badge">{rip.discType === 'bluray' ? 'Blu-ray' : rip.discType === 'dvd' ? 'DVD' : 'Disc'}</span>
        {rip.label && <span className="small muted mono">{rip.label}</span>}
        <span className="spacer" />
        <span className="small muted">
          {rip.driveName} · {fmtAge(rip.createdAt)}
        </span>
        <button className="iconButton" title="Log" onClick={() => onLog(rip)}>
          <Icon.Terminal />
        </button>
        {editable && (
          <button className="iconButton" title="Re-read disc" onClick={() => act(() => api.scanRip(rip.id))} disabled={busy}>
            <Icon.Refresh />
          </button>
        )}
        {active && rip.status !== 'ready' && (
          <button className="iconButton danger" title="Cancel" onClick={() => act(() => api.cancelRip(rip.id), 'Cancelled')} disabled={busy}>
            <Icon.X />
          </button>
        )}
        {!active || rip.status === 'ready' ? (
          <button className="iconButton" title="Remove" onClick={() => act(() => api.removeRip(rip.id))} disabled={busy}>
            <Icon.Trash />
          </button>
        ) : null}
      </div>

      {rip.status === 'scanning' && (
        <div className="empty">
          <span className="spinner" /> Reading the disc with MakeMKV… this takes a minute or two for a Blu-ray.
        </div>
      )}
      {rip.status === 'failed' && <div className="error" style={{ margin: 14 }}>{rip.error}</div>}

      {(rip.status === 'ripping' || rip.status === 'transcoding' || rip.status === 'delivering') && (
        <div className="card-b" style={{ paddingBottom: 6 }}>
          <div className="progress md">
            <div style={{ width: `${rip.status === 'ripping' ? rip.progress.percent : 100}%` }} />
            {rip.status === 'ripping' && <span className="text">{rip.progress.percent.toFixed(0)}%</span>}
          </div>
          <div className="small dim" style={{ marginTop: 4 }}>
            {rip.status === 'ripping' && (
              <>
                Title {rip.progress.titleIndex}/{rip.progress.titleCount} · {rip.progress.percent.toFixed(1)}% {rip.progress.step && `· ${rip.progress.step}`}
              </>
            )}
            {rip.status === 'transcoding' && (
              <>
                Encoding {rip.files.length} file(s) with {rip.profileName} – follow progress in <Link to="/activity">Activity</Link>.
              </>
            )}
            {rip.status === 'delivering' && 'Handing files to Radarr / Sonarr…'}
          </div>
        </div>
      )}

      {editable && rip.titles.length > 0 && (
        <div className="card-b">
          <IdentifyBox media={media} discType={rip.discType} onChange={changeMedia} />
          <div className="tbl-wrap mt">
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 30 }}>
                    <input type="checkbox" checked={selected.length === rip.titles.length} onChange={(e) => setSelected(e.target.checked ? rip.titles.map((t) => t.id) : [])} />
                  </th>
                  <th>#</th>
                  <th>Title</th>
                  <th>Length</th>
                  <th className="num">Size</th>
                  <th>Chapters</th>
                  <th>Video</th>
                  <th>Audio</th>
                  <th>Subs</th>
                </tr>
              </thead>
              <tbody>
                {rip.titles.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <input type="checkbox" checked={selected.includes(t.id)} onChange={(e) => setSelected((s) => (e.target.checked ? [...s, t.id].sort((a, b) => a - b) : s.filter((x) => x !== t.id)))} />
                    </td>
                    <td className="mono dim">{t.id}</td>
                    <td>
                      {t.name}
                      {t.sourceFile && <span className="small muted"> · {t.sourceFile}</span>}
                    </td>
                    <td className="mono">{fmtDuration(t.durationSeconds)}</td>
                    <td className="num dim">{fmtBytes(t.sizeBytes)}</td>
                    <td className="dim">{t.chapters || '—'}</td>
                    <td className="dim small">
                      {t.videoCodec} {t.resolution}
                    </td>
                    <td className="dim small" title={t.audio.join('\n')}>
                      {t.audio.length ? `${t.audio.length}: ${t.audio.slice(0, 2).join(', ')}${t.audio.length > 2 ? '…' : ''}` : '—'}
                    </td>
                    <td className="dim small" title={t.subtitles.join('\n')}>
                      {t.subtitles.length || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="inline mt" style={{ gap: 14 }}>
            <div style={{ width: 280 }}>
              <ProfileSelect profiles={profiles} value={profileId} onChange={setProfileId} mediaType={mediaType} />
            </div>
            <label className="check">
              <input type="checkbox" checked={options.transcode} onChange={(e) => setOptions({ ...options, transcode: e.target.checked })} /> Transcode
            </label>
            <label className="check">
              <input type="checkbox" checked={options.deliver} onChange={(e) => setOptions({ ...options, deliver: e.target.checked })} /> Import into {media.kind === 'series' ? 'Sonarr' : 'Radarr'}
            </label>
            <label className="check">
              <input type="checkbox" checked={options.eject} onChange={(e) => setOptions({ ...options, eject: e.target.checked })} /> Eject when done
            </label>
            <label className="check">
              <input type="checkbox" checked={options.keepRaw} onChange={(e) => setOptions({ ...options, keepRaw: e.target.checked })} /> Keep raw rip
            </label>
            <span className="spacer" />
            <span className="small dim">
              {selected.length} title(s) · {fmtBytes(totalSelected)}
            </span>
            <button className="btn primary" onClick={start} disabled={busy || !selected.length || (options.transcode && !profileId)}>
              {busy ? <span className="spinner" /> : <Icon.Play />} {rip.status === 'ready' ? 'Rip' : 'Rip again'}
            </button>
          </div>
        </div>
      )}
      {editable && rip.titles.length === 0 && rip.status !== 'failed' && <div className="empty">No titles found on this disc (all shorter than the minimum length?).</div>}

      {rip.files.length > 0 && (
        <div className="card-b" style={{ borderTop: '1px solid var(--border)' }}>
          <div className="small dim mb">Files</div>
          {rip.files.map((f) => (
            <div key={f.titleId} className="small mono truncate" title={f.finalPath ?? f.path}>
              {f.finalPath ?? f.path} <span className="dim">({fmtBytes(f.sizeBytes)})</span>
              {f.jobId && !f.finalPath && <span className="badge blue" style={{ marginLeft: 6 }}>encoding</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LogModal({ rip, onClose }: { rip: DiscRip; onClose: () => void }) {
  const { rips } = useApp();
  const live = rips.find((r) => r.id === rip.id) ?? rip;
  return (
    <Modal title={`Log · ${live.media.title || live.label}`} onClose={onClose} wide>
      <div className="log">
        {live.log.map((l, i) => (
          <div key={i} className={/fail|error/i.test(l) ? 'err-line' : ''}>
            {l}
          </div>
        ))}
        {!live.log.length && <span className="muted">No log yet.</span>}
      </div>
    </Modal>
  );
}

export function DiscsPage() {
  const { rips, drives, settings, toast } = useApp();
  const [makemkv, setMakemkv] = useState<MakemkvInfo | null>(null);
  const [driveError, setDriveError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'active' | 'history'>('active');
  const [logRip, setLogRip] = useState<DiscRip | null>(null);

  const refresh = (force = false) => {
    setBusy(true);
    api.discStatus(force)
      .then((s) => {
        setMakemkv(s.makemkv);
        setDriveError(s.driveError);
      })
      .catch((e) => toast('error', e.message))
      .finally(() => setBusy(false));
  };
  useEffect(() => refresh(false), []); // eslint-disable-line react-hooks/exhaustive-deps

  const active = useMemo(() => rips.filter((r) => ACTIVE.includes(r.status)), [rips]);
  const history = useMemo(() => rips.filter((r) => !ACTIVE.includes(r.status)), [rips]);
  const list = tab === 'active' ? active : history;

  return (
    <Page
      title="Discs"
      toolbarLeft={
        <>
          <ToolbarButton icon={<Icon.Disc />} label="Detect disc" wide disabled={busy || !makemkv?.available} onClick={() => api.detectDiscs().then((r) => toast('info', r.created.length ? `Found ${r.created.length} disc(s)` : 'No new disc in any drive')).catch((e) => toast('error', e.message))} />
          <ToolbarButton icon={<Icon.Refresh />} label="Refresh" busy={busy} onClick={() => refresh(true)} title="Re-detect drives" />
        </>
      }
    >
      {settings && !settings.disc.enabled && (
        <div className="info">
          Automatic disc detection is off. Turn on <strong>Disc ripping</strong> in <Link to="/settings">Settings</Link>, or use “Detect disc now” for a one-off rip.
        </div>
      )}
      {makemkv && !makemkv.available && (
        <div className="error">
          MakeMKV not found at “{makemkv.path}”. Install MakeMKV and set the makemkvcon path in <Link to="/settings">Settings</Link>. {makemkv.error}
        </div>
      )}
      {driveError && <div className="warn">Could not list drives: {driveError}</div>}

      <div className="card mb">
        <div className="card-h">
          Drives
          <span className="spacer" />
          {makemkv?.available && <span className="small dim">MakeMKV {makemkv.version ?? ''} · {makemkv.path}</span>}
        </div>
        {drives.length === 0 && <div className="empty">No optical drives detected.</div>}
        {drives.map((d) => (
          <DriveRow key={d.index} d={d} busy={busy} onEject={() => api.ejectDrive(d.index).then(() => toast('info', 'Ejecting')).catch((e) => toast('error', e.message))} />
        ))}
      </div>

      <div className="tabs">
        <button className={tab === 'active' ? 'active' : ''} onClick={() => setTab('active')}>
          Current ({active.length})
        </button>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
          History ({history.length})
        </button>
      </div>
      {list.length === 0 && (
        <div className="card">
          <div className="empty">
            <h3>{tab === 'active' ? 'No disc in progress' : 'No rips yet'}</h3>
            <p>{tab === 'active' ? 'Insert a Blu-ray or DVD. rexarr reads it, identifies it, rips it with MakeMKV, transcodes it with your profile and hands it to Radarr / Sonarr.' : 'Finished, failed and cancelled rips show up here.'}</p>
          </div>
        </div>
      )}
      {list.map((r) => (
        <RipCard key={r.id} rip={r} onLog={setLogRip} />
      ))}
      {logRip && <LogModal rip={logRip} onClose={() => setLogRip(null)} />}
    </Page>
  );
}
