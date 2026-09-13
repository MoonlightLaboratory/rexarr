import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Job, JobStatus } from '@shared/types';
import { api, fmtAge, fmtBytes, fmtDuration } from '../api';
import { useApp } from '../App';
import { Page, ToolbarButton, ToolbarSeparator, ToolbarText } from '../components/Layout';
import { Icon } from '../components/Icons';
import { Modal } from '../components/Modal';

const STATUS_LABEL: Record<JobStatus, string> = { waiting: 'Waiting for import', queued: 'Queued', probing: 'Probing', encoding: 'Encoding', finalizing: 'Finalizing', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' };
const STATUS_CLASS: Record<JobStatus, string> = { waiting: 'blue', queued: '', probing: 'teal', encoding: 'remux', finalizing: 'teal', done: 'green', failed: 'red', cancelled: 'muted' };
const ACTIVE: JobStatus[] = ['probing', 'encoding', 'finalizing'];

function rank(j: Job) {
  return ['encoding', 'finalizing', 'probing', 'queued', 'waiting'].indexOf(j.status);
}

function detailLink(j: Job) {
  if (j.source.arr === 'radarr' && j.source.arrId) return `/movies/${j.source.arrId}`;
  if (j.source.arr === 'sonarr' && j.source.arrId) return `/series/${j.source.arrId}`;
  return null;
}

function QueueRow({ job, onLog }: { job: Job; onLog: (j: Job) => void }) {
  const { toast } = useApp();
  const active = ACTIVE.includes(job.status);
  const p = job.progress;
  const link = detailLink(job);
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) toast('info', ok);
    } catch (e) {
      toast('error', (e as Error).message);
    }
  };
  return (
    <tr>
      <td style={{ width: 40 }}>
        <div className="thumb" style={{ width: 30, height: 45, backgroundImage: job.poster ? `url(${job.poster})` : undefined }} />
      </td>
      <td style={{ maxWidth: 420 }}>
        <div className="truncate">{link ? <Link to={link}>{job.title}</Link> : job.title}</div>
        {job.subtitle && (
          <div className="small dim truncate" title={job.subtitle}>
            {job.subtitle}
          </div>
        )}
        {job.status === 'failed' && (
          <div className="small truncate" style={{ color: 'var(--dangerColor)' }} title={job.error}>
            {job.error}
          </div>
        )}
      </td>
      <td>
        <span className="badge">{job.profileName}</span>
      </td>
      <td style={{ minWidth: 220 }}>
        {active ? (
          <>
            <div className="progress md">
              <div style={{ width: `${p.percent.toFixed(1)}%` }} />
              <span className="text">{p.percent.toFixed(1)}%</span>
            </div>
            <div className="small dim inline" style={{ gap: 10, marginTop: 3 }}>
              {p.fps ? <span>{p.fps.toFixed(0)} fps</span> : null}
              {p.speed ? <span>{p.speed}</span> : null}
              {p.etaSeconds !== null ? <span>ETA {fmtDuration(p.etaSeconds)}</span> : null}
            </div>
          </>
        ) : (
          <span className={`badge ${STATUS_CLASS[job.status]}`}>{STATUS_LABEL[job.status]}</span>
        )}
        {job.status === 'waiting' && <div className="small dim">polling {job.source.arr} · {fmtAge(job.createdAt)}</div>}
      </td>
      <td className="num dim" style={{ whiteSpace: 'nowrap' }}>
        {job.status === 'done' && job.inputSizeBytes && job.outputSizeBytes ? (
          <>
            {fmtBytes(job.inputSizeBytes)} → {fmtBytes(job.outputSizeBytes)}
            <div className="small">{((job.outputSizeBytes / job.inputSizeBytes) * 100).toFixed(0)}% of source</div>
          </>
        ) : active && p.sizeBytes ? (
          fmtBytes(p.sizeBytes)
        ) : job.inputSizeBytes ? (
          fmtBytes(job.inputSizeBytes)
        ) : (
          '—'
        )}
      </td>
      <td className="dim" style={{ whiteSpace: 'nowrap' }}>
        {job.status === 'done' && job.startedAt && job.finishedAt ? fmtDuration((new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime()) / 1000) : job.finishedAt ? fmtAge(job.finishedAt) : fmtAge(job.createdAt)}
      </td>
      <td className="num" style={{ whiteSpace: 'nowrap' }}>
        <button className="iconButton" title="Log" onClick={() => onLog(job)}>
          <Icon.Terminal />
        </button>
        {job.status === 'queued' && (
          <button className="iconButton" title="Move to top" onClick={() => act(() => api.reorderJob(job.id, 'top'))}>
            <Icon.ArrowUp />
          </button>
        )}
        {(active || job.status === 'queued' || job.status === 'waiting') && (
          <button className="iconButton danger" title="Cancel" onClick={() => act(() => api.cancelJob(job.id), 'Cancelled')}>
            <Icon.X />
          </button>
        )}
        {(job.status === 'failed' || job.status === 'cancelled') && (
          <button className="iconButton" title="Retry" onClick={() => act(() => api.retryJob(job.id))}>
            <Icon.Refresh />
          </button>
        )}
        {['done', 'failed', 'cancelled'].includes(job.status) && (
          <button className="iconButton" title="Remove" onClick={() => act(() => api.removeJob(job.id))}>
            <Icon.Trash />
          </button>
        )}
      </td>
    </tr>
  );
}

function LogModal({ job, onClose }: { job: Job; onClose: () => void }) {
  const { jobs, toast } = useApp();
  const live = jobs.find((j) => j.id === job.id) ?? job;
  const [log, setLog] = useState<string[]>(live.log);
  useEffect(() => setLog(live.log), [live.log]);
  useEffect(() => {
    api.jobLog(job.id).then((r) => setLog(r.log)).catch(() => {});
  }, [job.id]);
  return (
    <Modal title={`${job.title}${job.subtitle ? ` · ${job.subtitle}` : ''}`} onClose={onClose} wide>
      {live.command && (
        <div className="field stack">
          <label className="inline">
            ffmpeg command
            <button className="btn sm" onClick={() => navigator.clipboard.writeText(live.command!).then(() => toast('info', 'Command copied'))}>
              <Icon.Copy /> Copy
            </button>
          </label>
          <pre className="log" style={{ maxHeight: 140 }}>{live.command}</pre>
        </div>
      )}
      <div className="log">
        {log.map((l, i) => (
          <div key={i} className={/error|failed|invalid/i.test(l) ? 'err-line' : /warning/i.test(l) ? 'warn-line' : ''}>
            {l}
          </div>
        ))}
        {!log.length && <span className="muted">No log yet.</span>}
      </div>
    </Modal>
  );
}

export function ActivityPage() {
  const { jobs, toast } = useApp();
  const [tab, setTab] = useState<'queue' | 'history'>('queue');
  const [logJob, setLogJob] = useState<Job | null>(null);

  const queue = useMemo(() => [...jobs.filter((j) => !['done', 'failed', 'cancelled'].includes(j.status))].sort((a, b) => rank(a) - rank(b)), [jobs]);
  const history = useMemo(() => jobs.filter((j) => ['done', 'failed', 'cancelled'].includes(j.status)), [jobs]);
  const list = tab === 'queue' ? queue : history;
  const encoding = queue.filter((j) => ACTIVE.includes(j.status)).length;
  const saved = history.filter((j) => j.status === 'done').reduce((a, j) => a + ((j.inputSizeBytes ?? 0) - (j.outputSizeBytes ?? 0)), 0);

  return (
    <Page
      title="Activity"
      toolbarLeft={
        <>
          <ToolbarButton icon={<Icon.Activity />} label="Queue" selected={tab === 'queue'} onClick={() => setTab('queue')} indicator={encoding > 0} />
          <ToolbarButton icon={<Icon.Clock />} label="History" selected={tab === 'history'} onClick={() => setTab('history')} />
          <ToolbarSeparator />
          <ToolbarButton icon={<Icon.Trash />} label="Clear finished" wide disabled={!history.length} onClick={() => api.clearJobs().then(() => toast('info', 'Cleared finished jobs')).catch((e) => toast('error', e.message))} />
        </>
      }
      toolbarRight={
        <ToolbarText>
          {encoding ? `${encoding} encoding · ` : ''}
          {queue.length} queued · {history.length} finished{saved > 0 ? ` · ${fmtBytes(saved)} saved` : ''}
        </ToolbarText>
      }
    >
      <div className="card tbl-wrap">
        {list.length === 0 ? (
          <div className="empty">
            <h3>{tab === 'queue' ? 'The queue is empty' : 'No history yet'}</h3>
            <p>
              {tab === 'queue' ? (
                <>
                  Grab a remux from <Link to="/search">Search</Link> or pick a file in <Link to="/movies">Movies</Link> / <Link to="/series">Series</Link> to start encoding.
                </>
              ) : (
                'Finished, failed and cancelled encodes show up here.'
              )}
            </p>
          </div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th />
                <th>Title</th>
                <th>Profile</th>
                <th>{tab === 'queue' ? 'Progress' : 'Status'}</th>
                <th className="num">Size</th>
                <th>{tab === 'queue' ? 'Added' : 'Took'}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((j) => (
                <QueueRow key={j.id} job={j} onLog={setLogJob} />
              ))}
            </tbody>
          </table>
        )}
      </div>
      {logJob && <LogModal job={logJob} onClose={() => setLogJob(null)} />}
    </Page>
  );
}
