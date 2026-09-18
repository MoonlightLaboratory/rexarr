import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Job, JobStatus } from '@shared/types';
import { api, fmtAge, fmtBytes, fmtDuration } from '../api';
import { useApp } from '../App';
import { Page, ToolbarButton, ToolbarSeparator, ToolbarText } from '../components/Layout';
import { Icon } from '../components/Icons';
import { Modal } from '../components/Modal';
import { EncodePreviewModal, LiveThumb } from '../components/EncodePreview';

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

function QueueRow({ job, onLog, onPreview }: { job: Job; onLog: (j: Job) => void; onPreview: (j: Job) => void }) {
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
        {job.status === 'encoding' && job.preview ? <LiveThumb job={job} onClick={() => onPreview(job)} /> : <div className="thumb" style={{ width: 30, height: 45, backgroundImage: job.poster ? `url(${job.poster})` : undefined }} />}
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
      <td style={{ whiteSpace: 'nowrap' }}>
        <span className="badge">{job.profileName}</span>
        {job.trigger === 'auto' && <span className="badge purple sm" title="Queued by auto transcode">Auto</span>}
        {job.trigger === 'disc' && <span className="badge teal sm" title="From a disc rip">Disc</span>}
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
        {job.source.disc && <span className="badge purple" style={{ marginLeft: 0 }}>{job.source.disc.format === 'uhd' ? 'UHD Blu-ray' : job.source.disc.format === 'dvd' ? 'DVD' : 'Blu-ray'} disc</span>}
        {job.status === 'waiting' && <div className="small dim">{job.message ?? job.source.disc?.status ?? `polling ${job.source.arr}`} · {fmtAge(job.createdAt)}</div>}
        {job.status === 'done' && job.source.disc?.ripIds?.length ? (
          <div className="small dim">
            {job.message} · <Link to="/discs">Discs</Link>
          </div>
        ) : null}
      </td>
      <td className="num dim" style={{ whiteSpace: 'nowrap' }}>
        {job.status === 'done' && job.inputSizeBytes && job.outputSizeBytes ? (
          <>
            {fmtBytes(job.inputSizeBytes)} → {fmtBytes(job.outputSizeBytes)}
            <div className="small" title={job.estimatedBytes ? `Estimated ${fmtBytes(job.estimatedBytes)} before the encode` : undefined}>
              {((job.outputSizeBytes / job.inputSizeBytes) * 100).toFixed(0)}% of source
              {job.estimatedBytes ? ` · est. ${fmtBytes(job.estimatedBytes)}` : ''}
            </div>
          </>
        ) : active && p.sizeBytes ? (
          <>
            {fmtBytes(p.sizeBytes)}
            {job.estimatedBytes ? <div className="small">of ≈ {fmtBytes(job.estimatedBytes)}</div> : null}
          </>
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
        {(active || job.status === 'done') && (
          <button className="iconButton" title={active ? 'Live preview' : 'Compare source and encode'} onClick={() => onPreview(job)}>
            <Icon.Eye />
          </button>
        )}
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
  const { jobs, toast, queuePaused, settings, reloadSettings } = useApp();
  const limit = settings?.concurrency ?? 1;
  const setLimit = (n: number) =>
    api
      .setQueueLimit(n)
      .then(() => reloadSettings())
      .then(() => toast('info', `${n} encode${n > 1 ? 's' : ''} at a time`))
      .catch((e) => toast('error', e.message));
  const [tab, setTab] = useState<'queue' | 'history'>('queue');
  const [logJob, setLogJob] = useState<Job | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);

  const queue = useMemo(() => [...jobs.filter((j) => !['done', 'failed', 'cancelled'].includes(j.status))].sort((a, b) => rank(a) - rank(b)), [jobs]);
  const history = useMemo(() => jobs.filter((j) => ['done', 'failed', 'cancelled'].includes(j.status)), [jobs]);
  const list = tab === 'queue' ? queue : history;
  const encoding = queue.filter((j) => ACTIVE.includes(j.status)).length;
  const failedCount = history.filter((j) => j.status === 'failed').length;
  const saved = history.filter((j) => j.status === 'done').reduce((a, j) => a + ((j.inputSizeBytes ?? 0) - (j.outputSizeBytes ?? 0)), 0);

  return (
    <Page
      title="Activity"
      toolbarLeft={
        <>
          <ToolbarButton icon={<Icon.Activity />} label="Queue" selected={tab === 'queue'} onClick={() => setTab('queue')} indicator={encoding > 0} />
          <ToolbarButton icon={<Icon.Clock />} label="History" selected={tab === 'history'} onClick={() => setTab('history')} />
          <ToolbarSeparator />
          <ToolbarButton
            icon={queuePaused ? <Icon.Play /> : <Icon.StopSquare />}
            label={queuePaused ? 'Resume' : 'Pause'}
            selected={queuePaused}
            title={queuePaused ? 'Start queued encodes again' : 'Let running encodes finish, start nothing new'}
            onClick={() => api.pauseQueue(!queuePaused).then((r) => toast('info', r.paused ? 'Queue paused – running encodes will finish' : 'Queue resumed')).catch((e) => toast('error', e.message))}
          />
          <ToolbarButton icon={<Icon.Refresh />} label="Retry failed" wide disabled={!failedCount} onClick={() => api.retryFailedJobs().then((r) => toast('info', `Retrying ${r.retried} job(s)`)).catch((e) => toast('error', e.message))} />
          <ToolbarButton icon={<Icon.Trash />} label="Clear finished" wide disabled={!history.length} onClick={() => api.clearJobs().then(() => toast('info', 'Cleared finished jobs')).catch((e) => toast('error', e.message))} />
        </>
      }
      toolbarRight={
        <>
          <label className="queueLimit" title="How many encodes run at once; the rest wait in the queue. Lowering it lets running encodes finish.">
            At a time
            <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
              {[1, 2, 3, 4, 6, 8].concat(limit > 8 || ![1, 2, 3, 4, 6, 8].includes(limit) ? [limit] : []).sort((a, b) => a - b).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <ToolbarText>
            {encoding ? `${encoding} of ${limit} encoding · ` : ''}
            {queue.length - encoding} queued · {history.length} finished{saved > 0 ? ` · ${fmtBytes(saved)} saved` : ''}
          </ToolbarText>
        </>
      }
    >
      {queuePaused && (
        <div className="warn">
          The queue is paused: running encodes finish, queued ones wait. <button className="btn sm" onClick={() => api.pauseQueue(false).catch((e) => toast('error', e.message))}>Resume</button>
        </div>
      )}
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
                <QueueRow key={j.id} job={j} onLog={setLogJob} onPreview={(x) => setPreviewId(x.id)} />
              ))}
            </tbody>
          </table>
        )}
      </div>
      {logJob && <LogModal job={logJob} onClose={() => setLogJob(null)} />}
      {previewId && <EncodePreviewModal jobId={previewId} onClose={() => setPreviewId(null)} />}
    </Page>
  );
}
