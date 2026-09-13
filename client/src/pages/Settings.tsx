import { useEffect, useState } from 'react';
import type { ArrConnection, Settings } from '@shared/types';
import { api } from '../api';
import { useApp } from '../App';
import { Page, ToolbarButton, ToolbarText } from '../components/Layout';
import { Icon } from '../components/Icons';
import { ProfileSelect } from '../components/ProfileSelect';

function ArrCard({ name, label, hint, conn, onChange }: { name: 'radarr' | 'sonarr' | 'prowlarr'; label: string; hint: string; conn: ArrConnection; onChange: (c: ArrConnection) => void }) {
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
          <input type="text" value={conn.url} onChange={(e) => onChange({ ...conn, url: e.target.value })} placeholder="http://localhost:7878" />
        </div>
        <div className="field">
          <label>API key</label>
          <div className="inline" style={{ flexWrap: 'nowrap' }}>
            <input type={show ? 'text' : 'password'} value={conn.apiKey} onChange={(e) => onChange({ ...conn, apiKey: e.target.value })} placeholder="Settings → General → API Key" autoComplete="off" />
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
      </div>

      <div className="legend">Encoding</div>
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
          </div>
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
          <div className="grid-2">
            <label className="check mb"><input type="checkbox" checked={s.disc.autoRip} onChange={(e) => setS({ ...s, disc: { ...s.disc, autoRip: e.target.checked } })} /> Start ripping automatically once identified</label>
            <label className="check mb"><input type="checkbox" checked={s.disc.autoTranscode} onChange={(e) => setS({ ...s, disc: { ...s.disc, autoTranscode: e.target.checked } })} /> Transcode with the default profile</label>
            <label className="check mb"><input type="checkbox" checked={s.disc.autoDeliver} onChange={(e) => setS({ ...s, disc: { ...s.disc, autoDeliver: e.target.checked } })} /> Hand finished files to Radarr / Sonarr</label>
            <label className="check mb"><input type="checkbox" checked={s.disc.autoEject} onChange={(e) => setS({ ...s, disc: { ...s.disc, autoEject: e.target.checked } })} /> Eject when done</label>
            <label className="check"><input type="checkbox" checked={s.disc.keepRaw} onChange={(e) => setS({ ...s, disc: { ...s.disc, keepRaw: e.target.checked } })} /> Keep the raw MakeMKV rip after transcoding</label>
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
            If Radarr/Sonarr run in Docker or on another machine, the paths they report will not exist here. Map the *arr prefix to the path rexarr can see, e.g. <code>/data/media</code> → <code>/mnt/media</code>. Longest prefix wins.
          </p>
          {s.pathMappings.length === 0 && <div className="muted small">No mappings – paths are used exactly as reported by the *arr apps.</div>}
          {s.pathMappings.map((m, i) => (
            <div key={i} className="inline mb" style={{ flexWrap: 'nowrap' }}>
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
    </Page>
  );
}
