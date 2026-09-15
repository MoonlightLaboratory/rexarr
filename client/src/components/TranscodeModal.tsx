import { useEffect, useMemo, useState } from 'react';
import type { Job, Profile, SizeEstimate, SizeEstimateResult } from '@shared/types';
import { api, fmtBytes, type PreviewResult } from '../api';
import { Icon } from './Icons';
import { QualityLabel } from './Labels';
import { Modal } from './Modal';
import { ProfileSelect } from './ProfileSelect';
import { useApp } from '../App';

export interface TranscodeItem {
  title: string;
  subtitle?: string;
  poster?: string;
  source: Job['source'];
  size?: number;
  quality?: string;
  isRemux?: boolean;
  anime?: boolean;
}

/** Pick a profile and queue one or more library files for encoding. */
export function TranscodeModal({ items, mediaType, onClose, onQueued }: { items: TranscodeItem[]; mediaType: 'movie' | 'tv' | 'anime' | 'music'; onClose: () => void; onQueued?: () => void }) {
  const { profiles, settings, toast } = useApp();
  const [profileId, setProfileId] = useState(settings?.defaultProfiles[mediaType] ?? profiles[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const profile: Profile | undefined = profiles.find((p) => p.id === profileId);
  const previewPath = items.length === 1 ? items[0].source.localPath : undefined;
  const doPreview = async () => {
    setPreviewBusy(true);
    try {
      setPreview(await api.preview({ profileId, path: previewPath }));
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setPreviewBusy(false);
    }
  };
  const nonRemux = items.filter((i) => i.isRemux === false).length;

  // Estimated output size for every profile (one probe on the server, then a model per profile)
  const [estimates, setEstimates] = useState<SizeEstimateResult | null>(null);
  const [estimateError, setEstimateError] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    api
      .estimate(items.map((i) => ({ localPath: i.source.localPath, arrPath: i.source.arrPath, arr: i.source.arr, size: i.size, anime: i.anime || mediaType === 'anime' || undefined })))
      .then((r) => !stale && setEstimates(r))
      .catch((e) => !stale && setEstimateError((e as Error).message));
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const byProfile = useMemo(() => new Map((estimates?.estimates ?? []).map((e) => [e.profileId, e])), [estimates]);
  const suffix = useMemo(() => Object.fromEntries([...byProfile].filter(([, e]) => e.bytes > 0).map(([id, e]) => [id, `≈ ${fmtBytes(e.bytes)}${e.sourceBytes ? ` (${pctChange(e.bytes, e.sourceBytes)})` : ''}`])), [byProfile]);
  const est = byProfile.get(profileId);

  const submit = async () => {
    setBusy(true);
    try {
      if (items.length === 1) {
        await api.createJob({ ...items[0], profileId });
        toast('info', `Queued ${items[0].title}`);
      } else {
        const r = await api.bulkJobs({ profileId, items });
        toast(r.errors.length ? 'warn' : 'info', `Queued ${r.created} of ${items.length}${r.errors.length ? `; ${r.errors[0]}` : ''}`);
      }
      onQueued?.();
      onClose();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={items.length === 1 ? `Transcode · ${items[0].title}` : `Transcode ${items.length} files`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={previewBusy || !profileId} onClick={doPreview} title={previewPath ? 'Probe the file and show the exact ffmpeg command' : 'Show the command for a sample source'}>
            {previewBusy ? <span className="spinner" /> : <Icon.Terminal />} Preview command
          </button>
          <button className="btn primary" disabled={busy || !profileId} onClick={submit}>
            {busy ? <span className="spinner" /> : null} Add to queue
          </button>
        </>
      }
    >
      {items.length === 1 && (
        <div className="list-row" style={{ border: '1px solid var(--border)', borderRadius: 6, marginBottom: 14 }}>
          <div className="thumb" style={{ backgroundImage: items[0].poster ? `url(${items[0].poster})` : undefined }} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>{items[0].title}</div>
            {items[0].subtitle && <div className="dim small">{items[0].subtitle}</div>}
            <div className="small muted truncate" title={items[0].source.localPath ?? items[0].source.arrPath}>
              {items[0].source.arrPath ?? items[0].source.localPath}
            </div>
            <div className="inline small mt" style={{ gap: 6, marginTop: 6 }}>
              {items[0].quality && <QualityLabel quality={items[0].quality} isRemux={items[0].isRemux} />}
              {items[0].size ? <span className="dim">{fmtBytes(items[0].size)}</span> : null}
            </div>
          </div>
        </div>
      )}
      {items.length > 1 && (
        <div className="info">
          {items.length} files will be queued. Total {fmtBytes(items.reduce((a, i) => a + (i.size ?? 0), 0))}.
        </div>
      )}
      {nonRemux > 0 && <div className="warn">{nonRemux} selected file(s) are not Blu-ray remuxes. Re-encoding an already lossy file loses more quality.</div>}
      <div className="field stack">
        <label>Encoding profile</label>
        <ProfileSelect profiles={profiles} value={profileId} onChange={setProfileId} mediaType={mediaType} suffix={suffix} />
        {profile && <div className="help">{profile.description}</div>}
      </div>
      <SizeEstimatePanel est={est} loading={!estimates && !estimateError} error={estimateError} result={estimates} />
      {profile && (
        <div className="grid-2 small">
          <div>
            <div className="dim">Container</div>
            <div>{profile.container.toUpperCase()}</div>
          </div>
          <div>
            <div className="dim">Video</div>
            <div>
              {profile.video.encoder} · q{profile.video.quality}
              {profile.video.preset ? ` · ${profile.video.preset}` : ''}
              {profile.video.tune !== 'none' ? ` · tune ${profile.video.tune}` : ''}
              {profile.video.maxHeight ? ` · ≤${profile.video.maxHeight}p` : ''}
            </div>
          </div>
          <div>
            <div className="dim">Audio</div>
            <div>
              {profile.audio.encoder}
              {profile.audio.bitrate ? ` ${profile.audio.bitrate}k` : ''}
              {profile.audio.languages.length ? ` · ${profile.audio.languages.join(', ')}` : ' · all languages'}
            </div>
          </div>
          <div>
            <div className="dim">Subtitles</div>
            <div>
              {profile.subtitles.mode}
              {profile.subtitles.languages.length ? ` · ${profile.subtitles.languages.join(', ')}` : ''}
            </div>
          </div>
          <div>
            <div className="dim">Output</div>
            <div>{profile.output.replaceOriginal ? 'Replace original file' : profile.output.directory || 'Next to source'}</div>
          </div>
          <div>
            <div className="dim">After encode</div>
            <div>{profile.output.notifyArr ? 'Rescan in Radarr/Sonarr' : 'No rescan'}</div>
          </div>
        </div>
      )}
      {preview && (
        <div className="mt">
          {preview.sample && <div className="info small">The file could not be probed here, so this is the command for a sample UHD remux.</div>}
          {preview.warnings.map((w, i) => (
            <div key={i} className="warn small">
              {w}
            </div>
          ))}
          <ul className="small dim" style={{ margin: '0 0 8px' }}>
            {preview.summary.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
          <pre className="log" style={{ maxHeight: 160 }}>{preview.command}</pre>
        </div>
      )}
    </Modal>
  );
}

const pctChange = (out: number, src: number) => {
  const p = Math.round((out / src - 1) * 100);
  return p === 0 ? 'same size' : `${p > 0 ? '+' : '−'}${Math.abs(p)}%`;
};

/** Estimated output size for the selected profile: best guess, range, and what it is made of. */
function SizeEstimatePanel({ est, loading, error, result }: { est?: SizeEstimate; loading: boolean; error: string | null; result: SizeEstimateResult | null }) {
  if (loading)
    return (
      <div className="sizeEstimate">
        <span className="spinner" /> Estimating output size…
      </div>
    );
  if (error) return <div className="sizeEstimate dim small">Size estimate unavailable: {error}</div>;
  if (!est || !est.bytes) return null;
  const src = est.sourceBytes;
  const pct = src ? Math.min(100, (est.bytes / src) * 100) : 0;
  const parts = [
    ['Video', est.parts.video, 'video'],
    ['Audio', est.parts.audio, 'audio'],
    ['Subtitles', est.parts.subtitles, 'subs'],
    ['Fonts & container', est.parts.other, 'other'],
  ].filter(([, n]) => (n as number) > 0) as [string, number, string][];
  return (
    <div className="sizeEstimate">
      <div className="sizeEstimateHead">
        <div>
          <div className="dim small">Estimated size</div>
          <div className="sizeEstimateValue">
            {est.exact ? '' : '≈ '}
            {fmtBytes(est.bytes)}
            {src ? <span className={`badge sm ${est.bytes < src ? 'green' : 'red'}`}>{pctChange(est.bytes, src)}</span> : null}
          </div>
          {!est.exact && (
            <div className="dim small">
              likely {fmtBytes(est.low)} – {fmtBytes(est.high)}
              {est.videoKbps ? ` · video ≈ ${(est.videoKbps / 1000).toFixed(est.videoKbps < 10000 ? 1 : 0)} Mbps` : ''}
            </div>
          )}
        </div>
        {src ? (
          <div className="dim small" style={{ textAlign: 'right' }}>
            Source
            <div>{fmtBytes(src)}</div>
          </div>
        ) : null}
      </div>
      {src ? (
        <div className="sizeBar" title={`${pct.toFixed(0)} % of the source`}>
          {parts.map(([label, n, cls]) => (
            <div key={label} className={`sizeBarPart ${cls}`} style={{ width: `${Math.min(100, (n / src) * 100)}%` }} />
          ))}
        </div>
      ) : null}
      <div className="sizeLegend small">
        {parts.map(([label, n, cls]) => (
          <span key={label}>
            <i className={`sizeBarPart ${cls}`} /> {label} {fmtBytes(n)}
          </span>
        ))}
      </div>
      {[...est.notes, ...(result?.errors.length ? [`Could not probe: ${result.errors[0]}`] : [])].map((n) => (
        <div key={n} className="dim small">
          {n}
        </div>
      ))}
    </div>
  );
}
