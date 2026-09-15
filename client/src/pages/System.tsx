import { useEffect, useState } from 'react';
import { REPO_URL } from '@shared/version';
import type { StoragePath } from '@shared/types';
import type { SystemInfo } from '@shared/types';
import { VIDEO_ENCODER_INFO, AUDIO_ENCODER_INFO } from '@shared/presets';
import { api, fmtBytes, fmtDuration } from '../api';
import { useApp } from '../App';
import { Link } from 'react-router-dom';
import { Page, ToolbarButton } from '../components/Layout';
import { Icon } from '../components/Icons';

function PathRow({ p }: { p: StoragePath }) {
  const pct = p.disk && p.disk.totalBytes ? (p.disk.usedBytes / p.disk.totalBytes) * 100 : 0;
  const low = p.disk ? p.disk.freeBytes < 20 * 1024 ** 3 || pct > 92 : false;
  const title = p.disk ? `${fmtBytes(p.disk.usedBytes)} used of ${fmtBytes(p.disk.totalBytes)} · ${fmtBytes(p.disk.freeBytes)} free on this disk` : 'Folder does not exist';
  return (
    <div className="storagePath" title={p.description}>
      <span className="storageIcon">
        <Icon.Server />
      </span>
      <div className="storageInfo">
        <div className="storageLabel">
          {p.label}
          {p.overridden && <span className="badge sm blue" title={`Set by ${p.env}`}>env</span>}
          {!p.exists && <span className="badge sm red">missing</span>}
          {p.exists && !p.writable && <span className="badge sm red">read-only</span>}
        </div>
        <div className="storageValue" title={p.path}>
          <bdi>{p.path}</bdi>
        </div>
        <div className={`storageBar${low ? ' low' : ''}`} title={title}>
          <div style={{ width: `${pct.toFixed(1)}%` }} />
        </div>
        <div className="storageMeta">
          <span>{fmtBytes(p.sizeBytes) === '—' ? '0 B' : fmtBytes(p.sizeBytes)}{p.sizeTruncated ? '+' : ''} in {p.fileCount.toLocaleString()} file{p.fileCount === 1 ? '' : 's'}</span>
          {p.disk && <span>{fmtBytes(p.disk.freeBytes)} free of {fmtBytes(p.disk.totalBytes)}</span>}
        </div>
      </div>
    </div>
  );
}

export function SystemPage() {
  const { health, healthLoaded, reloadHealth } = useApp();
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [paths, setPaths] = useState<StoragePath[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = (refresh = false) => {
    setBusy(true);
    Promise.all([api.system(refresh).then(setInfo), api.paths(refresh).then(setPaths), reloadHealth()])
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };
  useEffect(() => load(), []);
  return (
    <Page
      title="System"
      toolbarLeft={<ToolbarButton icon={<Icon.Refresh />} label="Re-detect" onClick={() => load(true)} busy={busy} />}
      narrow
    >
      {error && <div className="error">{error}</div>}
      <div className="card mb">
        <div className="card-h">
          <Icon.Alert /> Health
          <span className="spacer" />
          {!healthLoaded ? (
            <span className="small dim">
              <span className="spinner" /> Checking…
            </span>
          ) : (
            health.length === 0 && <span className="badge green">All checks passed</span>
          )}
        </div>
        {!healthLoaded ? (
          <div className="card-b dim">Running health checks (network shares can take a few seconds)…</div>
        ) : health.length === 0 ? (
          <div className="card-b dim">No issues found. rexarr can reach ffmpeg, your *arr apps and the files they report.</div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 40 }} />
                <th>Source</th>
                <th>Message</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {health.map((h, i) => (
                <tr key={i}>
                  <td><span className={`badge ${h.type === 'error' ? 'red' : 'warning'}`}>{h.type}</span></td>
                  <td style={{ whiteSpace: 'nowrap' }}>{h.source}</td>
                  <td>{h.message}</td>
                  <td className="num">{h.link && <Link className="btn sm" to={h.link}>Fix</Link>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {paths && (
        <div className="card mb">
          <div className="card-h">
            <Icon.HardDrive /> Paths
            <span className="spacer" />
            <span className="small dim">bars show how full the disk holding each folder is</span>
          </div>
          <div className="card-b storagePaths">
            {paths.map((p) => (
              <PathRow key={p.id} p={p} />
            ))}
          </div>
        </div>
      )}
      {info && (
        <>
          <div className="stats mb">
            <div className="stat"><div className="v">{info.jobs.active}</div><div className="l">Encoding</div></div>
            <div className="stat"><div className="v">{info.jobs.queued}</div><div className="l">Queued</div></div>
            <div className="stat"><div className="v">{info.jobs.waiting}</div><div className="l">Waiting for import</div></div>
            <div className="stat"><div className="v">{info.jobs.done}</div><div className="l">Done</div></div>
            <div className="stat"><div className="v">{info.jobs.failed}</div><div className="l">Failed</div></div>
          </div>
          <div className="grid-2">
            <div className="card">
              <div className="card-h">FFmpeg</div>
              <div className="card-b">
                {!info.ffmpeg.available && <div className="error">FFmpeg not found at “{info.ffmpeg.path}”: {info.ffmpeg.error}</div>}
                <div className="field row"><label>Version</label><span>{info.ffmpeg.version || '—'}</span></div>
                <div className="field row"><label>Path</label><code>{info.ffmpeg.path}</code></div>
                <div className="field row"><label>Hardware accel</label><span>{info.ffmpeg.hwaccels.join(', ') || 'none detected'}</span></div>
                <div className="field">
                  <label>Video encoders</label>
                  <div className="chips">
                    {Object.keys(VIDEO_ENCODER_INFO).filter((e) => e !== 'copy').map((e) => (
                      <span key={e} className={`chip${info.ffmpeg.videoEncoders.includes(e as never) ? ' on' : ''}`} title={VIDEO_ENCODER_INFO[e].label}>
                        {e}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="field">
                  <label>Audio encoders</label>
                  <div className="chips">
                    {Object.keys(AUDIO_ENCODER_INFO).filter((e) => e !== 'copy').map((e) => (
                      <span key={e} className={`chip${info.ffmpeg.audioEncoders.includes(e as never) ? ' on' : ''}`}>
                        {e}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
            <div className="card">
              <div className="card-h">Connections</div>
              <div className="card-b">
                {info.arr.map((a) => (
                  <div key={a.name} className="field row">
                    <label style={{ textTransform: 'capitalize' }}>{a.name}</label>
                    {!a.configured ? <span className="badge muted">Not configured</span> : a.ok ? <span className="badge green">Connected · v{a.version}</span> : <span className="badge red" title={a.error}>Error</span>}
                    {a.configured && !a.ok && <span className="small dim">{a.error}</span>}
                  </div>
                ))}
              </div>
              <div className="card-h">About</div>
              <div className="card-b">
                <div className="field row"><label>rexarr</label><span>v{info.version}</span></div>
                <div className="field row">
                  <label>GitHub</label>
                  <span className="inline" style={{ gap: 12 }}>
                    <a href={REPO_URL} target="_blank" rel="noreferrer">
                      <Icon.GitHub /> Source
                    </a>
                    <a href={`${REPO_URL}/releases`} target="_blank" rel="noreferrer">
                      Releases
                    </a>
                    <a href={`${REPO_URL}/issues/new?${new URLSearchParams({ title: '', body: `\n\n---\nrexarr ${info.version} · ${info.platform} · Node ${info.node}` })}`} target="_blank" rel="noreferrer">
                      Report an issue
                    </a>
                  </span>
                </div>
                <div className="field row"><label>Node</label><span>{info.node}</span></div>
                <div className="field row"><label>Platform</label><span>{info.platform}</span></div>
                <div className="field row"><label>Uptime</label><span>{fmtDuration(info.uptimeSeconds)}</span></div>
                <div className="field row"><label>Config directory</label><code style={{ wordBreak: 'break-all' }}>{info.dataDir}</code></div>
              </div>
            </div>
          </div>
        </>
      )}
    </Page>
  );
}
