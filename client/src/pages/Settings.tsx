import { URL_BASE } from '../base';
import { useEffect, useState } from 'react';
import type { ArrConnection, LocalMediaSettings, LocalScanStatus, Settings, SlskdConnection, SystemInfo } from '@shared/types';
import { api, fmtAge } from '../api';
import { useApp } from '../App';
import { Page, ToolbarButton, ToolbarText } from '../components/Layout';
import { Icon } from '../components/Icons';
import { ProfileSelect } from '../components/ProfileSelect';
import type { AnidbInfo, AutoScanResult, AutoStatus, AutoTranscodeSettings, HwAccel, HwDevices, HwTestResult, Profile, TranscodingSettings } from '@shared/types';
import { HW_ACCEL_INFO } from '@shared/presets';

const HW_ORDER: HwAccel[] = ['none', 'amf', 'nvenc', 'qsv', 'vaapi', 'rkmpp', 'videotoolbox', 'v4l2'];

function TranscodingCard({ t, onChange }: { t: TranscodingSettings; onChange: (t: TranscodingSettings) => void }) {
  const [devices, setDevices] = useState<HwDevices | null>(null);
  const [test, setTest] = useState<HwTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [showLog, setShowLog] = useState(false);
  useEffect(() => {
    api.transcodingDevices().then(setDevices).catch(() => {});
  }, []);
  const info = HW_ACCEL_INFO[t.hardwareAcceleration];
  const set = (patch: Partial<TranscodingSettings>) => {
    setTest(null);
    onChange({ ...t, ...patch });
  };
  const available = (m: HwAccel) => m === 'none' || (devices?.encoders[m]?.length ?? 0) > 0;
  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      setTest(await api.transcodingTest({ hardwareAcceleration: t.hardwareAcceleration, device: t.device, hardwareDecoding: t.hardwareDecoding }));
    } catch (e) {
      setTest({ ok: false, method: t.hardwareAcceleration, durationMs: 0, command: '', error: (e as Error).message, log: [] });
    } finally {
      setTesting(false);
    }
  };
  const renderNodes = devices?.renderNodes ?? [];
  return (
    <div className="card mb">
      <div className="card-h">
        Transcoding
        <span className="spacer" />
        <button className="btn sm" onClick={runTest} disabled={testing} title="Encode a 3-second 1080p test pattern with these settings (unsaved values are used)">
          {testing ? <span className="spinner" /> : <Icon.Play />} Test
        </button>
      </div>
      <div className="card-b">
        <div className="info small" style={{ marginTop: 0 }}>
          <strong>Software (CPU) encoding is highly recommended for the best quality.</strong> x265 and SVT-AV1 produce noticeably smaller files at the same visual quality than any hardware encoder – which matters when you are archiving Blu-ray remuxes. Hardware encoding is many times faster but typically needs 20–40% more bitrate for the same quality; use it for speed or bulk conversions.
        </div>
        <div className="grid-2">
          <div className="field stack">
            <label>Hardware acceleration</label>
            <select value={t.hardwareAcceleration} onChange={(e) => set({ hardwareAcceleration: e.target.value as HwAccel, device: '' })}>
              {HW_ORDER.map((m) => (
                <option key={m} value={m}>
                  {m === 'none' ? 'None (software / CPU) – recommended' : HW_ACCEL_INFO[m].label}
                  {devices && !available(m) ? ' – not in this ffmpeg build' : ''}
                </option>
              ))}
            </select>
            <div className="help">
              {info.hint} {t.hardwareAcceleration !== 'none' && <>Platforms: {info.platforms}. Encoders: {Object.values(info.encoders).join(', ')}.</>}
            </div>
            {devices && !available(t.hardwareAcceleration) && <div className="warn small">This ffmpeg build has none of the {info.label} encoders, so encodes will run on the CPU. Use an ffmpeg with {info.label} support (for example jellyfin-ffmpeg) and set its path below.</div>}
          </div>

          <div className="field stack">
            {info.device === 'render' && (
              <>
                <label>Render node</label>
                {renderNodes.length > 0 ? (
                  <select value={t.device || renderNodes[0].path} onChange={(e) => set({ device: e.target.value })}>
                    {renderNodes.map((n) => (
                      <option key={n.path} value={n.path}>
                        {n.path}
                        {n.vendor || n.driver ? ` – ${[n.vendor, n.driver].filter(Boolean).join(' / ')}` : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input type="text" value={t.device} placeholder="/dev/dri/renderD128" onChange={(e) => set({ device: e.target.value })} />
                )}
                <div className="help">The GPU device to use. {renderNodes.length === 0 ? (devices?.platform === 'linux' ? 'No /dev/dri render nodes were found – in Docker pass --device /dev/dri.' : 'Render nodes only exist on Linux.') : 'With several GPUs, renderD128 is usually the first (often the iGPU).'}</div>
              </>
            )}
            {info.device === 'gpu' && (
              <>
                <label>GPU</label>
                {devices && devices.nvidiaGpus.length > 0 ? (
                  <select value={t.device} onChange={(e) => set({ device: e.target.value })}>
                    <option value="">Default (GPU 0)</option>
                    {devices.nvidiaGpus.map((g) => (
                      <option key={g.index} value={String(g.index)}>
                        GPU {g.index} – {g.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input type="number" min={0} value={t.device} placeholder="0" onChange={(e) => set({ device: e.target.value })} />
                )}
                <div className="help">{devices?.nvidiaGpus.length ? 'Detected with nvidia-smi.' : 'nvidia-smi was not found; enter the GPU index. In Docker use the NVIDIA container runtime.'}</div>
              </>
            )}
            {info.device === 'none' && t.hardwareAcceleration !== 'none' && (
              <>
                <label>Device</label>
                <div className="dim small" style={{ paddingTop: 8 }}>{info.label} uses the system's default device.</div>
              </>
            )}
            {t.hardwareAcceleration !== 'none' && (
              <>
                <label className="check mt">
                  <input type="checkbox" checked={t.hardwareDecoding} onChange={(e) => set({ hardwareDecoding: e.target.checked })} /> Hardware decoding
                </label>
                <div className="help">Decode H.264 / HEVC / AV1 / VP9 sources on the GPU too. Other codecs (VC-1, MPEG-2 on some paths) and subtitle burn-in fall back to CPU decoding automatically.</div>
                <label className="check mt">
                  <input type="checkbox" checked={t.fallbackToSoftware} onChange={(e) => set({ fallbackToSoftware: e.target.checked })} /> Fall back to software if a hardware encode fails
                </label>
              </>
            )}
          </div>
        </div>
        {t.hardwareAcceleration !== 'none' && (
          <div className="small dim">
            Profiles that use x264, x265 or SVT-AV1 are encoded with the matching {info.label} encoder (quality and preset are translated). AV1 falls back to the CPU when the method has no AV1 encoder. Set a profile to <em>Software only</em> in its editor to keep it on the CPU.
          </div>
        )}
        {test && (
          <div className="mt">
            <div className={test.ok ? 'success small' : 'error small'}>
              {test.ok ? (
                <>
                  <strong>Test passed</strong> – {test.encoder} encoded 3 s of 1080p in {(test.durationMs / 1000).toFixed(1)} s{test.fps ? ` (${Math.round(test.fps)} fps)` : ''}.{test.note ? ` ${test.note}.` : ''}
                </>
              ) : (
                <>
                  <strong>Test failed</strong>{test.encoder ? ` (${test.encoder})` : ''}: {test.error}
                </>
              )}{' '}
              <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => setShowLog((v) => !v)}>
                <Icon.Terminal /> {showLog ? 'Hide' : 'Show'} log
              </button>
            </div>
            {showLog && (
              <pre className="log" style={{ maxHeight: 220 }}>
                {test.command}
                {'\n\n'}
                {test.log.join('\n')}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function AutoProfileSelect({ label, value, fallback, profiles, onChange }: { label: string; value: string; fallback: string; profiles: Profile[]; onChange: (v: string) => void }) {
  const def = profiles.find((p) => p.id === fallback);
  return (
    <div className="field stack">
      <label>{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Default profile{def ? ` (${def.name})` : ''}</option>
        {profiles.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function AutoCard({ auto, savedEnabled, defaults, profiles, dirty, onChange }: { auto: AutoTranscodeSettings; savedEnabled: boolean; defaults: { movie: string; tv: string; anime: string }; profiles: Profile[]; dirty: boolean; onChange: (a: AutoTranscodeSettings) => void }) {
  const { toast } = useApp();
  const [status, setStatus] = useState<AutoStatus | null>(null);
  const [preview, setPreview] = useState<AutoScanResult | null>(null);
  const [busy, setBusy] = useState<'' | 'preview' | 'scan' | 'reset'>('');
  const load = () => api.autoStatus().then(setStatus).catch(() => {});
  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);
  const run = async (kind: 'preview' | 'scan' | 'reset') => {
    setBusy(kind);
    try {
      if (kind === 'preview') setPreview(await api.autoScan(true));
      else if (kind === 'scan') {
        const r = await api.autoScan(false);
        setPreview(null);
        toast('info', r.baseline !== undefined ? `Baseline taken: ${r.baseline} existing remux file(s) will be left alone` : `Queued ${r.queued.length} of ${r.found} remux file(s)${r.pending.length ? `, ${r.pending.length} next scan` : ''}`);
      } else if (confirm('Forget every file auto transcode has seen? Unless “include existing library” is on, the next scan takes a new baseline.')) {
        await api.autoReset();
        toast('info', 'Auto transcode history cleared');
      }
      await load();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy('');
    }
  };
  const set = (patch: Partial<AutoTranscodeSettings>) => onChange({ ...auto, ...patch });
  // Application URL (Settings → General) when set; the API key lets the webhook through authentication.
  const { settings: saved } = useApp();
  const origin = (saved?.general.host.applicationUrl || `${window.location.origin}${URL_BASE}`).replace(/\/+$/, '');
  const hookQuery = saved && saved.general.security.authentication !== 'none' ? `?apikey=${saved.general.security.apiKey}` : '';
  const last = status?.lastScan;
  const shown = preview ?? null;
  return (
    <div className="card mb">
      <div className="card-h">
        <label className="check">
          <input type="checkbox" checked={auto.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Auto transcode new remuxes
        </label>
        <span className="spacer" />
        {status?.scanning && <span className="badge blue">Scanning…</span>}
        <button className="btn sm" onClick={() => run('preview')} disabled={Boolean(busy)} title="List what would be queued now, without queueing anything">
          {busy === 'preview' ? <span className="spinner" /> : <Icon.Search />} Preview
        </button>
        <button className="btn sm primary" onClick={() => run('scan')} disabled={Boolean(busy) || !savedEnabled || dirty} title={!savedEnabled ? 'Enable and save first' : dirty ? 'Save your changes first' : 'Scan Radarr / Sonarr now'}>
          {busy === 'scan' ? <span className="spinner" /> : <Icon.Play />} Scan now
        </button>
      </div>
      <div className="card-b">
        <p className="small dim" style={{ marginTop: 0 }}>
          Every Blu-ray remux that appears in Radarr or Sonarr is queued automatically with the profile for its type – movie, TV or anime (Sonarr's anime type or AniDB). Files rexarr has already queued or written are remembered, so a transcode that Radarr / Sonarr re-import is never transcoded again.
        </p>
        <div className="grid-2">
          <div>
            <label className="check mb">
              <input type="checkbox" checked={auto.sources.radarr} onChange={(e) => set({ sources: { ...auto.sources, radarr: e.target.checked } })} /> Movies from Radarr
            </label>
            <label className="check mb">
              <input type="checkbox" checked={auto.sources.sonarr} onChange={(e) => set({ sources: { ...auto.sources, sonarr: e.target.checked } })} /> Episodes from Sonarr
            </label>
            <label className="check mb" title="Off: remuxes already in the library when you enable this are left alone">
              <input type="checkbox" checked={auto.includeExisting} onChange={(e) => set({ includeExisting: e.target.checked })} /> Also transcode remuxes already in the library
            </label>
            {auto.includeExisting && <div className="warn small">Every existing remux will be transcoded, {auto.maxPerScan} per scan. Use Preview to see how many that is.</div>}
          </div>
          <div className="grid-2">
            <div className="field stack">
              <label>Scan every (minutes)</label>
              <input type="number" min={1} max={1440} value={auto.scanIntervalMinutes} onChange={(e) => set({ scanIntervalMinutes: Number(e.target.value) })} />
            </div>
            <div className="field stack">
              <label>Max new jobs per scan</label>
              <input type="number" min={1} max={500} value={auto.maxPerScan} onChange={(e) => set({ maxPerScan: Number(e.target.value) })} />
            </div>
          </div>
        </div>
        <div className="grid-3">
          <AutoProfileSelect label="Profile · Movies" value={auto.profiles.movie} fallback={defaults.movie} profiles={profiles} onChange={(v) => set({ profiles: { ...auto.profiles, movie: v } })} />
          <AutoProfileSelect label="Profile · TV" value={auto.profiles.tv} fallback={defaults.tv} profiles={profiles} onChange={(v) => set({ profiles: { ...auto.profiles, tv: v } })} />
          <AutoProfileSelect label="Profile · Anime" value={auto.profiles.anime} fallback={defaults.anime} profiles={profiles} onChange={(v) => set({ profiles: { ...auto.profiles, anime: v } })} />
        </div>
        <div className="field stack">
          <label>Instant trigger (optional)</label>
          <div className="help" style={{ marginTop: 0 }}>
            In Radarr / Sonarr → Settings → Connect → Webhook, tick <em>On Import</em> and <em>On Upgrade</em> and use these URLs; a scan then runs 15 seconds after each import instead of waiting for the schedule.
          </div>
          <div className="inline mt" style={{ gap: 8 }}>
            {(['radarr', 'sonarr'] as const).map((a) => (
              <button key={a} className="btn sm" onClick={() => navigator.clipboard.writeText(`${origin}/api/webhook/${a}${hookQuery}`).then(() => toast('info', `${a === 'radarr' ? 'Radarr' : 'Sonarr'} webhook URL copied`))}>
                <Icon.Copy /> <code>{`${origin}/api/webhook/${a}${hookQuery ? '?apikey=…' : ''}`}</code>
              </button>
            ))}
          </div>
        </div>
        {status && (
          <div className="small dim mt inline" style={{ gap: 14 }}>
            <span>{status.counts.queued} queued automatically</span>
            <span>{status.counts.baseline} existing ignored{status.baselineAt ? ` (baseline ${new Date(status.baselineAt).toLocaleDateString()})` : ''}</span>
            <span>{status.counts.output} transcodes remembered</span>
            {last && (
              <span>
                last scan {new Date(last.at).toLocaleString()} ({last.reason}): {last.baseline !== undefined ? `baseline of ${last.baseline}` : `${last.found} found, ${last.queued.length} queued`}
                {last.skippedMissing.length ? `, ${last.skippedMissing.length} not visible` : ''}
              </span>
            )}
            <span className="spacer" />
            <button className="btn sm" onClick={() => run('reset')} disabled={Boolean(busy)}>
              <Icon.Trash /> Reset history
            </button>
          </div>
        )}
        {shown && (
          <div className="mt">
            <div className={shown.queued.length ? 'info small' : 'warn small'}>
              Preview: {shown.found} remux file(s) found · {shown.queued.length} would be queued now{shown.pending.length ? ` · ${shown.pending.length} in later scans` : ''} · {shown.skippedSeen} already handled
              {!status?.baselineAt && !auto.includeExisting ? ' · the first real scan only takes a baseline because “already in the library” is off' : ''}
            </div>
            {shown.skippedMissing.length > 0 && <div className="warn small">{shown.skippedMissing.length} file(s) are not visible to rexarr (check path mappings), e.g. {shown.skippedMissing[0]}</div>}
            {shown.errors.map((e, i) => (
              <div key={i} className="error small">
                {e}
              </div>
            ))}
            {shown.queued.length > 0 && (
              <div className="tbl-wrap" style={{ maxHeight: 260, overflow: 'auto' }}>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Title</th>
                      <th>Quality</th>
                      <th>Profile</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.queued.slice(0, 50).map((q) => (
                      <tr key={q.localPath}>
                        <td>
                          {q.title}
                          {q.subtitle && <span className="dim small"> · {q.subtitle}</span>}
                        </td>
                        <td>
                          <span className="badge remux sm">{q.quality}</span>
                        </td>
                        <td className="dim">{q.profileName}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function AnidbCard({ enabled, onChange }: { enabled: boolean; onChange: (on: boolean) => void }) {
  const { toast } = useApp();
  const [info, setInfo] = useState<AnidbInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.anidbStatus().then(setInfo).catch(() => {});
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  const refresh = async () => {
    setBusy(true);
    try {
      setInfo(await api.anidbRefresh());
      toast('info', 'AniDB data refreshed');
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card mb">
      <div className="card-h">
        <label className="check">
          <input type="checkbox" checked={enabled} onChange={(e) => onChange(e.target.checked)} /> AniDB for anime
        </label>
        <span className="spacer" />
        {info?.loading && <span className="badge blue">Downloading…</span>}
        {info?.loaded && !info.loading && <span className="badge green">{info.animeCount.toLocaleString()} anime · {info.mappingCount.toLocaleString()} mappings</span>}
        {info?.error && <span className="badge red" title={info.error}>Error</span>}
        <button className="btn sm" onClick={refresh} disabled={busy || !info?.enabled}>
          {busy ? <span className="spinner" /> : <Icon.Refresh />} Refresh
        </button>
      </div>
      <div className="card-b">
        <p className="small dim" style={{ marginTop: 0 }}>
          Downloads AniDB's title list and the Anime-Lists mapping (AniDB ↔ TVDB / TMDB / IMDb) – about 20 MB, cached for a week, no API key. Used to flag anime movies in Radarr (which has no anime type), show and sort by romaji titles, identify discs from Japanese or romaji labels, and pick the anime profile automatically.
        </p>
        {info?.error && <div className="error small">{info.error}</div>}
        {info?.updatedAt && <div className="small muted">Data from {new Date(info.updatedAt).toLocaleString()}. Save settings after enabling to start the download.</div>}
      </div>
    </div>
  );
}

/** Soulseek via slskd. */
function SlskdCard({ conn, onChange }: { conn: SlskdConnection; onChange: (c: SlskdConnection) => void }) {
  return (
    <ArrCard name="slskd" label="Soulseek (slskd)" hint="music peer-to-peer" conn={conn} onChange={(c) => onChange({ ...conn, ...c })} placeholder="http://localhost:5030" keyHint="slskd.yml → web.authentication.api_keys">
      <div className="field">
        <label>Downloads path</label>
        <input type="text" value={conn.downloadsPath} onChange={(e) => onChange({ ...conn, downloadsPath: e.target.value })} placeholder="Empty = slskd's download folder (with path mappings)" />
        <div className="help">Where rexarr sees slskd's finished downloads. Lidarr must see the same folder to import (add a Lidarr path mapping if the paths differ).</div>
      </div>
      <div className="grid-2">
        <div className="field">
          <label>Max peer queue</label>
          <input type="number" min={0} value={conn.maxQueueLength} onChange={(e) => onChange({ ...conn, maxQueueLength: Number(e.target.value) })} />
        </div>
        <div className="field">
          <label>Search time (s)</label>
          <input type="number" min={5} max={60} value={conn.searchTimeoutSeconds} onChange={(e) => onChange({ ...conn, searchTimeoutSeconds: Number(e.target.value) })} />
        </div>
      </div>
    </ArrCard>
  );
}

/** fre:ac command line encoder status. */
function FreacCard({ path, onChange }: { path: string; onChange: (p: string) => void }) {
  const [info, setInfo] = useState<SystemInfo['freac'] | null>(null);
  const [busy, setBusy] = useState(false);
  const check = async () => {
    setBusy(true);
    try {
      setInfo(await api.freac(true));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    api.freac().then(setInfo).catch(() => undefined);
  }, []);
  const open = ['flac', 'lame', 'opus', 'vorbis', 'wv', 'mac'];
  return (
    <div className="card">
      <div className="card-h">
        fre:ac
        <span className="spacer" />
        <span className="small dim">music encodes & CD ripping</span>
      </div>
      <div className="card-b">
        <div className="field">
          <label>freaccmd binary</label>
          <input type="text" value={path} onChange={(e) => onChange(e.target.value)} placeholder="Empty = auto-detect (/Applications/freac.app, /usr/bin …)" />
          <div className="help">
            Music profiles are encoded by <a href="https://www.freac.org/" target="_blank" rel="noreferrer">fre:ac</a> with open-source encoders only: libFLAC, LAME, libopus, libvorbis, WavPack and Monkey's Audio. FFmpeg handles resampling (soxr), ReplayGain and MQA scans.
          </div>
        </div>
        <div className="inline">
          <button className="btn sm" onClick={check} disabled={busy}>
            {busy ? <span className="spinner" /> : <Icon.Refresh />} Check
          </button>
          {info &&
            (info.available ? (
              <>
                <span className="badge green">fre:ac {info.version}</span>
                {open.map((e) => (
                  <span key={e} className={`badge sm ${info.encoders.includes(e) ? 'outline green' : 'red'}`} title={info.encoders.includes(e) ? 'available' : 'missing from this fre:ac build'}>
                    {e}
                  </span>
                ))}
              </>
            ) : (
              <span className="badge red" title={info.path}>
                {info.error ?? 'not found'}
              </span>
            ))}
        </div>
      </div>
    </div>
  );
}

function ArrCard({ name, label, hint, conn, onChange, placeholder, keyHint, children }: { name: 'radarr' | 'sonarr' | 'prowlarr' | 'lidarr' | 'slskd'; label: string; hint: string; conn: ArrConnection; onChange: (c: ArrConnection) => void; placeholder?: string; keyHint?: string; children?: React.ReactNode }) {
  const [test, setTest] = useState<{ ok: boolean; msg: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [show, setShow] = useState(false);
  const run = async () => {
    setTesting(true);
    setTest(null);
    try {
      const r = await api.testConnection(name, { url: conn.url, apiKey: conn.apiKey });
      setTest(r.ok ? { ok: true, msg: `Connected to ${r.appName ?? label} v${r.version}` } : { ok: false, msg: r.error ?? 'Failed' });
    } catch (e) {
      setTest({ ok: false, msg: (e as Error).message });
    } finally {
      setTesting(false);
    }
  };
  return (
    <div className="card">
      <div className="card-h">
        <label className="check">
          <input type="checkbox" checked={conn.enabled} onChange={(e) => onChange({ ...conn, enabled: e.target.checked })} /> {label}
        </label>
        <span className="spacer" />
        <span className="small dim">{hint}</span>
      </div>
      <div className="card-b">
        <div className="field">
          <label>URL</label>
          <input type="text" value={conn.url} onChange={(e) => onChange({ ...conn, url: e.target.value })} placeholder={placeholder ?? 'http://localhost:7878'} />
        </div>
        <div className="field">
          <label>API key</label>
          <div className="inline" style={{ flexWrap: 'nowrap' }}>
            <input type={show ? 'text' : 'password'} value={conn.apiKey} onChange={(e) => onChange({ ...conn, apiKey: e.target.value })} placeholder={keyHint ?? 'Settings → General → API Key'} autoComplete="off" />
            <button className="btn sm" onClick={() => setShow((s) => !s)}>
              {show ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>
        <div className="inline">
          <button className="btn sm" onClick={run} disabled={testing || !conn.url || !conn.apiKey}>
            {testing ? <span className="spinner" /> : <Icon.Check />} Test
          </button>
          {test && <span className={`badge ${test.ok ? 'green' : 'red'}`}>{test.msg}</span>}
        </div>
        {children && <div className="mt">{children}</div>}
      </div>
    </div>
  );
}

/** Folders scanned for titles the *arr apps do not manage (they show up in search as "Local"). */
function LocalMediaCard({ value, onChange, dirty }: { value: LocalMediaSettings; onChange: (v: LocalMediaSettings) => void; dirty: boolean }) {
  const [status, setStatus] = useState<LocalScanStatus | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const load = () =>
      api
        .localStatus()
        .then((st) => {
          setStatus(st);
          timer = setTimeout(load, st.scanning || st.metadata?.running ? 1500 : 15000);
        })
        .catch(() => (timer = setTimeout(load, 15000)));
    load();
    return () => clearTimeout(timer);
  }, []);
  const c = status?.counts;
  const set = (patch: Partial<LocalMediaSettings>) => onChange({ ...value, ...patch });
  return (
    <div className="card">
      <div className="card-h">
        Local media
        <span className="small dim">titles outside Radarr / Sonarr / Lidarr</span>
        <span className="spacer" />
        <button className="btn sm" disabled={!value.enabled || status?.scanning} onClick={() => api.localScan().then(setStatus)} title={dirty ? 'Save first to scan the new folders' : undefined}>
          {status?.scanning ? <span className="spinner" /> : <Icon.Refresh />} Rescan
        </button>
      </div>
      <div className="card-b">
        <p className="small dim" style={{ marginTop: 0 }}>
          Not everything is added to the *arr apps. rexarr scans these folders for movies, series / anime and music albums (from folder and file names) and shows the ones no *arr app manages in search, marked <strong>Local</strong>, where they can be encoded like library files.
        </p>
        <div className="grid-2">
          <label className="check mb">
            <input type="checkbox" checked={value.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Include local media in search
          </label>
          <label className="check mb">
            <input type="checkbox" checked={value.usePathMappings} onChange={(e) => set({ usePathMappings: e.target.checked })} /> Scan the local folder of every path mapping
          </label>
          <label className="check mb">
            <input type="checkbox" checked={value.hideArrManaged} onChange={(e) => set({ hideArrManaged: e.target.checked })} /> Hide titles an *arr app already manages
          </label>
          <div className="inline mb" style={{ flexWrap: 'nowrap', gap: 8 }}>
            <label style={{ whiteSpace: 'nowrap' }}>Rescan every</label>
            <input type="number" min={0} max={720} style={{ width: 80 }} value={value.rescanHours} onChange={(e) => set({ rescanHours: Number(e.target.value) })} />
            <span className="dim">hours (0 = manual)</span>
          </div>
        </div>

        <div className="inline mt mb">
          <strong>Folders</strong>
          <span className="spacer" />
          <button className="btn sm" onClick={() => set({ folders: [...value.folders, { path: '', kind: 'auto' }] })}>
            <Icon.Plus /> Add folder
          </button>
        </div>
        {value.folders.map((f, i) => (
          <div key={i} className="inline mb" style={{ flexWrap: 'nowrap' }}>
            <select style={{ width: 120, flexShrink: 0 }} value={f.kind} onChange={(e) => set({ folders: value.folders.map((x, j) => (j === i ? { ...x, kind: e.target.value as typeof f.kind } : x)) })} title="What the folder holds">
              <option value="auto">Auto</option>
              <option value="movie">Movies</option>
              <option value="series">Series / anime</option>
              <option value="music">Music</option>
            </select>
            <input type="text" className="mono" placeholder="/Volumes/Media/Movies or smb://server/Share" value={f.path} onChange={(e) => set({ folders: value.folders.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)) })} />
            <button className="iconButton danger" onClick={() => set({ folders: value.folders.filter((_, j) => j !== i) })} title="Remove">
              <Icon.X />
            </button>
          </div>
        ))}
        {value.folders.length > 0 && <div className="help mb">Network shares can be entered as <span className="mono">smb://server/Share</span>; they are read where the share is mounted on this machine (Finder → Go → Connect to Server, or /etc/fstab on Linux).</div>}
        {status && status.roots.length > 0 && (
          <div className="small mb">
            {status.roots.map((r) => (
              <div key={r.path} className="inline" style={{ gap: 6 }}>
                <span className={`badge sm ${r.exists ? 'green' : 'red'}`}>{r.exists ? r.kind : 'missing'}</span>
                <span className="mono">{r.path}</span>
                {r.fromMapping && <span className="dim">(path mapping)</span>}
              </div>
            ))}
          </div>
        )}
        {status && !status.roots.length && <div className="muted small mb">No folders yet – add one, or a path mapping.</div>}

        <div className="inline mt mb">
          <strong>Metadata</strong>
          <span className="spacer" />
          <button className="btn sm" disabled={!value.metadata || status?.metadata?.running} onClick={() => api.localMetadataRefresh().then(setStatus)} title="Match titles that have no metadata yet">
            {status?.metadata?.running ? <span className="spinner" /> : <Icon.Refresh />} Match now
          </button>
        </div>
        <label className="check mb">
          <input type="checkbox" checked={value.metadata} onChange={(e) => set({ metadata: e.target.checked })} /> Fetch posters, overviews and genres – TMDb for movies and series, MusicBrainz and Cover Art Archive for albums
        </label>
        <div className="grid-2">
          <div className="field stack">
            <label>TMDb API key</label>
            <input type="password" autoComplete="off" className="mono" value={value.tmdbApiKey} placeholder="v3 API key or v4 read access token" onChange={(e) => set({ tmdbApiKey: e.target.value })} />
            <div className="help">
              Free at <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer">themoviedb.org → Settings → API</a>. Without a key, movies are matched through Radarr's lookup (TMDb data) and series through Sonarr's (TheTVDB).
            </div>
          </div>
          <div className="field stack">
            <label>TMDb language</label>
            <input type="text" value={value.metadataLanguage} placeholder="en-US" onChange={(e) => set({ metadataLanguage: e.target.value })} />
            <div className="help">Titles and overviews, e.g. en-US, ja-JP, de-DE.</div>
          </div>
        </div>

        <div className="field stack">
          <label>Skip folders named</label>
          <input type="text" value={value.exclude.join(', ')} onChange={(e) => set({ exclude: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
          <div className="help">Comma separated, anywhere in the tree (samples, extras, NAS recycle bins, game libraries…).</div>
        </div>

        {status && (
          <div className="small dim mt">
            {status.scanning ? (
              <>
                <span className="spinner" /> Scanning… {status.progress?.folders ?? 0} folders, {status.progress?.files ?? 0} media files
                {status.progress?.current && <div className="mono truncate">{status.progress.current}</div>}
              </>
            ) : status.scannedAt ? (
              <>
                Last scan {fmtAge(status.scannedAt)}
                {status.durationMs ? ` (${Math.round(status.durationMs / 1000)} s)` : ''}: {c?.movie ?? 0} movies · {c?.series ?? 0} series · {c?.album ?? 0} albums · {c?.files ?? 0} files outside the *arr apps
                {c?.hiddenArr ? ` · ${c.hiddenArr} titles hidden (managed by *arr)` : ''}
              </>
            ) : (
              'Not scanned yet'
            )}
            {status.metadata && (status.metadata.running || status.metadata.total > 0 || status.metadata.matched > 0) && (
              <div className="mt">
                {status.metadata.running ? (
                  <>
                    <span className="spinner" /> Matching metadata ({status.metadata.source}): {status.metadata.done} / {status.metadata.total}, {status.metadata.matched} matched
                  </>
                ) : (
                  <>Metadata: {status.metadata.matched} titles matched</>
                )}
              </div>
            )}
            {status.errors.slice(0, 3).map((e) => (
              <div key={e} className="warn small mt">
                {e}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function SettingsPage() {
  const { settings, profiles, reloadSettings, toast } = useApp();
  const [s, setS] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (settings) setS(structuredClone(settings));
  }, [settings]);
  if (!s) return <Page title="Settings"><div className="empty"><span className="spinner" /></div></Page>;

  const save = async () => {
    setSaving(true);
    try {
      await api.saveSettings(s);
      await reloadSettings();
      toast('info', 'Settings saved');
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const dirty = JSON.stringify(s) !== JSON.stringify(settings);

  return (
    <Page
      title="Settings"
      narrow
      toolbarLeft={
        <>
          <ToolbarButton icon={<Icon.Save />} label="Save" busy={saving} disabled={!dirty} onClick={save} selected={dirty} />
          {dirty && <ToolbarText>Unsaved changes</ToolbarText>}
        </>
      }
    >
      <div className="legend">Connections</div>
      <div className="grid-3 mb">
        <ArrCard name="radarr" label="Radarr" hint="movies" conn={s.radarr} onChange={(c) => setS({ ...s, radarr: c })} />
        <ArrCard name="sonarr" label="Sonarr" hint="series & anime" conn={s.sonarr} onChange={(c) => setS({ ...s, sonarr: c })} />
        <ArrCard name="prowlarr" label="Prowlarr" hint="optional raw search" conn={s.prowlarr} onChange={(c) => setS({ ...s, prowlarr: c })} />
        <ArrCard name="lidarr" label="Lidarr" hint="music" conn={s.lidarr} onChange={(c) => setS({ ...s, lidarr: { ...s.lidarr, ...c } })} placeholder="http://localhost:8686">
          <label className="check mt">
            <input type="checkbox" checked={s.lidarr.splitCueImages !== false} onChange={(e) => setS({ ...s, lidarr: { ...s.lidarr, splitCueImages: e.target.checked } })} /> Split “image + cue” downloads for Lidarr
          </label>
          <div className="help">Lidarr cannot import an album that is one long FLAC / APE / WavPack file with a cue sheet. rexarr splits finished downloads into tagged FLAC tracks with fre:ac (Shift-JIS and other non-UTF-8 cue sheets included) and has Lidarr import them for the same download.</div>
        </ArrCard>
        <SlskdCard conn={s.slskd} onChange={(c) => setS({ ...s, slskd: c })} />
        <FreacCard path={s.freacPath} onChange={(p) => setS({ ...s, freacPath: p })} />
      </div>

      <div className="legend">Encoding</div>
      <TranscodingCard t={s.transcoding} onChange={(t) => setS({ ...s, transcoding: t })} />
      <div className="grid-2 mb">
        <div className="card">
          <div className="card-h">FFmpeg</div>
          <div className="card-b">
            <div className="field">
              <label>ffmpeg binary</label>
              <input type="text" value={s.ffmpegPath} onChange={(e) => setS({ ...s, ffmpegPath: e.target.value })} />
              <div className="help">A name on PATH or an absolute path. Hardware encoders need a build compiled with NVENC / QSV / VAAPI / VideoToolbox.</div>
            </div>
            <div className="field">
              <label>Write encodes to</label>
              <select value={s.transcodeTemp} onChange={(e) => setS({ ...s, transcodeTemp: e.target.value as 'transcodes' | 'output' })}>
                <option value="transcodes">Transcodes folder, then move into place</option>
                <option value="output">Next to the output file</option>
              </select>
              <div className="help">The Transcodes folder keeps partial files in one place and cleans up after crashes, but needs room for a whole encode and a copy when it is on a different disk than your media. Paths are listed on System → Status.</div>
            </div>
            <div className="field">
              <label>Stop stalled encodes after</label>
              <div className="inline" style={{ flexWrap: 'nowrap', gap: 8 }}>
                <input type="number" min={0} max={1440} style={{ width: 90 }} value={s.stallTimeoutMinutes ?? 10} onChange={(e) => setS({ ...s, stallTimeoutMinutes: Number(e.target.value) })} />
                <span className="dim">minutes without progress (0 = never)</span>
              </div>
              <div className="help">An encode whose source stops delivering data (a network share that hung, a disk that went away) otherwise waits forever. The job fails with an explanation and can be retried.</div>
            </div>
            <div className="field">
              <label>ffprobe binary</label>
              <input type="text" value={s.ffprobePath} onChange={(e) => setS({ ...s, ffprobePath: e.target.value })} />
            </div>
            <div className="grid-2">
              <div className="field">
                <label>Simultaneous encodes</label>
                <input type="number" min={1} max={16} value={s.concurrency} onChange={(e) => setS({ ...s, concurrency: Number(e.target.value) })} />
              </div>
              <div className="field">
                <label>Import poll interval (s)</label>
                <input type="number" min={10} max={3600} value={s.pollIntervalSeconds} onChange={(e) => setS({ ...s, pollIntervalSeconds: Number(e.target.value) })} />
                <div className="help">How often rexarr asks Radarr/Sonarr whether a grabbed release has been imported.</div>
              </div>
            </div>
          </div>
        </div>
        <div className="card">
          <div className="card-h">Defaults</div>
          <div className="card-b">
            <label className="check mb">
              <input type="checkbox" checked={s.remuxOnly} onChange={(e) => setS({ ...s, remuxOnly: e.target.checked })} /> Only show Blu-ray remux releases in search results
            </label>
            <label className="check mb">
              <input type="checkbox" checked={s.searchDiscReleases ?? true} disabled={!s.remuxOnly} onChange={(e) => setS({ ...s, searchDiscReleases: e.target.checked })} /> Also show full-disc releases (Blu-ray / UHD / DVD ISO, BDMV, VIDEO_TS)
              <span className="hint" style={{ display: 'block', marginLeft: 22 }}>Grabbed discs are ripped with MakeMKV when the download finishes, then transcoded and imported.</span>
            </label>
            <div className="field">
              <label>Default profile · Movies</label>
              <ProfileSelect profiles={profiles} value={s.defaultProfiles.movie} onChange={(v) => setS({ ...s, defaultProfiles: { ...s.defaultProfiles, movie: v } })} mediaType="movie" />
            </div>
            <div className="field">
              <label>Default profile · TV</label>
              <ProfileSelect profiles={profiles} value={s.defaultProfiles.tv} onChange={(v) => setS({ ...s, defaultProfiles: { ...s.defaultProfiles, tv: v } })} mediaType="tv" />
            </div>
            <div className="field">
              <label>Default profile · Anime</label>
              <ProfileSelect profiles={profiles} value={s.defaultProfiles.anime} onChange={(v) => setS({ ...s, defaultProfiles: { ...s.defaultProfiles, anime: v } })} mediaType="anime" />
              <div className="help">Applied automatically when a Sonarr series is typed “anime”.</div>
            </div>
            <div className="field">
              <label>Default profile · Music</label>
              <ProfileSelect profiles={profiles} value={s.defaultProfiles.music} onChange={(v) => setS({ ...s, defaultProfiles: { ...s.defaultProfiles, music: v } })} mediaType="music" />
              <div className="help">Used for Lidarr / Soulseek grabs and CD rips. “Keep as downloaded” imports without encoding.</div>
            </div>
          </div>
        </div>
      </div>

      <div className="legend">Automation</div>
      <AutoCard auto={s.auto} savedEnabled={Boolean(settings?.auto?.enabled)} defaults={s.defaultProfiles} profiles={profiles} dirty={dirty} onChange={(a) => setS({ ...s, auto: a })} />

      <div className="legend">Metadata</div>
      <AnidbCard enabled={s.anidb.enabled} onChange={(on) => setS({ ...s, anidb: { ...s.anidb, enabled: on } })} />
      <div className="card mb">
        <div className="card-h">
          <label className="check">
            <input type="checkbox" checked={s.musicbrainz.enabled} onChange={(e) => setS({ ...s, musicbrainz: { enabled: e.target.checked } })} /> MusicBrainz & Cover Art Archive
          </label>
          <span className="spacer" />
          <span className="small dim">no account needed</span>
        </div>
        <div className="card-b small dim">
          Identifies audio CDs by their disc id, tags rips with artist / album / track titles, MusicBrainz ids, label, barcode and release date, and embeds the front cover. Requests are limited to one per second.
        </div>
      </div>

      <div className="legend">Disc ripping</div>
      <div className="card mb">
        <div className="card-h">
          <label className="check">
            <input type="checkbox" checked={s.disc.enabled} onChange={(e) => setS({ ...s, disc: { ...s.disc, enabled: e.target.checked } })} /> Disc ripping (automatic ripping machine)
          </label>
          <span className="spacer" />
          <span className="small dim">needs MakeMKV</span>
        </div>
        <div className="card-b">
          <p className="small dim" style={{ marginTop: 0 }}>
            When enabled, rexarr watches your optical drives. Inserting a Blu-ray or DVD reads the title list, identifies it through Radarr / Sonarr, rips it with MakeMKV to a remux MKV, optionally transcodes it with the default profile, hands it to the *arr app for import and ejects the disc.
          </p>
          <div className="grid-2">
            <div className="field">
              <label>makemkvcon binary</label>
              <input type="text" value={s.disc.makemkvPath} onChange={(e) => setS({ ...s, disc: { ...s.disc, makemkvPath: e.target.value } })} placeholder="makemkvcon" />
              <div className="help">Auto-detected from the MakeMKV app on macOS and /usr/bin on Linux when left as “makemkvcon”.</div>
            </div>
            <div className="field">
              <label>Rip directory</label>
              <input type="text" value={s.disc.ripDirectory} onChange={(e) => setS({ ...s, disc: { ...s.disc, ripDirectory: e.target.value } })} placeholder="Empty = <data dir>/rips" />
              <div className="help">Needs space for a full disc (up to 100 GB for UHD). Should be visible to Radarr / Sonarr for import.</div>
            </div>
            <div className="field">
              <label>Minimum title length (seconds)</label>
              <input type="number" min={0} value={s.disc.minTitleSeconds} onChange={(e) => setS({ ...s, disc: { ...s.disc, minTitleSeconds: Number(e.target.value) } })} />
              <div className="help">Skips trailers and menus. 600 for movies, 1200 for hour-long episodes, lower for short anime episodes.</div>
            </div>
            <div className="field">
              <label>Drive poll interval (seconds)</label>
              <input type="number" min={5} value={s.disc.pollIntervalSeconds} onChange={(e) => setS({ ...s, disc: { ...s.disc, pollIntervalSeconds: Number(e.target.value) } })} />
            </div>
          </div>
          <div className="field stack">
            <label>Virtual drives folder (testing)</label>
            <input type="text" value={s.disc.virtualDriveDirectory} onChange={(e) => setS({ ...s, disc: { ...s.disc, virtualDriveDirectory: e.target.value } })} placeholder="e.g. /path/to/test-media/discs" />
            <div className="help">Every .iso file or DVD / Blu-ray folder (VIDEO_TS, BDMV) in this folder appears as a loaded drive and is ripped through MakeMKV without hardware. Run <code>npm run test-media</code> to generate a sample DVD image.</div>
          </div>
          <div className="grid-2">
            <label className="check mb"><input type="checkbox" checked={s.disc.autoRip} onChange={(e) => setS({ ...s, disc: { ...s.disc, autoRip: e.target.checked } })} /> Start ripping automatically once identified</label>
            <label className="check mb"><input type="checkbox" checked={s.disc.autoTranscode} onChange={(e) => setS({ ...s, disc: { ...s.disc, autoTranscode: e.target.checked } })} /> Transcode with the default profile</label>
            <label className="check mb"><input type="checkbox" checked={s.disc.autoDeliver} onChange={(e) => setS({ ...s, disc: { ...s.disc, autoDeliver: e.target.checked } })} /> Hand finished files to Radarr / Sonarr</label>
            <label className="check mb"><input type="checkbox" checked={s.disc.autoEject} onChange={(e) => setS({ ...s, disc: { ...s.disc, autoEject: e.target.checked } })} /> Eject when done</label>
            <label className="check"><input type="checkbox" checked={s.disc.keepRaw} onChange={(e) => setS({ ...s, disc: { ...s.disc, keepRaw: e.target.checked } })} /> Keep the raw MakeMKV rip after transcoding</label>
          </div>
        </div>
      </div>
      <div className="card mb">
        <div className="card-h">
          <label className="check">
            <input type="checkbox" checked={s.disc.cd.enabled} onChange={(e) => setS({ ...s, disc: { ...s.disc, cd: { ...s.disc.cd, enabled: e.target.checked } } })} /> Audio CDs (CD / MQA-CD → FLAC)
          </label>
          <span className="spacer" />
          <span className="small dim">needs fre:ac</span>
        </div>
        <div className="card-b">
          <p className="small dim" style={{ marginTop: 0 }}>
            Audio CDs are read with fre:ac's paranoia reader to bit-perfect FLAC, identified on MusicBrainz, tagged and given cover art, scanned for MQA (MQA-CD survives because nothing is resampled), and handed to Lidarr. Choose a different music profile on the disc to also make MP3 / Opus copies.
          </p>
          <div className="grid-2">
            <div className="field">
              <label>FLAC compression</label>
              <input type="number" min={0} max={8} value={s.disc.cd.compressionLevel} onChange={(e) => setS({ ...s, disc: { ...s.disc, cd: { ...s.disc.cd, compressionLevel: Number(e.target.value) } } })} />
              <div className="help">0 (fastest) – 8 (smallest); every level is lossless.</div>
            </div>
            <div className="field">
              <label>TOC reader (Linux)</label>
              <input type="text" value={s.disc.cd.ripperPath} onChange={(e) => setS({ ...s, disc: { ...s.disc, cd: { ...s.disc.cd, ripperPath: e.target.value } } })} placeholder="cdparanoia or cd-paranoia" />
              <div className="help">Reads the track list for the MusicBrainz disc id. macOS uses the mounted CD's table of contents instead.</div>
            </div>
          </div>
          <div className="grid-2">
            <label className="check mb"><input type="checkbox" checked={s.disc.cd.musicbrainz} onChange={(e) => setS({ ...s, disc: { ...s.disc, cd: { ...s.disc.cd, musicbrainz: e.target.checked } } })} /> Look discs up on MusicBrainz</label>
            <label className="check mb"><input type="checkbox" checked={s.disc.cd.detectMqa} onChange={(e) => setS({ ...s, disc: { ...s.disc, cd: { ...s.disc.cd, detectMqa: e.target.checked } } })} /> Detect MQA-CD and tag it</label>
            <label className="check"><input type="checkbox" checked={s.disc.cd.deliverToLidarr} onChange={(e) => setS({ ...s, disc: { ...s.disc, cd: { ...s.disc.cd, deliverToLidarr: e.target.checked } } })} /> Import finished albums into Lidarr</label>
          </div>
        </div>
      </div>

      <div className="legend">Path mappings</div>
      <div className="card">
        <div className="card-h">
          Path mappings
          <span className="spacer" />
          <button className="btn sm" onClick={() => setS({ ...s, pathMappings: [...s.pathMappings, { remote: '', local: '' }] })}>
            <Icon.Plus /> Add mapping
          </button>
        </div>
        <div className="card-b">
          <p className="small dim" style={{ marginTop: 0 }}>
            If Radarr/Sonarr run in Docker or on another machine, the paths they report will not exist here. Map the *arr prefix to the path rexarr can see, e.g. <code>/data/media</code> → <code>/mnt/media</code> (or <code>/Volumes/Media</code> for an SMB share mounted on a Mac). Longest prefix wins. Pick an app when Radarr and Sonarr use different paths for the same folder.
          </p>
          {s.pathMappings.length === 0 && <div className="muted small">No mappings – paths are used exactly as reported by the *arr apps.</div>}
          {s.pathMappings.map((m, i) => (
            <div key={i} className="inline mb" style={{ flexWrap: 'nowrap' }}>
              <select style={{ width: 120, flexShrink: 0 }} value={m.app ?? 'all'} onChange={(e) => setS({ ...s, pathMappings: s.pathMappings.map((x, j) => (j === i ? { ...x, app: e.target.value as 'all' | 'radarr' | 'sonarr' | 'lidarr' | 'slskd' } : x)) })} title="Which app reports this path">
                <option value="all">All apps</option>
                <option value="radarr">Radarr</option>
                <option value="sonarr">Sonarr</option>
                <option value="lidarr">Lidarr</option>
                <option value="slskd">Soulseek</option>
              </select>
              <input type="text" placeholder="*arr path prefix" value={m.remote} onChange={(e) => setS({ ...s, pathMappings: s.pathMappings.map((x, j) => (j === i ? { ...x, remote: e.target.value } : x)) })} />
              <span className="dim">→</span>
              <input type="text" placeholder="Local path prefix" value={m.local} onChange={(e) => setS({ ...s, pathMappings: s.pathMappings.map((x, j) => (j === i ? { ...x, local: e.target.value } : x)) })} />
              <button className="iconButton danger" onClick={() => setS({ ...s, pathMappings: s.pathMappings.filter((_, j) => j !== i) })} title="Remove">
                <Icon.X />
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="legend">Local media</div>
      <LocalMediaCard value={s.localMedia} onChange={(localMedia) => setS({ ...s, localMedia })} dirty={JSON.stringify(s.localMedia) !== JSON.stringify(settings?.localMedia)} />
    </Page>
  );
}
