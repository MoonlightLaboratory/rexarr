import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { MusicBrainzRelease, DriveCandidate, DiscAudioTrack, DiscDrive, DiscEstimate, DiscRip, DiscTitle, Episode, ExtraType, LookupResult, MakemkvInfo, RipMedia, RipOptions, RipStatus, TitleRole, WantedDisc } from '@shared/types';
import { api, fmtAge, fmtBytes, fmtDuration, ripOverallPercent } from '../api';
import { batchProgress, discFreed, driveBusy, episodeNumbers, episodeRange, expectedDiscCount, missingDiscs, discPhase, sortDiscs } from '@shared/boxset';
import { useApp } from '../App';
import { Page, ToolbarButton, ToolbarSeparator } from '../components/Layout';
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

/**
 * A drive's name as something to read. MakeMKV writes it with what the drive can burn in front and its serial
 * behind - "DVD+R-DL HL-DT-ST DVDRAM GT50N LT20 M1BC6B45752" - which wrapped onto two lines and said little.
 */
function driveName(name: string, index: number): string {
  const trimmed = name
    .replace(/^(?:BD|DVD)[+\-]?[A-Z\-]*(?:\s?DL)?\s+/i, '')
    .replace(/\s+[A-Z0-9]{10,}$/i, '')
    .trim();
  return trimmed || name || `Drive ${index}`;
}

function DriveRow({ d, rip, onEject, onRemove, onReadCd, onSwap, busy }: { d: DiscDrive; rip?: DiscRip; onEject: () => void; onRemove?: () => void; onReadCd?: () => void; onSwap?: () => void; busy: boolean }) {
  const cls = d.state === 'loaded' ? 'green' : d.state === 'open' ? 'blue' : d.state === 'loading' ? 'teal' : 'muted';
  const linked = Boolean(d.virtualId);
  return (
    <div className="list-row">
      {d.virtual ? <Icon.HardDrive /> : <Icon.Disc />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600 }} title={d.name}>{driveName(d.name, d.index)}</div>
        <div className="small muted truncate" title={d.path}>
          {d.path || (d.auto ? 'the device appears once a disc is in' : '')}
          {d.manualId && d.detected === false && d.available !== false && ' · checked by Rexarr (not listed by MakeMKV)'}
          {d.auto && ' · found by Rexarr (not listed by MakeMKV)'}
        </div>
      </div>
      {d.virtual && <span className="badge purple">{linked ? 'virtual' : 'folder'}</span>}
      {d.manualId && <span className="badge blue" title="Added by device path">added</span>}
      {d.auto && (
        <span className="badge blue" title="This machine has the drive, but MakeMKV did not list it">
          found
        </span>
      )}
      {d.available === false && !d.auto && <span className="badge red">{d.manualId ? 'device not found' : 'file missing'}</span>}
      {d.awaiting && (
        <span className="badge blue" title={`Put disc ${d.awaiting.discNumber} of ${d.awaiting.batchName} in this drive`}>
          Waiting for Disc {d.awaiting.discNumber} of {d.awaiting.batchName}
        </span>
      )}
      {d.discLabel && <span className="badge remux">{d.discLabel}</span>}
      <span className={`badge ${cls}`}>{d.state}</span>
      {onSwap && !d.virtual && (
        <button
          className="btn sm"
          onClick={onSwap}
          disabled={busy || !rip || !discFreed(rip)}
          title={
            driveBusy(rip)
              ? 'This drive is still reading its disc'
              : rip && discFreed(rip)
                ? 'Eject this disc and wait for the next one of its set – the copy is made, so the disc is no longer needed'
                : 'Available once this disc has been copied'
          }
        >
          Swap
        </button>
      )}
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
  // follow the rip when it is matched again (or identified by the server)
  useEffect(() => setQ(media.title), [media.title]);
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
            {/* typing a number is an answer, so the guess warning goes away with it */}
            <input type="number" min={0} style={{ width: 70 }} value={media.episodeStart ?? 1} onChange={(e) => onChange({ episodeStart: Number(e.target.value), episodeStartGuessed: false })} />
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
              {media.kind === 'series' && media.seasonNumber ? (
                <div className="small">
                  Season {media.seasonNumber}
                  {media.seasonTitle && media.seasonTitle !== media.title ? <span className="dim"> · {media.seasonTitle}</span> : null}
                </div>
              ) : null}
              <div className="small dim">
                {media.kind === 'movie' ? 'TMDB' : 'TVDB'} {media.externalId} · {media.arrId ? 'already in library' : `not in ${media.kind === 'movie' ? 'Radarr' : 'Sonarr'} yet`} · {discType}
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

/** Audio CD: the matching release, tracks, music profile. */
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
            <label>{rel?.source === 'cddb' ? 'CDDB entry' : 'Release'}</label>
            {cd.releases.length > 0 ? (
              <select value={cd.selected} onChange={(e) => act(() => api.setCdRelease(rip.id, { index: Number(e.target.value) }))} disabled={busy}>
                <option value={-1}>Generic track names (Track 1, Track 2, …)</option>
                {cd.releases.map((r, i) => (
                  <option key={r.releaseId} value={i}>
                    {r.artist} – {r.title}
                    {r.date ? ` (${r.date.slice(0, 4)}${r.country ? `, ${r.country}` : ''})` : ''}
                    {r.label ? ` · ${r.label}` : ''} · {r.trackCount ?? r.tracks.length} tracks{r.discCount > 1 ? ` · disc ${r.discNumber}/${r.discCount}` : ''}
                    {r.source === 'cddb' ? ' · CDDB' : ''}
                    {r.fuzzy ? ' · similar length only, unconfirmed' : ''}
                  </option>
                ))}
              </select>
            ) : (
              <div className="warn small">
                Neither MusicBrainz nor CDDB knows this disc id ({cd.discId}). Search by artist and album below, or rip with generic track names.
              </div>
            )}
            {cd.releases.length > 0 && cd.selected < 0 && (
              <div className="warn small">
                Nothing matches this disc id ({cd.discId}). The releases above only have track lengths like this
                disc's – MusicBrainz suggests them, it has not recognised the disc. Check one before picking it,
                search by artist and album below, or rip with generic track names.
              </div>
            )}
            {rel?.fuzzy && <div className="warn small">Picked by track length, not by disc id – check the track titles below before ripping.</div>}
            {rel && (
              <div className="help">
                {rel.source === 'cddb' ? (
                  <>
                    From CDDB – artist, album, year, genre and track titles, nothing else. Entry{' '}
                    <span className="mono">{rel.releaseId}</span>
                    {rel.genre ? ` · ${rel.genre}` : ''}
                  </>
                ) : (
                  <>
                    <a href={`https://musicbrainz.org/release/${rel.releaseId}`} target="_blank" rel="noreferrer">
                      View on MusicBrainz
                    </a>
                    {rel.barcode ? ` · barcode ${rel.barcode}` : ''}
                  </>
                )}{' '}
                · disc id <span className="mono">{cd.discId}</span>
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
                    {r.date?.slice(0, 4)} {r.country} · {r.trackCount} tracks{r.discCount > 1 ? ` on ${r.discCount} discs` : ''}
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

function RipCard({ rip, onLog, nested }: { rip: DiscRip; onLog: (r: DiscRip) => void; nested?: boolean }) {
  const { profiles, smartProfiles, settings, toast } = useApp();
  // a live figure: Date.now() at render only moved when a progress event arrived
  const elapsedNow = elapsedSince(rip.startedAt ?? rip.progress?.startedAt, useNow(['ripping', 'transcoding', 'delivering'].includes(rip.status)));
  const [media, setMedia] = useState<RipMedia>(rip.media);
  const [selected, setSelected] = useState<number[]>(rip.selectedTitleIds);
  const [profileId, setProfileId] = useState(rip.profileId ?? '');
  const [options, setOptions] = useState<RipOptions>(rip.options);
  const [episodeMap, setEpisodeMap] = useState<Record<number, number>>(rip.episodeMap ?? {});
  const [titleRoles, setTitleRoles] = useState<Record<string, TitleRole>>(rip.titleRoles ?? {});
  const [specials, setSpecials] = useState<Episode[]>([]);
  const [audioMode, setAudioMode] = useState<'best' | 'all' | 'custom'>(rip.audioMode ?? 'best');
  const [selectedAudio, setSelectedAudio] = useState<Record<string, number[]>>(rip.selectedAudio ?? {});
  const [estimate, setEstimate] = useState<DiscEstimate | null>(null);
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
    api.episodes(media.arrId, 0)
      .then(setSpecials)
      .catch(() => setSpecials([]));
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
    setTitleRoles(rip.titleRoles ?? {});
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
  const onlyEpisodes = (ids: number[]) => ids.filter((id) => !titleRoles[String(id)] || titleRoles[String(id)].kind === 'episode');
  const episodeIds = onlyEpisodes(selected);
  const start = () => act(() => api.startRip(rip.id, { media, selectedTitleIds: selected, episodeMap: isSeries ? renumber(media.episodeStart ?? 1, episodeIds, episodeMap) : undefined, titleRoles, profileId: profileId || undefined, options, audioMode, selectedAudio }), 'Rip started');
  const setRole = (id: number, role: TitleRole) => {
    setTitleRoles((m) => {
      const next = { ...m };
      if (role.kind === 'episode') delete next[String(id)];
      else next[String(id)] = role;
      return next;
    });
    if (role.kind !== 'episode')
      setEpisodeMap((m) => {
        const next = { ...m };
        delete next[id];
        return next;
      });
  };

  // Estimated sizes for what is selected right now (nothing has been ripped yet, so this uses the disc's own stream list).
  const hasTitles = rip.titles.length > 0 && rip.discType !== 'cd';
  useEffect(() => {
    if (!editable || !hasTitles || !selected.length) {
      setEstimate(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      api
        .estimateRip(rip.id, { selectedTitleIds: selected, profileId: profileId || undefined, options, audioMode, selectedAudio })
        .then((e) => live && setEstimate(e))
        .catch(() => live && setEstimate(null));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable, hasTitles, selected, profileId, options.transcode, audioMode, selectedAudio]);
  const changeMedia = (m: Partial<RipMedia>) => {
    setMedia((x) => {
      const next = { ...x, ...m };
      if (m.kind && m.kind !== x.kind && rip.titles.length) {
        const sel = m.kind === 'series' ? rip.titles.filter((t) => !(rip.playAllTitleIds ?? []).includes(t.id)).map((t) => t.id) : [[...rip.titles].sort((a, b) => b.durationSeconds - a.durationSeconds)[0].id];
        setSelected(sel);
        setEpisodeMap(renumber(next.episodeStart ?? 1, onlyEpisodes(sel)));
      }
      if (m.episodeStart !== undefined && m.episodeStart !== x.episodeStart) setEpisodeMap(renumber(m.episodeStart, onlyEpisodes(selected)));
      return next;
    });
  };
  const toggleTitle = (id: number, on: boolean) => {
    const sel = on ? [...selected, id].sort((a, b) => a - b) : selected.filter((x) => x !== id);
    setSelected(sel);
    if (isSeries) setEpisodeMap((m) => renumber(media.episodeStart ?? 1, onlyEpisodes(sel), on ? m : Object.fromEntries(Object.entries(m).filter(([k]) => Number(k) !== id))));
  };
  const usedTwice = (ep: number) => selected.filter((id) => episodeMap[id] === ep).length > 1;

  const active = ACTIVE.includes(rip.status);
  return (
    <div className="card mb">
      <div className="card-h">
        {/* inside a box set the row above already names the series, the disc and its state: repeating them here
            made a card header inside a row inside a card, all saying the same thing */}
        {!nested && <Icon.Disc />}
        {!nested && (
          <span className="truncate" style={{ minWidth: '10em', flexShrink: 1 }} title={rip.media.artist ? `${rip.media.artist} – ${rip.media.title}` : undefined}>
            {rip.media.artist && <span className="dim">{rip.media.artist} – </span>}
            {rip.media.title || rip.label || 'Unknown disc'}
          </span>
        )}
        {!nested && rip.media.year && <span className="dim">({rip.media.year})</span>}
        {!nested && <span className={`badge ${STATUS_CLASS[rip.status]}`}>{STATUS_LABEL[rip.status]}</span>}
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
        <span className="small muted truncate" style={{ minWidth: 0, flexShrink: 100 }} title={rip.driveName}>
          {driveName(rip.driveName, rip.driveIndex)} · {fmtAge(rip.createdAt)}
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
      {rip.slotWarning && <SlotWarning rip={rip} />}
      {!nested && !rip.batch && !rip.slotWarning && !rip.batchSuggestion && rip.media.kind === 'series' && rip.media.title && (
        <div className="card-b" style={{ paddingTop: 0 }}>
          <button
            className="btn sm"
            title="Put this disc into the box set for its series and season, making one if there is not one yet"
            onClick={() =>
              api
                .answerBatch(rip.id, true, true)
                .then((r) => toast('info', r.batch ? `Added to “${r.batch.name}”` : 'Added to the set'))
                .catch((e) => toast('error', (e as Error).message))
            }
          >
            Add to box set
          </button>
        </div>
      )}
      {rip.batchSuggestion && !rip.slotWarning && <BatchOffer rip={rip} />}

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
                {elapsedNow && ` · ${elapsedNow} elapsed`}
                {rip.progress.etaSeconds ? ` · ${fmtDuration(rip.progress.etaSeconds)} left` : ''}
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
          {media.externalId && !media.arrId && (media.kind === 'series' || media.kind === 'movie') && (
            <div className="small mt" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span className="dim">
                Not in {media.kind === 'movie' ? 'Radarr' : 'Sonarr'} yet – {settings?.disc.addMissing !== false ? 'it is added when the rip starts' : 'adding is off in Settings, so it will not be imported'}
                {media.kind === 'series' ? '. Add it now to pick episodes by name.' : '.'}
              </span>
              <button className="btn sm" disabled={busy} onClick={() => act(() => api.addRipToLibrary(rip.id), `Added to ${media.kind === 'movie' ? 'Radarr' : 'Sonarr'}`)}>
                <Icon.Plus /> Add to {media.kind === 'movie' ? 'Radarr' : 'Sonarr'} now
              </button>
            </div>
          )}
          {rip.label && (
            <div className="small dim mt" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              Wrong match?
              <button className="btn sm" disabled={busy} onClick={() => act(() => api.reidentifyRip(rip.id), 'Matched again')} title="Forget the current match and identify the disc again from its label, checking your library first">
                <Icon.Refresh /> Match again from “{rip.label}”
              </button>
              <span>or search above.</span>
            </div>
          )}
          <div className="tbl-wrap mt">
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 30 }}>
                    <input type="checkbox" checked={selected.length === rip.titles.length} onChange={(e) => setSelected(e.target.checked ? rip.titles.map((t) => t.id) : [])} />
                  </th>
                  <th>#</th>
                  <th>Title</th>
                  <th style={{ minWidth: 380 }}>{isSeries ? 'Episode / extra' : 'Type'}</th>
                  <th>Length</th>
                  <th className="num">Size</th>
                  <th>Chapters</th>
                  <th>Video</th>
                  <th style={{ minWidth: 190 }}>Audio</th>
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
                    <td>
                      {selected.includes(t.id) ? (
                        <TitleRoleCell
                          title={t}
                          isSeries={isSeries}
                          role={titleRoles[String(t.id)] ?? { kind: 'episode' }}
                          episode={episodeMap[t.id]}
                          episodes={sonarrEpisodes}
                          specials={specials}
                          seasonNumber={media.seasonNumber ?? 1}
                          prefix={media.absoluteNumbering ? 'Ep.' : `S${String(media.seasonNumber ?? 1).padStart(2, '0')}E`}
                          absolute={Boolean(media.absoluteNumbering)}
                          duplicate={(titleRoles[String(t.id)]?.kind ?? 'episode') === 'episode' && usedTwice(episodeMap[t.id])}
                          onEpisode={(n) => setEpisodeMap((m) => ({ ...m, [t.id]: n }))}
                          onRole={(r) => setRole(t.id, r)}
                        />
                      ) : (
                        <span className="muted small">skipped</span>
                      )}
                    </td>
                    <td className="mono" style={{ whiteSpace: 'nowrap' }}>{fmtDuration(t.durationSeconds)}</td>
                    <td className="num dim" style={{ whiteSpace: 'nowrap' }}>{fmtBytes(t.sizeBytes)}</td>
                    <td className="dim">{t.chapters || '—'}</td>
                    <td className="dim small">
                      {t.videoCodec} {t.resolution}
                    </td>
                    <td className="dim small">
                      <AudioPicker
                        title={t}
                        mode={audioMode}
                        custom={selectedAudio[String(t.id)]}
                        onChange={(next) => {
                          setSelectedAudio((m) => ({ ...m, [String(t.id)]: next }));
                          setAudioMode('custom');
                        }}
                        onApplyAll={(next) => {
                          setSelectedAudio(Object.fromEntries(rip.titles.map((x) => [String(x.id), next.filter((i) => (x.audioTracks ?? []).some((a) => a.index === i))])));
                          setAudioMode('custom');
                          toast('info', `Audio selection applied to ${rip.titles.length} title(s)`);
                        }}
                      />
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
              {media.episodeSource === 'rexdb' && media.rexdb && (
                <strong className="fromRexdb">
                  {' '}
                  These episode numbers came from <a href="https://moonlightlaboratory.github.io/rexarr/rexdb/" target="_blank" rel="noreferrer">RexDB</a>, where
                  somebody read this disc{media.rexdb.confirmations && media.rexdb.confirmations > 1 ? ` and ${media.rexdb.confirmations - 1} other${media.rexdb.confirmations > 2 ? 's' : ''} agreed` : ''} —
                  not from a guess. Change anything that is wrong; what you set wins.
                </strong>
              )}
              {media.episodeSource === 'rexdb-suggested' && media.rexdb && (
                <strong>
                  {' '}
                  RexDB has a disc that looks like this one (“{media.rexdb.disc_name}”), but not close enough to apply on
                  its own — check it at <a href="https://moonlightlaboratory.github.io/rexarr/rexdb/" target="_blank" rel="noreferrer">RexDB</a> and
                  set the episodes yourself.
                </strong>
              )}
              {media.episodeSource !== 'rexdb' && (media.discNumber ?? 1) > 1 && (media.episodeStartGuessed || (media.episodeStart ?? 1) === 1) && (
                <strong>
                  {' '}
                  This is disc {media.discNumber} of the set and nothing on it says where it starts, so{' '}
                  {media.episodeStartGuessed ? `episode ${media.episodeStart} is a guess` : 'episode 1 is only the default'} —
                  check “First ep.” against the disc. Earlier discs of a set often hold more episodes than the later ones.
                </strong>
              )}
              {sonarrEpisodes === null && media.arrId === undefined && ' Identify the series to pick episodes by name.'}
              {media.seriesType === 'anime' && !media.absoluteNumbering && ' This is an anime series in Sonarr – turn on absolute numbering if it uses absolute episode numbers.'}
            </div>
          )}
          <RexDbPanel rip={rip} />
          <div className="inline mt" style={{ gap: 14 }}>
            <div style={{ width: 280 }}>
              <ProfileSelect profiles={profiles} smart={smartProfiles} value={profileId} onChange={setProfileId} mediaType={mediaType} />
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
            {audioMode === 'custom' ? (
              <span className="inline small" style={{ gap: 6 }}>
                <span className="badge sm outline blue">Audio: picked by hand</span>
                <button className="btn sm" onClick={() => { setAudioMode('best'); setSelectedAudio({}); }}>
                  Reset
                </button>
              </span>
            ) : (
              <label className="check" title="Keep the best audio track per language (DTS over Dolby Digital, 5.1 over stereo) instead of every track on the disc">
                <input type="checkbox" checked={audioMode === 'best'} onChange={(e) => setAudioMode(e.target.checked ? 'best' : 'all')} /> Best audio per language
              </label>
            )}
            <span className="spacer" />
            <RipEstimate titles={selected.length} sourceBytes={totalSelected} estimate={estimate} transcode={options.transcode} />
            <button className="btn primary" onClick={start} disabled={busy || !selected.length || (options.transcode && !profileId)}>
              {busy ? <span className="spinner" /> : <Icon.Play />} {rip.status === 'ready' ? 'Rip' : 'Rip again'}
            </button>
          </div>
        </div>
      )}
      {editable && rip.titles.length === 0 && rip.status !== 'failed' && (
        <div className="empty">{rip.scanNote ?? 'No titles found on this disc.'}</div>
      )}

      {rip.files.length > 0 && (
        <div className="card-b" style={{ borderTop: '1px solid var(--border)' }}>
          <div className="small dim mb">
            Files
            {rip.ripSeconds ? ` · ripped in ${fmtDuration(rip.ripSeconds)}` : ''}
          </div>
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

const EXTRA_OPTIONS: { type: ExtraType; label: string }[] = [
  { type: 'none', label: 'Extra – keep disc name' },
  { type: 'op', label: 'OP' },
  { type: 'ed', label: 'ED' },
  { type: 'extra', label: 'Extra' },
  { type: 'ova', label: 'OVA' },
  { type: 'special', label: 'Special' },
  { type: 'custom', label: 'Custom name…' },
];

/**
 * What a title is: an episode of the season, a special from season 0 (when TVDB lists specials), or an extra that is
 * kept next to the show in an Extras folder (Sonarr only imports episodes).
 */

/**
 * "Add to Naruto - Season 1 box set?" - asked on a disc that reads as part of a set already in the queue.
 *
 * It asks rather than just doing it: two discs of one season are usually a set, but not always, and a disc put in
 * the wrong set would be numbered from the wrong place. Declining is remembered, so the disc is not asked twice.
 */
function BatchOffer({ rip }: { rip: DiscRip }) {
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);
  const s = rip.batchSuggestion!;
  const answer = (accept: boolean) => {
    setBusy(true);
    api
      .answerBatch(rip.id, accept)
      .then(() => toast('info', accept ? `Added to “${s.name}”` : 'Kept as its own disc'))
      .catch((e) => toast('error', (e as Error).message))
      .finally(() => setBusy(false));
  };
  return (
    <div className="info" style={{ margin: 14, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <span>
        Part of a set? Add this disc to <strong>{s.name}</strong>?
        <span className="small dim"> {s.why}. Its episodes carry on from where the last disc ended.</span>
      </span>
      <span className="spacer" />
      <button className="btn sm primary" disabled={busy} onClick={() => answer(true)}>
        Add to set
      </button>
      <button className="btn sm" disabled={busy} onClick={() => answer(false)}>
        Keep separate
      </button>
    </div>
  );
}


/**
 * The disc in the drive is not the one that drive was waiting for.
 *
 * Nothing is filed by force here. A disc put in the wrong slot takes its episode numbers from the wrong place, and
 * a duplicate would overwrite a disc already ripped, so the choice is the user's: file it where it really belongs,
 * or leave it out of the set as its own item.
 */
function SlotWarning({ rip }: { rip: DiscRip }) {
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);
  const w = rip.slotWarning!;
  const mine = rip.media.discNumber;
  const act = (opts: { disc?: number; reject?: boolean }, ok: string) => {
    setBusy(true);
    api
      .resolveSlot(rip.id, opts)
      .then(() => toast('info', ok))
      .catch((e) => toast('error', (e as Error).message))
      .finally(() => setBusy(false));
  };
  return (
    <div className="warn" style={{ margin: 14 }}>
      <div>
        <strong>This is not the disc that drive was waiting for.</strong> {w.message}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        {w.kind !== 'wrong-series' && mine !== undefined && w.kind !== 'duplicate' && (
          <button className="btn sm primary" disabled={busy} onClick={() => act({ disc: mine }, `Added as disc ${mine}`)}>
            Add as Disc {mine}
          </button>
        )}
        <button
          className="btn sm"
          disabled={busy}
          onClick={() => {
            const raw = prompt(`Which disc of “${w.batchName}” is this?`, String(mine ?? w.expectedDisc));
            const n = Number(raw);
            if (!raw || !Number.isInteger(n) || n < 1 || n > 99) return;
            act({ disc: n }, `Added as disc ${n}`);
          }}
        >
          Assign to a slot…
        </button>
        <button className="btn sm" disabled={busy} onClick={() => act({ reject: true }, 'Kept out of the set')}>
          Reject – keep it separate
        </button>
      </div>
    </div>
  );
}

function TitleRoleCell({
  title,
  isSeries,
  role,
  episode,
  episodes,
  specials,
  seasonNumber,
  prefix,
  absolute,
  duplicate,
  onEpisode,
  onRole,
}: {
  title: DiscTitle;
  isSeries: boolean;
  role: TitleRole;
  episode?: number;
  episodes: Episode[] | null;
  specials: Episode[];
  seasonNumber: number;
  prefix: string;
  /** The series is filed by absolute number, so that is what the episode map holds. */
  absolute: boolean;
  duplicate: boolean;
  onEpisode: (n: number) => void;
  onRole: (r: TitleRole) => void;
}) {
  const value = role.kind === 'special' ? `sp:${role.episode}` : role.kind === 'extra' ? `x:${role.type}` : isSeries ? (episodes?.length ? `ep:${episode ?? ''}` : 'ep') : 'main';
  const change = (v: string) => {
    if (v === 'main' || v === 'ep') return onRole({ kind: 'episode' });
    const [k, rest] = v.split(':');
    if (k === 'ep') {
      onRole({ kind: 'episode' });
      if (rest) onEpisode(Number(rest));
    } else if (k === 'sp') onRole({ kind: 'special', episode: Number(rest) });
    else onRole({ kind: 'extra', type: rest as ExtraType, name: role.kind === 'extra' ? role.name : undefined });
  };
  return (
    <span className="inline" style={{ gap: 6, flexWrap: 'nowrap' }}>
      <select className="roleSelect" value={value} onChange={(e) => change(e.target.value)} style={{ borderColor: duplicate ? 'var(--dangerColor)' : undefined }} title={title.short ? 'Shorter than the minimum title length: probably an extra' : undefined}>
        {isSeries ? (
          episodes?.length ? (
            <optgroup label={`Season ${seasonNumber}`}>
              <option value="ep:">—</option>
              {episodes.map((e) => (
                // the map holds absolute numbers for a series filed that way, which is what names and imports it
                <option key={e.id} value={`ep:${(absolute && e.absoluteEpisodeNumber) || e.episodeNumber}`}>
                  E{String(e.episodeNumber).padStart(2, '0')} · {e.title}
                  {absolute && e.absoluteEpisodeNumber ? ` (${e.absoluteEpisodeNumber})` : ''}
                  {e.hasFile ? ' ✓' : ''}
                </option>
              ))}
            </optgroup>
          ) : (
            <option value="ep">Episode</option>
          )
        ) : (
          <option value="main">Movie</option>
        )}
        {isSeries && specials.length > 0 && (
          <optgroup label="Specials (season 0)">
            {specials.map((e) => (
              <option key={e.id} value={`sp:${e.episodeNumber}`}>
                S00E{String(e.episodeNumber).padStart(2, '0')} · {e.title}
                {e.hasFile ? ' ✓' : ''}
              </option>
            ))}
          </optgroup>
        )}
        <optgroup label={isSeries ? 'Extra – kept next to the show' : 'Extra – kept next to the movie'}>
          {EXTRA_OPTIONS.map((o) => (
            <option key={o.type} value={`x:${o.type}`}>
              {o.label}
            </option>
          ))}
        </optgroup>
      </select>
      {isSeries && role.kind === 'episode' && !episodes?.length && (
        <span className="inline" style={{ gap: 4, flexWrap: 'nowrap' }}>
          <span className="small dim">{prefix}</span>
          <input type="number" min={0} style={{ width: 64, height: 30 }} value={episode ?? ''} onChange={(e) => onEpisode(Number(e.target.value))} />
        </span>
      )}
      {role.kind === 'extra' && role.type === 'custom' && (
        <input type="text" placeholder="Name, e.g. Creditless OP 2" style={{ width: 240, height: 30 }} value={role.name ?? ''} onChange={(e) => onRole({ kind: 'extra', type: 'custom', name: e.target.value })} />
      )}
      {isSeries && role.kind === 'extra' && specials.length === 0 && <span className="small dim" title="TVDB lists no specials for this series">no specials on TVDB</span>}
      {isSeries && role.kind === 'episode' && episodes?.length && !episodes.some((e) => e.episodeNumber === episode) ? (
        <span className="small" style={{ color: 'var(--warningColor)', whiteSpace: 'nowrap' }} title={`Season ${seasonNumber} has ${episodes.length} episodes on TVDB: pick a special or an extra for this title`}>
          special or extra?
        </span>
      ) : null}
    </span>
  );
}

/** One title's audio tracks: automatic (best per language) or a hand-picked track. */
function AudioPicker({
  title,
  mode,
  custom,
  onChange,
  onApplyAll,
}: {
  title: DiscTitle;
  mode: 'best' | 'all' | 'custom';
  custom?: number[];
  onChange: (next: number[]) => void;
  onApplyAll: (next: number[]) => void;
}) {
  const tracks = title.audioTracks ?? [];
  const [open, setOpen] = useState(false);
  // fixed position: the menu is wider than the Audio column and would be clipped by the table's scroll area
  const [at, setAt] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const r = box.current?.getBoundingClientRect();
      if (!r) return;
      const width = 310;
      setAt({ top: Math.min(r.bottom + 2, window.innerHeight - 260), left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)) });
    };
    place();
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('mousedown', close);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);
  if (!tracks.length) return <span className="muted">—</span>;

  const auto = bestAudioTracks(tracks);
  const kept = mode === 'all' ? tracks.map((t) => t.index) : mode === 'custom' && custom?.length ? custom : auto;
  const toggle = (index: number, on: boolean) => {
    const next = on ? [...new Set([...kept, index])].sort((a, b) => a - b) : kept.filter((i) => i !== index);
    if (next.length) onChange(next);
  };
  const short = (i: number) => {
    const t = tracks.find((x) => x.index === i);
    if (!t) return '?';
    return [(t.language || 'und').toUpperCase(), t.codec, t.channels && t.channels > 2 ? `${t.channels}ch` : ''].filter(Boolean).join(' ');
  };
  const summary = kept.length === tracks.length ? `all ${tracks.length}` : `${kept.slice(0, 2).map(short).join(' · ')}${kept.length > 2 ? ` +${kept.length - 2}` : ''}`;

  return (
    <div className="audioPick" ref={box}>
      <button type="button" className="audioPickButton" onClick={() => setOpen((o) => !o)} title={kept.map((i) => tracks.find((t) => t.index === i)?.label).join('\n')}>
        <span className="truncate">
          {kept.length}/{tracks.length} · {summary}
        </span>
        <Icon.ChevronDown />
      </button>
      {open && (
        <div className="audioPickMenu" style={{ top: at.top, left: at.left }}>
          {tracks.map((t) => (
            <label key={t.index} className="audioPickRow">
              <input type="checkbox" checked={kept.includes(t.index)} onChange={(e) => toggle(t.index, e.target.checked)} />
              <span className="truncate" title={t.label}>
                {t.label}
              </span>
              {auto.includes(t.index) && <span className="badge sm outline green" title="Best track for this language">best</span>}
            </label>
          ))}
          <div className="audioPickActions">
            <button type="button" className="btn sm" onClick={() => onChange(auto)}>
              Best per language
            </button>
            <button type="button" className="btn sm" onClick={() => onChange(tracks.map((t) => t.index))}>
              All
            </button>
            <span className="spacer" />
            <button type="button" className="btn sm primary" onClick={() => { onApplyAll(kept); setOpen(false); }} title="Use these tracks for every title on this disc">
              Apply to all titles
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Best track per language, mirroring the server so the dropdown shows what a rip would keep. */
function bestAudioTracks(tracks: DiscAudioTrack[]): number[] {
  const rank = (t: DiscAudioTrack) => {
    const c = t.codec.toLowerCase();
    const codec = /truehd/.test(c) ? 100 : /dts-?hd\s*ma|master/.test(c) ? 95 : /flac/.test(c) ? 90 : /pcm/.test(c) ? 85 : /dts/.test(c) ? 60 : /e-?ac-?3|ddp/.test(c) ? 50 : /ac-?3|dolby|dd/.test(c) ? 40 : /aac/.test(c) ? 30 : 10;
    const commentary = /comment|director|narration/i.test(`${t.label} ${t.name ?? ''}`) ? -1e6 : 0;
    return commentary + codec * 1000 + Math.min(8, t.channels ?? 2) * 100 + Math.min(99, Math.round((t.bitrateKbps ?? 0) / 100));
  };
  const best = new Map<string, DiscAudioTrack>();
  for (const t of tracks) {
    const key = (t.language || 'und').toLowerCase();
    const cur = best.get(key);
    if (!cur || rank(t) > rank(cur)) best.set(key, t);
  }
  return [...best.values()].map((t) => t.index).sort((a, b) => a - b);
}

/** Compact version of the Transcode dialog's size panel. */
/**
 * Contributing this disc to RexDB.
 *
 * Offered only when RexDB would learn something: a disc it has never seen, or one where what is on screen
 * disagrees with what it holds. Nothing is sent from here - the entry is shown, and the button opens GitHub
 * with it already written out, so the decision and the name on it are the person's.
 */
function RexDbPanel({ rip }: { rip: DiscRip }) {
  const [state, setState] = useState<Awaited<ReturnType<typeof api.discRexdb>> | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<{ ok: boolean; url?: string; error?: string } | null>(null);
  const { settings, toast } = useApp();
  // With no submission service there is nowhere to post from here, and a button that can only fail is worse
  // than no button: GitHub is the way to send it, so it becomes the thing offered.
  const canSend = Boolean(settings?.rexdb?.submitUrl?.trim());
  const load = async (refresh = false) => {
    setBusy(true);
    try {
      setState(await api.discRexdb(rip.id, refresh));
    } catch {
      setState(null);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (rip.media.kind === 'series' && rip.titles.length) void load();
    // re-asked when the mapping changes, since that is what decides whether there is anything to send
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rip.id, JSON.stringify(rip.episodeMap), JSON.stringify(rip.titleRoles)]);

  const c = state?.contribution;
  if (!c || c.alreadyKnown) return null;
  const entry = JSON.stringify(c.entry, null, 2);
  const send = async () => {
    setSending(true);
    setSent(null);
    try {
      const r = await api.submitDiscToRexdb(rip.id);
      setSent({ ok: true, url: r.url });
      toast('info', 'Sent to RexDB');
      void load(true);
    } catch (e) {
      // the service may be unreachable, or not deployed yet; GitHub is still there to finish it by hand
      setSent({ ok: false, error: (e as Error).message });
    } finally {
      setSending(false);
    }
  };
  return (
    <div className={`rexdbPanel${c.disagrees ? ' disagrees' : ''}`}>
      <div className="inline" style={{ gap: 8, flexWrap: 'wrap' }}>
        <strong>
          {c.disagrees
            ? 'RexDB has this disc, and says something different.'
            : 'RexDB has never seen this disc.'}
        </strong>
        <span className="small dim">
          {c.disagrees
            ? `It says “${state?.match?.entry.disc_name}”. Check which of you is right before sending yours.`
            : 'If these episode numbers are right, sending them means nobody else has to work them out.'}
        </span>
        <span className="spacer" />
        <button className="btn sm" onClick={() => setOpen((o) => !o)} disabled={busy}>
          {open ? 'Hide' : 'Show what would be sent'}
        </button>
        {sent?.ok ? (
          <span className="badge green">
            Sent{sent.url ? ' – ' : ''}
            {sent.url && (
              <a href={sent.url} target="_blank" rel="noreferrer">
                see it
              </a>
            )}
          </span>
        ) : !canSend ? (
          <a className="btn sm primary" href={c.url} target="_blank" rel="noreferrer">
            Post it on GitHub
          </a>
        ) : (
          <button className="btn sm primary" onClick={send} disabled={sending}>
            {sending ? <span className="spinner" /> : null} Send to RexDB
          </button>
        )}
      </div>
      {sent && !sent.ok && (
        <p className="warn small mt">
          Could not send it from here: {sent.error}. The rip is unaffected —{' '}
          <a href={c.url} target="_blank" rel="noreferrer">
            open it on GitHub
          </a>{' '}
          to post it by hand instead.
        </p>
      )}
      {open && (
        <>
          <p className="small dim mt">
            Nothing has left this machine. The button opens GitHub with this already filled in; you decide whether to
            post it. Only what is below is sent — no paths, no library, nothing about you.
          </p>
          <pre className="log" style={{ maxHeight: 260 }}>{entry}</pre>
        </>
      )}
    </div>
  );
}


/**
 * A clock, so an elapsed time on screen actually elapses.
 *
 * Reading Date.now() at render only moves the number when something else re-renders the component - between
 * progress events a rip would sit on the same figure for seconds at a time. The interval runs only while there is
 * something to count.
 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/** How long a rip has been going, as a live figure. */
function elapsedSince(startedAt: string | undefined, now: number): string | null {
  if (!startedAt) return null;
  const secs = Math.round((now - new Date(startedAt).getTime()) / 1000);
  return secs >= 0 ? fmtDuration(secs) : null;
}

/** The phases a box set reports, as a word and a colour. */
const PHASE: Record<string, { label: string; cls: string }> = {
  waiting: { label: 'Waiting', cls: '' },
  ripping: { label: 'Ripping', cls: 'blue' },
  remuxing: { label: 'Remuxing', cls: 'blue' },
  done: { label: 'Done', cls: 'green' },
  failed: { label: 'Failed', cls: 'red' },
  cancelled: { label: 'Cancelled', cls: '' },
};

/**
 * One disc of a box set, as the set lists it: which disc it is, which episodes are on it by name, and what it is
 * doing. "Disc 2 · E07 to E12" is the thing worth seeing at a glance; the whole rip card is a click away.
 */
function BatchDiscRow({ rip, episodes, open, onToggle, onChanged, onLog }: { rip: DiscRip; episodes: Episode[] | null; open: boolean; onToggle: () => void; onChanged: () => void; onLog: (r: DiscRip) => void }) {
  const { toast } = useApp();
  const phase = PHASE[discPhase(rip.status)] ?? PHASE.waiting;
  const range = episodeRange(rip);
  const eps = episodeNumbers(rip);
  const nameOf = (n: number) => episodes?.find((e) => e.episodeNumber === n || e.absoluteEpisodeNumber === n)?.title;
  const disc = rip.media.discNumber;
  const phaseKey = discPhase(rip.status);
  const running = phaseKey === 'ripping' || phaseKey === 'remuxing';
  const elapsed = elapsedSince(rip.startedAt ?? rip.progress?.startedAt, useNow(running));
  return (
    <div>
      {/* the row draws its own divider; a second one here made the line above a disc twice that above a slot */}
      <div className="batch-row clickable" onClick={onToggle}>
        {/* these SVGs carry no size of their own – they are sized by the context they sit in, and a bare row is not one */}
        <span style={{ display: 'inline-flex', width: 14, height: 14, color: 'var(--dimColor)' }}>{open ? <Icon.ChevronDown /> : <Icon.ChevronRight />}</span>
        <span className="name">
          <strong>{disc ? `Disc ${disc}` : rip.label || 'Disc'}</strong>
          {rip.media.episodeStartGuessed && (
            <span className="badge sm" title="The first episode was worked out from the disc number, not read off the disc. Worth checking.">
              guessed
            </span>
          )}
        </span>
        <span>{range ? (range.from === range.to ? `E${pad(range.from)}` : `E${pad(range.from)} to E${pad(range.to)}`) : <span className="small dim">not worked out yet</span>}</span>
        <span className="small dim">{eps.length ? `${eps.length} episode${eps.length === 1 ? '' : 's'}` : rip.titles.length ? `${rip.titles.length} title(s)` : ''}</span>
        <span />
        <span>
          <span className={`badge sm ${phase.cls}`}>{phase.label}</span>
          {(phaseKey === 'ripping' || phaseKey === 'remuxing') && <span className="small dim">{Math.round(ripOverallPercent(rip.progress))}%</span>}
          {running && elapsed && (
            <span className="small dim" title="How long this disc has been going">
              {elapsed}
            </span>
          )}
          {phaseKey === 'done' && rip.ripSeconds ? <span className="small dim" title="How long the rip itself took">{fmtDuration(rip.ripSeconds)}</span> : null}
        </span>
        <button
          className="btn sm"
          title="Take this disc out of the box set. It keeps its own entry and nothing already ripped is touched."
          onClick={(e) => {
            e.stopPropagation();
            if (!confirm(`Take ${disc ? `Disc ${disc}` : rip.label} out of "${rip.batch?.name}"?\n\nIt keeps its own entry and nothing already ripped is touched.`)) return;
            api
              .leaveBatch(rip.id)
              .then(() => {
                toast('info', 'Taken out of the set');
                onChanged();
              })
              .catch((err) => toast('error', (err as Error).message));
          }}
        >
          Take out
        </button>
      </div>
      {open && (
        <div className="batch-open">
          {eps.length > 0 && (
            <div className="small batch-eps">
              {eps.map((n) => (
                <span key={n}>
                  <strong>E{pad(n)}</strong>{' '}
                  {nameOf(n) ?? <span className="dim">{episodes === null ? 'name needs the series in Sonarr' : 'not in Sonarr'}</span>}
                </span>
              ))}
            </div>
          )}
          <RipCard rip={rip} onLog={onLog} nested />
        </div>
      )}
    </div>
  );
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * A box set: the parent item for the discs of one season, with its own progress across all of them.
 *
 * The set's name lives on each member rip, so there is nothing to fetch for it - the discs are the set.
 * Episode names are fetched once here rather than per disc, since every disc in a set is the same season.
 */
function BatchCard({ rips, onLog, onChanged, waitingFor = [] }: { rips: DiscRip[]; onLog: (r: DiscRip) => void; onChanged: () => void; waitingFor?: number[] }) {
  const { toast } = useApp();
  const discs = useMemo(() => sortDiscs(rips), [rips]);
  const batch = discs[0].batch!;
  const prog = batchProgress(discs);
  const [open, setOpen] = useState<string | null>(null);
  const [episodes, setEpisodes] = useState<Episode[] | null>(null);
  // until the season is known there is nothing to divide, and guessing from the discs in hand would have the set
  // announce itself complete ("4 of 4 discs") for the second before the answer arrives
  const [seasonKnown, setSeasonKnown] = useState(false);
  const known = discs.find((d) => d.media.arrId !== undefined);
  const arrId = known?.media.arrId;
  const season = known?.media.seasonNumber ?? 1;
  useEffect(() => {
    if (arrId === undefined) return;
    let live = true;
    api
      .episodes(arrId, season)
      .then((e) => live && (setEpisodes(e), setSeasonKnown(true)))
      .catch(() => live && (setEpisodes(null), setSeasonKnown(true)));
    return () => {
      live = false;
    };
  }, [arrId, season]);

  const ripping = discs.filter((d) => ['ripping', 'remuxing'].includes(discPhase(d.status)));
  // how many discs the set holds: arithmetic on the season's episodes and what a disc of this set actually has
  const expected = seasonKnown ? expectedDiscCount(discs, episodes?.length ?? 0) : undefined;
  const incoming = missingDiscs(discs, expected);
  return (
    <div className="card mb">
      <div className="card-h">
        <span style={{ display: 'inline-flex', width: 16, height: 16, flex: '0 0 16px' }}>
          <Icon.Disc />
        </span>
        <strong>{batch.name}</strong>
        <span className="badge sm">{expected ? `${prog.total} of ${expected} discs` : `${prog.total} disc${prog.total === 1 ? '' : 's'}`}</span>
        {prog.done === prog.total && !incoming.length ? <span className="badge sm green">Complete</span> : <span className="badge sm">{prog.done} of {prog.total} done</span>}
        <span className="spacer" />
        {ripping.length > 0 && <span className="small dim">{ripping.map((d) => `Disc ${d.media.discNumber ?? '?'} ${PHASE[discPhase(d.status)].label.toLowerCase()}`).join(', ')}</span>}
        <button
          className="btn sm"
          title="Rename this box set"
          onClick={() => {
            const name = prompt('Box set name', batch.name)?.trim();
            if (!name || name === batch.name) return;
            api.updateBatch(batch.id, { name }).then(() => { toast('info', 'Box set renamed'); onChanged(); }).catch((e: unknown) => toast('error', (e as Error).message));
          }}
        >
          Rename
        </button>
        <button
          className="btn sm"
          title="How many discs this set holds. Worked out from the season's episode count unless you say otherwise."
          onClick={() => {
            const raw = prompt(`How many discs are in “${batch.name}”?`, String(expected ?? discs.length));
            const n = Number(raw);
            if (!raw || !Number.isInteger(n) || n < 1 || n > 60) return;
            api.updateBatch(batch.id, { expectedDiscs: n }).then(() => { toast('info', `${batch.name}: ${n} discs`); onChanged(); }).catch((e: unknown) => toast('error', (e as Error).message));
          }}
        >
          Discs…
        </button>
      </div>
      {/* shown once a disc is actually working: keyed off percent it vanished between titles, because a disc's
          percent restarts at zero with every title it writes */}
      {discs.some((d) => discPhase(d.status) !== 'waiting') && (
        <div className="batch-progress">
          <div className="progress md" title={`${prog.percent}% of the whole set`}>
            <div style={{ width: `${prog.percent}%` }} />
            <span className="text">{prog.percent}%</span>
          </div>
        </div>
      )}
      <div>
        {discs.map((d) => (
          <BatchDiscRow key={d.id} rip={d} episodes={episodes} open={open === d.id} onToggle={() => setOpen(open === d.id ? null : d.id)} onChanged={onChanged} onLog={onLog} />
        ))}
        {/* the discs that have not turned up yet, so what is still missing is visible without counting */}
        {incoming.map((n) => (
          <div key={`slot-${n}`} className="batch-row" style={{ opacity: 0.55 }}>
            <span />
            <strong>Disc {n}</strong>
            <span className="small dim">not inserted yet</span>
            <span className="small dim">{waitingFor.includes(n) ? 'a drive is waiting' : ''}</span>
            <span />
            {/* wrapped like the disc rows': the badge carries a margin, so as a grid item it sits 2px off theirs */}
            <span>
              <span className="badge sm">incoming</span>
            </span>
            <span />
          </div>
        ))}
      </div>
    </div>
  );
}

function RipEstimate({ titles, sourceBytes, estimate, transcode }: { titles: number; sourceBytes: number; estimate: DiscEstimate | null; transcode: boolean }) {
  const out = transcode ? estimate?.transcode?.bytes : estimate?.ripBytes;
  const saved = out && sourceBytes ? Math.round((1 - out / sourceBytes) * 100) : 0;
  const parts = estimate?.transcode?.parts;
  return (
    <span className="ripEstimate" title={estimate?.transcode?.notes.join('\n')}>
      <span className="small dim">
        {titles} title(s) · {fmtBytes(sourceBytes)} on disc
      </span>
      {out ? (
        <>
          <Icon.ChevronRight />
          <strong>≈ {fmtBytes(out)}</strong>
          {saved > 0 && <span className="badge green sm">−{saved}%</span>}
          <span className="small dim">
            {transcode ? 'after encoding' : 'ripped'}
            {estimate?.transcode?.low ? ` · ${fmtBytes(estimate.transcode.low)} – ${fmtBytes(estimate.transcode.high)}` : ''}
            {/* a smart profile decides per title, so say what it settled on rather than leaving a bare number */}
            {estimate?.transcode?.resolved ? ` · ${estimate.transcode.resolved}` : ''}
          </span>
          {transcode && parts && (
            <span className="ripEstimateBar" aria-hidden>
              <i className="v" style={{ flex: Math.max(1, parts.video) }} />
              <i className="a" style={{ flex: Math.max(1, parts.audio) }} />
              <i className="s" style={{ flex: Math.max(1, parts.subtitles + parts.other) }} />
            </span>
          )}
        </>
      ) : null}
    </span>
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

/**
 * The ripping to-do list (Settings → Experiments): what Radarr and Sonarr are still hoping to improve, read as
 * "which disc should I go and find".
 */
function RippingTodo() {
  const [list, setList] = useState<WantedDisc[] | null>(null);
  const [open, setOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .wanted()
      .then(setList)
      .catch((e) => setError((e as Error).message));
  }, []);
  if (error || !list?.length) return null;
  const shelf = list.filter((w) => w.onShelf).length;
  return (
    <div className="card mb">
      <div className="card-h" style={{ cursor: 'pointer' }} onClick={() => setOpen(!open)}>
        Insert disc for…
        <span className="badge sm">{list.length}</span>
        {shelf > 0 && <span className="badge sm green">{shelf} scanned</span>}
        <span className="spacer" />
        <span className="small dim">below the quality your profile asks for</span>
      </div>
      {open && (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Title</th>
                <th>On disk</th>
                <th>A disc would give</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.slice(0, 40).map((w) => (
                <tr key={`${w.kind}${w.arrId}${w.seasonNumber ?? ''}`}>
                  <td>
                    <Link to={w.kind === 'movie' ? `/movies/${w.arrId}` : `/series/${w.arrId}`}>{w.title}</Link>
                    {w.year ? <span className="dim"> ({w.year})</span> : null}
                    {w.seasonNumber !== undefined && <span className="dim"> · season {w.seasonNumber}</span>}
                    {w.episodes ? <span className="dim"> · {w.episodes} episode{w.episodes === 1 ? '' : 's'}</span> : null}
                    {w.onShelf && <span className="badge sm green" title="A barcode scan says this one is on the shelf">on the shelf</span>}
                  </td>
                  <td className="dim">{w.quality}</td>
                  <td>{w.upgradeWith === 'uhd' ? 'a UHD Blu-ray' : 'a Blu-ray'}</td>
                  <td className="num dim small">{w.kind === 'movie' ? 'film' : 'series'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
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

  /**
   * A box set is one item wherever its discs are. Grouping the visible tab's rips instead of all of them split a
   * set in two: a disc that finished moved to History, vanished from the set in Current, and came back there as an
   * "incoming" slot - the set claiming a disc it had already ripped had not been inserted.
   */
  const groups = useMemo(() => {
    const out: { key: string; batch: boolean; rips: DiscRip[] }[] = [];
    const byBatch = new Map<string, { key: string; batch: boolean; rips: DiscRip[] }>();
    for (const r of rips) {
      if (!r.batch) {
        out.push({ key: r.id, batch: false, rips: [r] });
        continue;
      }
      const existing = byBatch.get(r.batch.id);
      if (existing) {
        existing.rips.push(r);
        continue;
      }
      const g = { key: r.batch.id, batch: true, rips: [r] };
      byBatch.set(r.batch.id, g);
      out.push(g);
    }
    return out;
  }, [rips]);
  // A set is still going while any of its discs is, so it sits in Current until the last one is finished with.
  const activeGroups = useMemo(() => groups.filter((g) => g.rips.some((r) => ACTIVE.includes(r.status))), [groups]);
  const historyGroups = useMemo(() => groups.filter((g) => !g.rips.some((r) => ACTIVE.includes(r.status))), [groups]);
  const shown = tab === 'active' ? activeGroups : historyGroups;
  const count = (gs: typeof groups) => gs.reduce((n, g) => n + g.rips.length, 0);
  const active = { length: count(activeGroups) };
  const history = { length: count(historyGroups) };
  // which rip is in which drive, so a drive knows whether its disc has been copied yet
  const ripInDrive = useMemo(() => {
    const canon = (p: string) => p.replace(/^\/dev\/rdisk/, '/dev/disk');
    const m = new Map<number, DiscRip>();
    for (const d of drives) {
      if (!d.path) continue;
      const hit = rips.find((r) => r.drivePath && canon(r.drivePath) === canon(d.path) && r.status !== 'cancelled');
      if (hit) m.set(d.index, hit);
    }
    return m;
  }, [drives, rips]);
  const swappable = drives.filter((d) => !d.virtual && ripInDrive.get(d.index) && discFreed(ripInDrive.get(d.index)!));
  // a disc that has been read and is only waiting for someone to press start
  const readyToRip = useMemo(() => rips.filter((r) => r.status === 'ready' && r.selectedTitleIds.length > 0), [rips]);
  const waitingByBatch = useMemo(() => {
    const m = new Map<string, number[]>();
    for (const d of drives) if (d.awaiting) m.set(d.awaiting.batchId, [...(m.get(d.awaiting.batchId) ?? []), d.awaiting.discNumber]);
    return m;
  }, [drives]);

  return (
    <Page
      title="Discs"
      toolbarLeft={
        <>
          <ToolbarButton icon={<Icon.Disc />} label="Detect disc" wide disabled={busy || !makemkv?.available} onClick={() => api.detectDiscs().then((r) => toast('info', r.created.length ? `Found ${r.created.length} disc(s)` : 'No new disc in any drive')).catch((e) => toast('error', e.message))} />
          <ToolbarButton icon={<Icon.DriveAdd />} label="Add drive" wide onClick={() => setAddDrive(true)} title="Add a real optical drive by device path (/dev/sr0)" />
          <ToolbarButton icon={<Icon.Plus />} label="Virtual drive" wide disabled={!makemkv?.available} onClick={() => setOpenImage(true)} title="Link an .iso / .img or a BDMV / VIDEO_TS folder as a virtual drive" />
          <ToolbarSeparator />
          <ToolbarButton
            icon={<Icon.Play />}
            label="Rip all"
            wide
            disabled={busy || readyToRip.length === 0}
            title={readyToRip.length ? `Start all ${readyToRip.length} disc(s) that are read and waiting, with the titles and episodes already chosen for each` : 'No disc is read and waiting to be ripped'}
            onClick={() => {
              const list = readyToRip;
              // each disc keeps the titles, episodes and profile already settled on it - this only presses start
              Promise.allSettled(list.map((r) => api.startRip(r.id, {}))).then((rs) => {
                const failed = rs.filter((x) => x.status === 'rejected').length;
                toast(failed ? 'error' : 'info', failed ? `Started ${rs.length - failed} of ${rs.length}; ${failed} could not start` : `Started ${rs.length} disc(s)`);
                refresh(false);
              });
            }}
          />
          <ToolbarButton
            icon={<Icon.Eject />}
            label="Swap All"
            wide
            disabled={busy || swappable.length === 0}
            title={swappable.length ? `Eject ${swappable.length} drive(s) whose disc has been copied, and wait for the next disc of each set` : 'No drive has finished copying its disc yet'}
            onClick={() =>
              api
                .swapAllDrives()
                .then((r) => {
                  const told = r.swapped.filter((x) => x.waitingFor !== undefined);
                  toast('info', r.swapped.length ? `Ejected ${r.swapped.length} drive(s)${told.length ? `. Next: ${told.map((x) => `Disc ${x.waitingFor}`).join(', ')}` : ''}` : 'No drive had finished');
                })
                .then(() => refresh(true))
                .catch((e) => toast('error', e.message))
            }
          />
          <ToolbarSeparator />
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
      {settings?.experiments?.wanted === true && <RippingTodo />}

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
            rip={ripInDrive.get(d.index)}
            busy={busy}
            onSwap={() =>
              api
                .swapDrive(d.index)
                .then((r) => toast('info', r.waitingFor !== undefined ? `Ejected – put Disc ${r.waitingFor} of ${r.batch} in this drive` : 'Ejected'))
                .then(() => refresh(true))
                .catch((e) => toast('error', e.message))
            }
            onReadCd={() =>
              api.readCd(d.index)
                .then((r) => toast('info', (r.cd?.selected ?? -1) >= 0 ? `Audio CD: ${r.media.artist} – ${r.media.title}` : 'Audio CD read – nothing identifies it yet, pick a release on the Discs page'))
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
      {shown.length === 0 && (
        <div className="card">
          <div className="empty">
            <h3>{tab === 'active' ? 'No disc in progress' : 'No rips yet'}</h3>
            <p>{tab === 'active' ? 'Insert a Blu-ray or DVD. Rexarr reads it, identifies it, rips it with MakeMKV, transcodes it with your profile and hands it to Radarr / Sonarr.' : 'Finished, failed and cancelled rips show up here.'}</p>
          </div>
        </div>
      )}
      {shown.map((g) =>
        g.batch ? (
          <BatchCard key={g.key} rips={g.rips} onLog={setLogRip} onChanged={() => refresh(false)} waitingFor={waitingByBatch.get(g.key) ?? []} />
        ) : (
          <RipCard key={g.key} rip={g.rips[0]} onLog={setLogRip} />
        ),
      )}
      {logRip && <LogModal rip={logRip} onClose={() => setLogRip(null)} />}
      {addDrive && <AddDriveModal onClose={() => setAddDrive(false)} onAdded={() => refresh(true)} />}
      {openImage && <OpenImageModal onClose={() => setOpenImage(false)} onOpened={() => { setTab('active'); refresh(false); }} />}
    </Page>
  );
}
