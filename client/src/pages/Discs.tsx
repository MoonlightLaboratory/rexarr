import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { MusicBrainzRelease, DriveCandidate, DiscDrive, DiscRip, Episode, LookupResult, MakemkvInfo, RipMedia, RipOptions, RipStatus } from '@shared/types';
import { api, fmtAge, fmtBytes, fmtDuration, ripOverallPercent } from '../api';
import { useApp } from '../App';
import { Page, ToolbarButton } from '../components/Layout';
import { Icon } from '../components/Icons';
import { Modal } from '../components/Modal';
import { ProfileSelect } from '../components/ProfileSelect';

/** Pick an .iso / .img or a DVD / Blu-ray folder from the server's filesystem and link it as a virtual drive (or rip it once). */
function OpenImageModal({ onClose, onOpened }: { onClose: () => void; onOpened: () => void }) {
  const { toast } = useApp();
  const [path, setPath] = useState('');
  const [label, setLabel] = useState('');
  const [dir, setDir] = useState<{ path: string; parent: string | null; entries: { name: string; dir: boolean; path: string }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const browse = (p: string) =>
    api.fsList(p)
      .then(setDir)
      .catch((e) => toast('error', e.message));
  useEffect(() => {
    browse(localStorage.getItem('rexarr.lastImageDir') || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const open = async (p: string, link = true) => {
    setBusy(true);
    try {
      if (link) {
        await api.addVirtualDrive(p, label || undefined);
        toast('info', 'Virtual drive added – it now behaves like an inserted disc');
      } else {
        await api.openImage(p);
        toast('info', 'Reading disc image…');
      }
      if (dir) localStorage.setItem('rexarr.lastImageDir', dir.path);
      onOpened();
      onClose();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const isDisc = (e: { name: string; dir: boolean }) => (!e.dir && /\.(iso|img)$/i.test(e.name)) || (e.dir && /^(VIDEO_TS|BDMV)$/i.test(e.name));
  return (
    <Modal
      title="Add virtual drive"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={busy || !path.trim()} onClick={() => open(path, false)} title="Rip this image once without keeping it as a drive">
            <Icon.Play /> Rip once
          </button>
          <button className="btn primary" disabled={busy || !path.trim()} onClick={() => open(path, true)}>
            {busy ? <span className="spinner" /> : <Icon.DriveAdd />} Add drive
          </button>
        </>
      }
    >
      <div className="grid-2">
        <div className="field stack">
          <label>Image file or disc folder</label>
          <input type="text" value={path} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && path.trim() && open(path, true)} placeholder="/Volumes/Backup/MY_MOVIE.iso  or  …/MY_MOVIE/BDMV" autoFocus />
          <div className="help">An .iso / .img, or a folder containing BDMV (Blu-ray) or VIDEO_TS (DVD). Linking a BDMV folder itself works too.</div>
        </div>
        <div className="field stack">
          <label>Label (optional)</label>
          <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Defaults to the file name" />
          <div className="help">Shown as the disc label and used for identification, like a real disc's volume name.</div>
        </div>
      </div>
      <div className="info small">A virtual drive is treated exactly like an optical drive with that disc inserted: it is scanned by MakeMKV, identified, and ripped (automatically when auto-rip is on). Ejecting it removes the link; the file stays where it is.</div>
      {dir && (
        <div className="card" style={{ maxHeight: 320, overflow: 'auto' }}>
          <div className="list-row" style={{ padding: '6px 12px', cursor: dir.parent ? 'pointer' : 'default' }} onClick={() => dir.parent && browse(dir.parent)}>
            <Icon.Folder />
            <span className="truncate" style={{ flex: 1 }}>
              {dir.path}
            </span>
            {dir.parent && <span className="small dim">↑ up</span>}
          </div>
          {dir.entries
            .filter((e) => e.dir || isDisc(e))
            .map((e) => (
              <div key={e.path} className="list-row" style={{ padding: '6px 12px 6px 28px', cursor: 'pointer' }} onClick={() => (isDisc(e) ? setPath(e.dir ? dir.path : e.path) : browse(e.path))} onDoubleClick={() => isDisc(e) && open(e.dir ? dir.path : e.path)}>
              {e.dir ? <Icon.Folder /> : <Icon.Disc />}
              <span className="truncate" style={{ flex: 1 }}>
                {e.name}
              </span>
              {isDisc(e) && <span className="badge purple sm">{e.dir ? 'disc folder' : 'image'}</span>}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

const STATUS_LABEL: Record<RipStatus, string> = { inserted: 'Inserted', scanning: 'Reading disc', ready: 'Ready to rip', ripping: 'Ripping', transcoding: 'Transcoding', delivering: 'Importing', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' };
const STATUS_CLASS: Record<RipStatus, string> = { inserted: 'blue', scanning: 'teal', ready: 'green', ripping: 'remux', transcoding: 'remux', delivering: 'teal', done: 'green', failed: 'red', cancelled: 'muted' };
const ACTIVE: RipStatus[] = ['inserted', 'scanning', 'ready', 'ripping', 'transcoding', 'delivering'];

/** Add a real optical drive by its device path. */
function AddDriveModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const { toast } = useApp();
  const [path, setPath] = useState('');
  const [label, setLabel] = useState('');
  const [candidates, setCandidates] = useState<DriveCandidate[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.driveCandidates().then(setCandidates).catch(() => setCandidates([]));
  }, []);
  const add = async () => {
    setBusy(true);
    try {
      await api.addPhysicalDrive(path.trim(), label.trim() || undefined);
      toast('info', `Drive ${path.trim()} added`);
      onAdded();
      onClose();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Add optical drive"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !path.trim()} onClick={add}>
            {busy ? <span className="spinner" /> : <Icon.Disc />} Add drive
          </button>
        </>
      }
    >
      <div className="grid-2">
        <div className="field stack">
          <label>Device path</label>
          <input type="text" value={path} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && path.trim() && add()} placeholder="/dev/sr0" autoFocus />
          <div className="help">Linux: <code>/dev/sr0</code>, <code>/dev/cdrom</code> or a stable <code>/dev/disk/by-id/…</code> path. macOS: <code>/dev/disk4</code>.</div>
        </div>
        <div className="field stack">
          <label>Name (optional)</label>
          <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. LG WH16NS60 (USB)" />
          <div className="help">Shown on the Discs page and in the sidebar.</div>
        </div>
      </div>
      <div className="legend small" style={{ marginBottom: 8 }}>
        Found on this machine
      </div>
      {candidates === null && <span className="spinner" />}
      {candidates?.length === 0 && <div className="small dim mb">No optical devices found. In Docker, pass the drive with <code>--device /dev/sr0 --device /dev/sg0</code> (the <code>sg</code> node is needed for Blu-ray) and use the MakeMKV image.</div>}
      {candidates && candidates.length > 0 && (
        <div className="card flat mb">
          {candidates.map((c) => (
            <div key={`${c.path}-${c.name}`} className={`list-row${c.path && path === c.path ? ' selected' : ''}`} style={{ padding: '8px 12px', cursor: c.path ? 'pointer' : 'default' }} onClick={() => c.path && setPath(c.path)}>
              <Icon.Disc />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div>{c.name}</div>
                {c.note && <div className="small dim">{c.note}</div>}
              </div>
              <code className="small">{c.path || '—'}</code>
            </div>
          ))}
        </div>
      )}
      <div className="info small">
        Use this when MakeMKV does not list a drive on its own (USB enclosures, drives passed into Docker, or picking one of several). Rexarr checks the tray itself and reads the disc through MakeMKV's <code>dev:</code> source. MakeMKV needs read access to the device (run as root or add the user to the <code>cdrom</code> / <code>optical</code> group).
      </div>
    </Modal>
  );
}

function DriveRow({ d, onEject, onRemove, onReadCd, busy }: { d: DiscDrive; onEject: () => void; onRemove?: () => void; onReadCd?: () => void; busy: boolean }) {
  const cls = d.state === 'loaded' ? 'green' : d.state === 'open' ? 'blue' : d.state === 'loading' ? 'teal' : 'muted';
  const linked = Boolean(d.virtualId);
  return (
    <div className="list-row">
      {d.virtual ? <Icon.HardDrive /> : <Icon.Disc />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{d.name || `Drive ${d.index}`}</div>
        <div className="small muted truncate" title={d.path}>
          {d.path}
          {d.manualId && d.detected === false && d.available !== false && ' · checked by Rexarr (not listed by MakeMKV)'}
        </div>
      </div>
      {d.virtual && <span className="badge purple">{linked ? 'virtual' : 'folder'}</span>}
      {d.manualId && <span className="badge blue" title="Added by device path">added</span>}
      {d.available === false && <span className="badge red">{d.manualId ? 'device not found' : 'file missing'}</span>}
      {d.discLabel && <span className="badge remux">{d.discLabel}</span>}
      <span className={`badge ${cls}`}>{d.state}</span>
      {onReadCd && !d.virtual && (
        <button className="iconButton" onClick={onReadCd} disabled={busy || d.available === false} title="Read audio CD (fre:ac + MusicBrainz)">
          <Icon.Music />
        </button>
      )}
      <button className="iconButton" onClick={onEject} disabled={busy || (d.virtual && !linked) || d.available === false} title={linked ? 'Eject (remove this virtual drive)' : d.virtual ? 'Folder-scanned disc: remove the file from the folder instead' : 'Eject'}>
        <Icon.Eject />
      </button>
      {onRemove && (
        <button className="iconButton danger" onClick={onRemove} disabled={busy} title="Remove this drive from Rexarr">
          <Icon.Trash />
        </button>
      )}
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
            <label className="check small" title="Anime: name files 'Show - 005' instead of 'Show - S01E05'">
              <input type="checkbox" checked={Boolean(media.absoluteNumbering)} onChange={(e) => onChange({ absoluteNumbering: e.target.checked })} /> Absolute numbering
            </label>
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

/** Audio CD: MusicBrainz match, tracks, music profile. */
function CdBody({ rip, busy, act }: { rip: DiscRip; busy: boolean; act: (fn: () => Promise<unknown>, ok?: string) => Promise<void> }) {
  const { profiles, settings } = useApp();
  const [selected, setSelected] = useState<number[]>(rip.selectedTitleIds);
  const [profileId, setProfileId] = useState(rip.profileId ?? '');
  const [transcode, setTranscode] = useState(Boolean(rip.options.transcode));
  const [eject, setEject] = useState(rip.options.eject);
  const [deliver, setDeliver] = useState(rip.options.deliver);
  const [q, setQ] = useState(`${rip.media.artist && rip.media.artist !== 'Unknown Artist' ? rip.media.artist : ''} ${rip.media.title === 'Unknown Album' ? '' : rip.media.title}`.trim());
  const [results, setResults] = useState<MusicBrainzRelease[] | null>(null);
  useEffect(() => setSelected(rip.selectedTitleIds), [rip.id, rip.titles.length]);
  const cd = rip.cd!;
  const rel = cd.releases[cd.selected];
  const seconds = rip.titles.filter((t) => selected.includes(t.id)).reduce((n, t) => n + t.durationSeconds, 0);
  const search = () => act(async () => setResults(await api.musicbrainzSearch(q)));
  return (
    <div className="card-b">
      <div className="cdHeader">
        <div className="cdCover">{rip.media.poster ? <img src={rip.media.poster} alt="" /> : <Icon.Disc />}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="field stack">
            <label>MusicBrainz release</label>
            {cd.releases.length > 0 ? (
              <select value={cd.selected} onChange={(e) => act(() => api.setCdRelease(rip.id, { index: Number(e.target.value) }))} disabled={busy}>
                {cd.releases.map((r, i) => (
                  <option key={r.releaseId} value={i}>
                    {r.artist} – {r.title}
                    {r.date ? ` (${r.date.slice(0, 4)}${r.country ? `, ${r.country}` : ''})` : ''}
                    {r.label ? ` · ${r.label}` : ''} · {r.tracks.length} tracks{r.discCount > 1 ? ` · disc ${r.discNumber}/${r.discCount}` : ''}
                  </option>
                ))}
              </select>
            ) : (
              <div className="warn small">No MusicBrainz release has this disc id ({cd.discId}) yet. Search by artist and album below, or rip with generic track names.</div>
            )}
            {rel && (
              <div className="help">
                <a href={`https://musicbrainz.org/release/${rel.releaseId}`} target="_blank" rel="noreferrer">
                  View on MusicBrainz
                </a>
                {rel.barcode ? ` · barcode ${rel.barcode}` : ''} · disc id <span className="mono">{cd.discId}</span>
              </div>
            )}
          </div>
          <div className="inline" style={{ flexWrap: 'nowrap' }}>
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && q.trim() && search()} placeholder="Search MusicBrainz: artist album" />
            <button className="btn" onClick={search} disabled={busy || !q.trim() || !settings?.musicbrainz.enabled}>
              <Icon.Search /> Search
            </button>
          </div>
          {results && (
            <div className="card flat mt" style={{ maxHeight: 220, overflow: 'auto' }}>
              {results.length === 0 && <div className="empty">No releases found.</div>}
              {results.map((r) => (
                <div
                  key={r.releaseId}
                  className="list-row"
                  style={{ padding: '6px 12px', cursor: 'pointer' }}
                  onClick={() =>
                    act(async () => {
                      await api.setCdRelease(rip.id, { releaseId: r.releaseId });
                      setResults(null);
                    }, `Using ${r.title}`)
                  }
                >
                  <span className="truncate" style={{ flex: 1 }}>
                    {r.artist} – {r.title}
                  </span>
                  <span className="small dim">
                    {r.date?.slice(0, 4)} {r.country} · {r.tracks.length} tracks
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="tbl-wrap mt">
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 30 }}>
                <input type="checkbox" checked={selected.length === rip.titles.length} onChange={(e) => setSelected(e.target.checked ? rip.titles.map((t) => t.id) : [])} />
              </th>
              <th className="num">#</th>
              <th>Title</th>
              <th>Artist</th>
              <th className="num">Length</th>
            </tr>
          </thead>
          <tbody>
            {rip.titles.map((t) => {
              const mt = rel?.tracks.find((x) => x.number === t.id);
              return (
                <tr key={t.id}>
                  <td>
                    <input type="checkbox" checked={selected.includes(t.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, t.id].sort((a, b) => a - b) : selected.filter((x) => x !== t.id))} />
                  </td>
                  <td className="num dim">{t.id}</td>
                  <td>{mt?.title ?? t.name}</td>
                  <td className="dim">{mt?.artist && mt.artist !== rel?.artist ? mt.artist : ''}</td>
                  <td className="num dim">{fmtDuration(t.durationSeconds)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="grid-2 mt">
        <div className="field stack">
          <label>Also encode with</label>
          <ProfileSelect profiles={profiles.filter((p) => p.audio.encoder !== 'copy')} value={profileId} onChange={(v) => { setProfileId(v); setTranscode(true); }} mediaType="music" />
          <label className="check mt">
            <input type="checkbox" checked={transcode} onChange={(e) => setTranscode(e.target.checked)} /> Encode the FLAC rip with this profile (MP3 / Opus / …)
          </label>
        </div>
        <div>
          <label className="check mb">
            <input type="checkbox" checked={deliver} onChange={(e) => setDeliver(e.target.checked)} /> Import into Lidarr when done
          </label>
          <label className="check mb">
            <input type="checkbox" checked={eject} onChange={(e) => setEject(e.target.checked)} /> Eject when done
          </label>
          <div className="small dim">
            {selected.length} track(s) · {fmtDuration(seconds)} · FLAC level {settings?.disc.cd.compressionLevel ?? 8} via fre:ac{settings?.disc.cd.detectMqa ? ' · MQA scan' : ''}
          </div>
        </div>
      </div>
      <div className="inline mt">
        <span className="spacer" />
        <button className="btn primary" disabled={busy || !selected.length} onClick={() => act(() => api.startRip(rip.id, { selectedTitleIds: selected, profileId: transcode && profileId ? profileId : undefined, options: { transcode: transcode && Boolean(profileId), deliver, eject, keepRaw: false } }), 'Ripping CD')}>
          <Icon.Disc /> Rip {selected.length} track(s)
        </button>
      </div>
    </div>
  );
}

function RipCard({ rip, onLog }: { rip: DiscRip; onLog: (r: DiscRip) => void }) {
  const { profiles, toast } = useApp();
  const [media, setMedia] = useState<RipMedia>(rip.media);
  const [selected, setSelected] = useState<number[]>(rip.selectedTitleIds);
  const [profileId, setProfileId] = useState(rip.profileId ?? '');
  const [options, setOptions] = useState<RipOptions>(rip.options);
  const [episodeMap, setEpisodeMap] = useState<Record<number, number>>(rip.episodeMap ?? {});
  const [sonarrEpisodes, setSonarrEpisodes] = useState<Episode[] | null>(null);
  const [busy, setBusy] = useState(false);
  const editable = ['ready', 'failed', 'cancelled'].includes(rip.status);
  const isSeries = media.kind === 'series';

  // Episode names from Sonarr when the series is in the library.
  useEffect(() => {
    if (!isSeries || !media.arrId) {
      setSonarrEpisodes(null);
      return;
    }
    api.episodes(media.arrId, media.seasonNumber ?? 1)
      .then(setSonarrEpisodes)
      .catch(() => setSonarrEpisodes(null));
  }, [isSeries, media.arrId, media.seasonNumber]);

  /** Sequential numbering from "first episode" for every selected title that has no explicit mapping. */
  const renumber = (start: number, sel: number[], keep: Record<number, number> = {}) => {
    const next: Record<number, number> = {};
    sel.forEach((id, i) => (next[id] = keep[id] ?? start + i));
    return next;
  };

  // Re-sync the draft whenever the server changes the rip (scan finished, identification, etc.).
  useEffect(() => {
    setMedia(rip.media);
    setSelected(rip.selectedTitleIds);
    setProfileId(rip.profileId ?? '');
    setOptions(rip.options);
    setEpisodeMap(rip.episodeMap ?? {});
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
  const start = () => act(() => api.startRip(rip.id, { media, selectedTitleIds: selected, episodeMap: isSeries ? renumber(media.episodeStart ?? 1, selected, episodeMap) : undefined, profileId: profileId || undefined, options }), 'Rip started');
  const changeMedia = (m: Partial<RipMedia>) => {
    setMedia((x) => {
      const next = { ...x, ...m };
      if (m.kind && m.kind !== x.kind && rip.titles.length) {
        const sel = m.kind === 'series' ? rip.titles.filter((t) => !(rip.playAllTitleIds ?? []).includes(t.id)).map((t) => t.id) : [[...rip.titles].sort((a, b) => b.durationSeconds - a.durationSeconds)[0].id];
        setSelected(sel);
        setEpisodeMap(renumber(next.episodeStart ?? 1, sel));
      }
      if (m.episodeStart !== undefined && m.episodeStart !== x.episodeStart) setEpisodeMap(renumber(m.episodeStart, selected));
      return next;
    });
  };
  const toggleTitle = (id: number, on: boolean) => {
    const sel = on ? [...selected, id].sort((a, b) => a - b) : selected.filter((x) => x !== id);
    setSelected(sel);
    if (isSeries) setEpisodeMap((m) => renumber(media.episodeStart ?? 1, sel, on ? m : Object.fromEntries(Object.entries(m).filter(([k]) => Number(k) !== id))));
  };
  const usedTwice = (ep: number) => selected.filter((id) => episodeMap[id] === ep).length > 1;

  const active = ACTIVE.includes(rip.status);
  return (
    <div className="card mb">
      <div className="card-h">
        <Icon.Disc />
        <span className="truncate" style={{ minWidth: '10em', flexShrink: 1 }} title={rip.media.artist ? `${rip.media.artist} – ${rip.media.title}` : undefined}>
          {rip.media.artist && <span className="dim">{rip.media.artist} – </span>}
          {rip.media.title || rip.label || 'Unknown disc'}
        </span>
        {rip.media.year && <span className="dim">({rip.media.year})</span>}
        <span className={`badge ${STATUS_CLASS[rip.status]}`}>{STATUS_LABEL[rip.status]}</span>
        <span className="badge">{rip.discType === 'bluray' ? 'Blu-ray' : rip.discType === 'dvd' ? 'DVD' : rip.discType === 'cd' ? 'Audio CD' : 'Disc'}</span>
        {rip.cd?.mqa?.detected && <span className="badge purple">MQA-CD{rip.cd.mqa.originalSampleRate ? ` · ${rip.cd.mqa.originalSampleRate / 1000} kHz` : ''}</span>}
        {rip.origin === 'download' ? (
          <span className="badge purple" title={rip.arrQueue ? `Grabbed release: ${rip.arrQueue.title}` : 'Grabbed full-disc release'}>
            download
          </span>
        ) : (
          rip.virtual && <span className="badge purple">virtual</span>
        )}
        {rip.label && rip.discType !== 'cd' && <span className="small muted mono">{rip.label}</span>}
        <span className="spacer" />
        <span className="small muted truncate" style={{ minWidth: 0, flexShrink: 100 }}>
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
          <span className="spinner" /> {rip.discType === 'cd' ? 'Reading the CD table of contents and looking it up on MusicBrainz…' : 'Reading the disc with MakeMKV… this takes a minute or two for a Blu-ray.'}
        </div>
      )}
      {rip.status === 'failed' && <div className="error" style={{ margin: 14 }}>{rip.error}</div>}

      {(rip.status === 'ripping' || rip.status === 'transcoding' || rip.status === 'delivering') && (
        <div className="card-b" style={{ paddingBottom: 6 }}>
          <div className="progress md">
            <div style={{ width: `${rip.status === 'ripping' ? ripOverallPercent(rip.progress) : 100}%` }} />
            {rip.status === 'ripping' && <span className="text">{ripOverallPercent(rip.progress).toFixed(0)}%</span>}
          </div>
          <div className="small dim" style={{ marginTop: 4 }}>
            {rip.status === 'ripping' && (
              <>
                {rip.discType === 'cd' ? 'Track' : 'Title'} {rip.progress.titleIndex}/{rip.progress.titleCount} · {rip.progress.percent.toFixed(1)}% {rip.progress.step && `· ${rip.progress.step}`}
              </>
            )}
            {rip.status === 'transcoding' && (
              <>
                Encoding {rip.files.length} file(s) with {rip.profileName} – follow progress in <Link to="/activity">Activity</Link>.
              </>
            )}
            {rip.status === 'delivering' && (rip.discType === 'cd' ? 'Handing the album to Lidarr…' : 'Handing files to Radarr / Sonarr…')}
          </div>
        </div>
      )}

      {editable && rip.discType === 'cd' && <CdBody rip={rip} busy={busy} act={act} />}

      {editable && rip.discType !== 'cd' && rip.titles.length > 0 && (
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
                  {isSeries && <th style={{ minWidth: 200 }}>Episode</th>}
                  <th>Video</th>
                  <th>Audio</th>
                  <th>Subs</th>
                </tr>
              </thead>
              <tbody>
                {rip.titles.map((t) => (
                  <tr key={t.id} style={{ opacity: selected.includes(t.id) ? 1 : 0.6 }}>
                    <td>
                      <input type="checkbox" checked={selected.includes(t.id)} onChange={(e) => toggleTitle(t.id, e.target.checked)} />
                    </td>
                    <td className="mono dim">{t.id}</td>
                    <td>
                      {t.name}
                      {(rip.playAllTitleIds ?? []).includes(t.id) && <span className="badge warning sm" style={{ marginLeft: 6 }} title="This title is as long as the other titles combined – usually a 'play all' compilation">play all</span>}
                      {t.sourceFile && <span className="small muted"> · {t.sourceFile}</span>}
                    </td>
                    {isSeries && (
                      <td>
                        {selected.includes(t.id) ? (
                          sonarrEpisodes && sonarrEpisodes.length ? (
                            <select value={episodeMap[t.id] ?? ''} onChange={(e) => setEpisodeMap((m) => ({ ...m, [t.id]: Number(e.target.value) }))} style={{ height: 30, padding: '0 8px', minWidth: 240, borderColor: usedTwice(episodeMap[t.id]) ? 'var(--dangerColor)' : undefined }}>
                              <option value="">—</option>
                              {sonarrEpisodes.map((e) => (
                                <option key={e.id} value={e.episodeNumber}>
                                  E{String(e.episodeNumber).padStart(2, '0')} · {e.title}
                                  {e.hasFile ? ' ✓' : ''}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <span className="inline" style={{ gap: 6 }}>
                              <span className="small dim">{media.absoluteNumbering ? 'Ep.' : `S${String(media.seasonNumber ?? 1).padStart(2, '0')}E`}</span>
                              <input type="number" min={0} style={{ width: 70, height: 30 }} value={episodeMap[t.id] ?? ''} onChange={(e) => setEpisodeMap((m) => ({ ...m, [t.id]: Number(e.target.value) }))} />
                            </span>
                          )
                        ) : (
                          <span className="muted small">skipped</span>
                        )}
                      </td>
                    )}
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
          {isSeries && (
            <div className="small dim mt">
              Titles are numbered in disc order from “First ep.”{media.discNumber ? ` (disc ${media.discNumber} of the set)` : ''}; adjust any episode above if the disc order differs.
              {sonarrEpisodes === null && media.arrId === undefined && ' Identify the series to pick episodes by name.'}
              {media.seriesType === 'anime' && !media.absoluteNumbering && ' This is an anime series in Sonarr – turn on absolute numbering if it uses absolute episode numbers.'}
            </div>
          )}
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
  const [openImage, setOpenImage] = useState(false);
  const [addDrive, setAddDrive] = useState(false);

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
          <ToolbarButton icon={<Icon.DriveAdd />} label="Add drive" wide onClick={() => setAddDrive(true)} title="Add a real optical drive by device path (/dev/sr0)" />
          <ToolbarButton icon={<Icon.Plus />} label="Virtual drive" wide disabled={!makemkv?.available} onClick={() => setOpenImage(true)} title="Link an .iso / .img or a BDMV / VIDEO_TS folder as a virtual drive" />
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
        {drives.length === 0 && (
          <div className="empty">
            No optical drives detected. Use <strong>Add drive</strong> to add a real drive by its device path (<code>/dev/sr0</code>), or <strong>Virtual drive</strong> to link an .iso or a BDMV / VIDEO_TS folder – it behaves like an inserted disc.
          </div>
        )}
        {drives.map((d) => (
          <DriveRow
            key={d.index}
            d={d}
            busy={busy}
            onReadCd={() =>
              api.readCd(d.index)
                .then((r) => toast('info', r.cd?.releases.length ? `Audio CD: ${r.media.artist} – ${r.media.title}` : 'Audio CD read (no MusicBrainz match yet)'))
                .then(() => refresh(false))
                .catch((e) => toast('error', e.message))
            }
            onRemove={
              d.manualId
                ? () => {
                    if (!confirm(`Remove drive ${d.path} from Rexarr? The drive itself is not affected.`)) return;
                    api.removePhysicalDrive(d.manualId!)
                      .then(() => toast('info', 'Drive removed'))
                      .then(() => refresh(true))
                      .catch((e) => toast('error', e.message));
                  }
                : undefined
            }
            onEject={() => {
              if (d.virtualId && !confirm(`Remove virtual drive "${d.discLabel ?? d.path}"? The file itself is not deleted.`)) return;
              api.ejectDrive(d.index)
                .then(() => toast('info', d.virtualId ? 'Virtual drive removed' : 'Ejecting'))
                .then(() => refresh(false))
                .catch((e) => toast('error', e.message));
            }}
          />
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
            <p>{tab === 'active' ? 'Insert a Blu-ray or DVD. Rexarr reads it, identifies it, rips it with MakeMKV, transcodes it with your profile and hands it to Radarr / Sonarr.' : 'Finished, failed and cancelled rips show up here.'}</p>
          </div>
        </div>
      )}
      {list.map((r) => (
        <RipCard key={r.id} rip={r} onLog={setLogRip} />
      ))}
      {logRip && <LogModal rip={logRip} onClose={() => setLogRip(null)} />}
      {addDrive && <AddDriveModal onClose={() => setAddDrive(false)} onAdded={() => refresh(true)} />}
      {openImage && <OpenImageModal onClose={() => setOpenImage(false)} onOpened={() => { setTab('active'); refresh(false); }} />}
    </Page>
  );
}
