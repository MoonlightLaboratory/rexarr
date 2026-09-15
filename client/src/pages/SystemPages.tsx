import { withBase } from '../base';
import { useEffect, useRef, useState } from 'react';
import type { AppEvent, BackupInfo, LogFileInfo, ScheduledTask } from '@shared/types';
import { api, fmtAge, fmtBytes, fmtDuration } from '../api';
import { useApp } from '../App';
import { Page, ToolbarButton, ToolbarSeparator, ToolbarText } from '../components/Layout';
import { Icon } from '../components/Icons';
import { LoadingIndicator } from '../components/Labels';

const fmtTime = (iso?: string) => (iso ? new Date(iso).toLocaleString() : '—');
const fmtInterval = (s: number) => (s <= 0 ? 'on demand' : s % 86400 === 0 ? `${s / 86400} day${s / 86400 > 1 ? 's' : ''}` : s % 3600 === 0 ? `${s / 3600} hour${s / 3600 > 1 ? 's' : ''}` : s % 60 === 0 ? `${s / 60} min` : `${s} s`);

// ---------------------------------------------------------------------------------------------
export function TasksPage() {
  const { toast } = useApp();
  const [list, setList] = useState<ScheduledTask[] | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const load = () => api.tasks().then(setList).catch((e) => toast('error', e.message));
  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const run = async (id: string) => {
    setRunning(id);
    try {
      await api.runTask(id);
      await load();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setRunning(null);
    }
  };
  return (
    <Page title="Tasks" toolbarLeft={<ToolbarButton icon={<Icon.Refresh />} label="Refresh" onClick={load} />} narrow>
      <div className="legend">Scheduled</div>
      <div className="card tbl-wrap">
        {!list ? (
          <LoadingIndicator />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Name</th>
                <th>Interval</th>
                <th>Last run</th>
                <th>Duration</th>
                <th>Next run</th>
                <th>Result</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((t) => (
                <tr key={t.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{t.name}</td>
                  <td className="dim" style={{ whiteSpace: 'nowrap' }}>{fmtInterval(t.intervalSeconds)}</td>
                  <td className="dim" title={fmtTime(t.lastRun)}>{t.lastRun ? fmtAge(t.lastRun) : 'never'}</td>
                  <td className="dim">{t.lastDurationMs !== undefined ? `${(t.lastDurationMs / 1000).toFixed(t.lastDurationMs < 1000 ? 2 : 1)} s` : '—'}</td>
                  <td className="dim" title={fmtTime(t.nextRun)}>{t.intervalSeconds > 0 && t.nextRun ? (new Date(t.nextRun).getTime() < Date.now() ? 'due' : fmtDuration((new Date(t.nextRun).getTime() - Date.now()) / 1000)) : '—'}</td>
                  <td className="small" title={t.lastError ?? t.lastResult ?? ''}>
                    <div className="truncate" style={{ maxWidth: 'min(260px, 19vw)' }}>
                      {t.lastError ? <span style={{ color: 'var(--dangerColor)' }}>{t.lastError}</span> : <span className="dim">{t.lastResult ?? ''}</span>}
                    </div>
                  </td>
                  <td className="num">
                    <button className="iconButton" title="Run now" disabled={t.running || running === t.id} onClick={() => run(t.id)}>
                      {t.running || running === t.id ? <span className="spinner" /> : <Icon.Play />}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Page>
  );
}

// ---------------------------------------------------------------------------------------------
export function BackupPage() {
  const { toast } = useApp();
  const [list, setList] = useState<BackupInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const load = () => api.backups().then(setList).catch((e) => toast('error', e.message));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast('info', ok);
      await load();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const restoreFile = async (f: File) => {
    if (!confirm(`Restore configuration from ${f.name}? Current settings, profiles and history will be overwritten and rexarr must be restarted.`)) return;
    await act(async () => {
      const r = await api.restoreBackupUpload(f);
      toast('warn', `Restored ${r.restored.join(', ')} – restart rexarr to apply`);
    });
  };
  return (
    <Page
      title="Backup"
      narrow
      toolbarLeft={
        <>
          <ToolbarButton icon={<Icon.Save />} label="Backup now" wide busy={busy} onClick={() => act(() => api.createBackup(), 'Backup created')} />
          <ToolbarButton icon={<Icon.Folder />} label="Restore backup" wide disabled={busy} onClick={() => fileRef.current?.click()} />
          <ToolbarSeparator />
          <ToolbarButton icon={<Icon.Refresh />} label="Refresh" onClick={load} />
        </>
      }
    >
      <input ref={fileRef} type="file" accept=".gz,.json,application/gzip" hidden onChange={(e) => e.target.files?.[0] && restoreFile(e.target.files[0])} />
      <p className="dim small" style={{ marginTop: 0 }}>
        A backup bundles settings, profiles, encode history, disc history and events into one <code>.json.gz</code>. A scheduled backup runs daily; the newest 20 of each type are kept under <code>data/backups</code>. Restoring writes the files back and takes effect after a restart.
      </p>
      <div className="card tbl-wrap">
        {!list ? (
          <LoadingIndicator />
        ) : list.length === 0 ? (
          <div className="empty">
            <h3>No backups yet</h3>
            <p>Use “Backup now” to create one.</p>
          </div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th className="num">Size</th>
                <th>Time</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((b) => (
                <tr key={b.name}>
                  <td>
                    <a href={withBase(`/api/system/backups/${encodeURIComponent(b.name)}`)} download>
                      {b.name}
                    </a>
                  </td>
                  <td>
                    <span className={`badge ${b.type === 'manual' ? 'blue' : ''}`}>{b.type}</span>
                  </td>
                  <td className="num dim">{fmtBytes(b.sizeBytes)}</td>
                  <td className="dim" title={fmtTime(b.createdAt)}>{fmtAge(b.createdAt)}</td>
                  <td className="num" style={{ whiteSpace: 'nowrap' }}>
                    <a className="iconButton" href={withBase(`/api/system/backups/${encodeURIComponent(b.name)}`)} download title="Download">
                      <Icon.Download />
                    </a>
                    <button className="iconButton" title="Restore" disabled={busy} onClick={() => confirm(`Restore ${b.name}? Current configuration will be overwritten and rexarr must be restarted.`) && act(() => api.restoreBackup(b.name).then((r) => toast('warn', `Restored ${r.restored.join(', ')} – restart rexarr to apply`)))}>
                      <Icon.Refresh />
                    </button>
                    <button className="iconButton danger" title="Delete" disabled={busy} onClick={() => confirm(`Delete ${b.name}?`) && act(() => api.deleteBackup(b.name), 'Backup deleted')}>
                      <Icon.Trash />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Page>
  );
}

// ---------------------------------------------------------------------------------------------
export function EventsPage() {
  const { toast } = useApp();
  const [list, setList] = useState<AppEvent[] | null>(null);
  const [level, setLevel] = useState<'' | 'info' | 'warning' | 'error'>('');
  const load = () => api.events(level || undefined).then(setList).catch((e) => toast('error', e.message));
  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level]);
  const cls = (l: AppEvent['level']) => (l === 'error' ? 'red' : l === 'warning' ? 'warning' : 'blue');
  return (
    <Page
      title="Events"
      toolbarLeft={
        <>
          <ToolbarButton icon={<Icon.Refresh />} label="Refresh" onClick={load} />
          <ToolbarButton icon={<Icon.Trash />} label="Clear" disabled={!list?.length} onClick={() => confirm('Clear all events?') && api.clearEvents().then(load)} />
        </>
      }
      toolbarRight={
        <ToolbarText>
          <div className="seg sm">
            {(['', 'info', 'warning', 'error'] as const).map((l) => (
              <button key={l || 'all'} className={level === l ? 'active' : ''} onClick={() => setLevel(l)}>
                {l ? l[0].toUpperCase() + l.slice(1) : 'All'}
              </button>
            ))}
          </div>
        </ToolbarText>
      }
    >
      <div className="card tbl-wrap">
        {!list ? (
          <LoadingIndicator />
        ) : list.length === 0 ? (
          <div className="empty">No events.</div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 90 }}>Level</th>
                <th style={{ width: 170 }}>Time</th>
                <th style={{ width: 110 }}>Component</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {list.map((e) => (
                <tr key={e.id}>
                  <td>
                    <span className={`badge ${cls(e.level)}`}>{e.level}</span>
                  </td>
                  <td className="dim" title={fmtTime(e.time)}>{fmtTime(e.time)}</td>
                  <td className="dim">{e.source}</td>
                  <td>
                    {e.message}
                    {e.details && (
                      <div className="small muted truncate" title={e.details}>
                        {e.details}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Page>
  );
}

// ---------------------------------------------------------------------------------------------
export function LogsPage() {
  const { toast } = useApp();
  const [files, setFiles] = useState<LogFileInfo[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [text, setText] = useState<string>('');
  const [filter, setFilter] = useState('');
  const boxRef = useRef<HTMLPreElement>(null);
  const loadList = () => api.logFiles().then((l) => { setFiles(l); if (!current && l.length) setCurrent(l[0].name); }).catch((e) => toast('error', e.message));
  const loadFile = (name: string) => api.logFile(name).then((t) => { setText(t); requestAnimationFrame(() => boxRef.current && (boxRef.current.scrollTop = boxRef.current.scrollHeight)); }).catch((e) => toast('error', e.message));
  useEffect(() => {
    loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (current) loadFile(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);
  const lines = text.split('\n').filter((l) => !filter || l.toLowerCase().includes(filter.toLowerCase()));
  return (
    <Page
      title="Log Files"
      toolbarLeft={
        <>
          <ToolbarButton icon={<Icon.Refresh />} label="Refresh" onClick={() => { loadList(); if (current) loadFile(current); }} />
          <ToolbarButton icon={<Icon.Trash />} label="Clear" disabled={!files?.length} onClick={() => confirm('Delete all log files?') && api.clearLogs().then(() => { setText(''); setCurrent(null); loadList(); })} />
        </>
      }
      toolbarRight={
        <ToolbarText>
          <input type="search" placeholder="Filter lines…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 200, height: 30, padding: '4px 10px' }} />
        </ToolbarText>
      }
    >
      <div className="grid-2" style={{ gridTemplateColumns: '260px minmax(0, 1fr)' }}>
        <div className="card">
          <div className="card-h">Files</div>
          {!files ? (
            <LoadingIndicator size={30} />
          ) : files.length === 0 ? (
            <div className="empty small">No log files yet.</div>
          ) : (
            files.map((f) => (
              <div key={f.name} className="list-row" style={{ cursor: 'pointer', padding: '8px 15px', background: current === f.name ? 'var(--tableRowHoverBackgroundColor)' : undefined }} onClick={() => setCurrent(f.name)}>
                <Icon.Terminal />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className={current === f.name ? '' : 'dim'}>{f.name}</div>
                  <div className="small muted">
                    {fmtBytes(f.sizeBytes)} · {fmtAge(f.modifiedAt)}
                  </div>
                </div>
                <a className="iconButton" href={withBase(`/api/system/logs/${encodeURIComponent(f.name)}`)} download onClick={(e) => e.stopPropagation()} title="Download">
                  <Icon.Download />
                </a>
              </div>
            ))
          )}
        </div>
        <div className="card">
          <div className="card-h">
            {current ?? 'Log'}
            <span className="spacer" />
            <span className="small dim">{lines.length} lines</span>
          </div>
          <pre ref={boxRef} className="log" style={{ maxHeight: 'calc(100vh - 260px)', border: 'none', borderRadius: 0 }}>
            {lines.map((l, i) => (
              <div key={i} className={/\|Error|\|Fatal/.test(l) ? 'err-line' : /\|Warn/.test(l) ? 'warn-line' : ''}>
                {l}
              </div>
            ))}
            {!lines.length && <span className="muted">Empty.</span>}
          </pre>
        </div>
      </div>
    </Page>
  );
}
