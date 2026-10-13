import { useEffect, useState } from 'react';
import type { Settings } from '@shared/types';
import { useApp } from '../App';
import { api, fmtAge, type AgentRow } from '../api';
import { Page, ToolbarButton } from '../components/Layout';
import { LoadingIndicator } from '../components/Labels';
import { Icon } from '../components/Icons';

/**
 * Settings → Rip farm. The switch, and the machines that have reported in.
 *
 * An agent is a machine running `rexarr-agent` that polls this server and runs what it is told. It holds no
 * library and decides nothing, so there is little to configure: whether it is allowed to take work, how much at
 * once, and where it mounts the shared folder if that differs from here.
 */
export function AgentsPage() {
  const { toast } = useApp();
  const [s, setS] = useState<Settings | null>(null);
  const [saved, setSaved] = useState<Settings | null>(null);
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  const load = () => api.settings().then((v) => (setS(v), setSaved(v)));
  const loadAgents = () => api.agents().then(setAgents).catch(() => setAgents([]));
  useEffect(() => {
    load().catch((e) => toast('error', (e as Error).message));
    loadAgents();
    const t = setInterval(loadAgents, 5000);
    return () => clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = Boolean(s && saved && JSON.stringify(s.agents) !== JSON.stringify(saved.agents));
  const save = async () => {
    if (!s) return;
    try {
      const v = await api.saveSettings(s);
      setS(v);
      setSaved(v);
      toast('info', 'Saved');
    } catch (e) {
      toast('error', (e as Error).message);
    }
  };
  const patch = async (id: string, p: Parameters<typeof api.updateAgent>[1]) => {
    try {
      await api.updateAgent(id, p);
      await loadAgents();
    } catch (e) {
      toast('error', (e as Error).message);
    }
  };
  const forget = async (a: AgentRow) => {
    if (!confirm(`Remove "${a.name}" from the farm? Anything it is running goes back on the queue, and it will ask to be approved again if it reports in.`)) return;
    try {
      await api.deleteAgent(a.id);
      await loadAgents();
    } catch (e) {
      toast('error', (e as Error).message);
    }
  };

  if (!s) return <LoadingIndicator />;
  const on = s.agents?.enabled !== false && s.agents?.enabled === true;
  const waiting = (agents ?? []).filter((a) => !a.enabled).length;

  return (
    <Page
      title="Rip farm"
      toolbarLeft={<ToolbarButton icon={<Icon.Save />} label={dirty ? 'Save' : 'No Changes'} onClick={save} disabled={!dirty} selected={dirty} />}
    >
      <div className="card mb">
        <div className="card-h">
          <label className="check">
            <input type="checkbox" checked={on} onChange={(e) => setS({ ...s, agents: { ...s.agents, enabled: e.target.checked } })} /> Rip farm mode
          </label>
          <span className="spacer" />
          <span className="small dim">other machines, one queue</span>
        </div>
        <div className="card-b">
          <div className="small dim mb">
            An <strong>agent</strong> is <code>rexarr-agent</code> running on another machine: a Pi with a USB drive on
            the shelf, a spare desktop with a fast CPU. It polls this server, says what it can do, and runs the rips and
            encodes it is given. It holds no library, no profiles and no metadata, and decides nothing — everything that
            makes a decision stays here.
            <br />
            <br />
            Agent and server must see the same files. Mount the same share on both; where a machine mounts it somewhere
            else, give that agent a path mapping below. Nothing but commands and progress travels over the network.
          </div>
          <div className="field stack">
            <label>Start an agent with</label>
            <input type="text" className="mono" readOnly value={`rexarr-agent --server ${location.origin} --key <your API key>`} onFocus={(e) => e.currentTarget.select()} />
            <div className="help">
              The API key is under <strong>Settings → General → Security</strong>. Add <code>--virtual-drives &lt;dir&gt;</code> to
              offer a folder of disc images as drives, the way this server's own virtual drives work.
            </div>
          </div>
          <div className="grid-2">
            <div className="field">
              <label>New agents need approving</label>
              <select value={String(s.agents?.requireApproval !== false)} onChange={(e) => setS({ ...s, agents: { ...s.agents, requireApproval: e.target.value === 'true' } })}>
                <option value="true">Yes – a new agent waits here</option>
                <option value="false">No – anything with the API key joins</option>
              </select>
            </div>
            <div className="field">
              <label>Keep this many encodes here first</label>
              <input
                type="number"
                min={0}
                max={32}
                value={s.agents?.localFirst ?? 0}
                onChange={(e) => setS({ ...s, agents: { ...s.agents, localFirst: Number(e.target.value) } })}
              />
              <span className="hint">0 sends every encode to an agent when one is free. 1 keeps the first for this machine.</span>
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-h">
          Agents
          <span className="spacer" />
          {waiting > 0 && <span className="badge amber">{waiting} waiting to be approved</span>}
        </div>
        <div className="card-b">
          {agents === null ? (
            <LoadingIndicator />
          ) : !agents.length ? (
            <div className="small dim">Nothing has reported in yet. Start an agent with the command above and it will appear here.</div>
          ) : (
            agents.map((a) => (
              <div key={a.id} className="list-row" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 240px' }}>
                  <div>
                    <strong>{a.name}</strong>{' '}
                    <span className={`badge sm ${a.online ? 'green' : 'red'}`}>{a.online ? 'online' : `last seen ${fmtAge(a.lastSeen)}`}</span>{' '}
                    {!a.enabled && <span className="badge sm amber">waiting to be approved</span>}
                  </div>
                  <div className="small dim">
                    {a.capabilities.platform}/{a.capabilities.arch} · {a.capabilities.cpus} CPUs · {Math.round(a.capabilities.totalMemoryBytes / 1e9)} GB · v{a.version}
                    {a.address ? ` · ${a.address}` : ''}
                  </div>
                  <div className="small dim">
                    {a.capabilities.rip ? `MakeMKV ${a.capabilities.makemkvVersion ?? ''}` : 'no MakeMKV'} ·{' '}
                    {a.capabilities.transcode ? `ffmpeg ${a.capabilities.ffmpegVersion ?? ''}${a.capabilities.hardware ? ` (${a.capabilities.hardware})` : ''}` : 'no ffmpeg'}
                  </div>
                  {a.drives.length > 0 && <div className="small dim">Drives: {a.drives.map((d) => `${d.name}${d.state === 'loaded' ? ' (disc in)' : ''}`).join(', ')}</div>}
                  {a.tasks.map((t) => (
                    <div key={t.id} className="small">
                      {t.kind}: {t.label} — {Math.round(t.progress?.percent ?? 0)}%
                    </div>
                  ))}
                </div>
                <div className="field" style={{ width: 90 }}>
                  <label>At once</label>
                  <input type="number" min={1} max={16} value={a.concurrency} onChange={(e) => patch(a.id, { concurrency: Number(e.target.value) })} />
                </div>
                <div className="field" style={{ flex: '1 1 320px' }}>
                  <label>Path mappings</label>
                  <input
                    type="text"
                    className="mono"
                    placeholder="/mnt/media=/Volumes/Media, one per comma"
                    defaultValue={(a.pathMappings ?? []).map((m) => `${m.remote}=${m.local}`).join(', ')}
                    onBlur={(e) =>
                      patch(a.id, {
                        pathMappings: e.target.value
                          .split(',')
                          .map((x) => x.trim())
                          .filter(Boolean)
                          .map((x) => ({ remote: x.split('=')[0]?.trim() ?? '', local: x.split('=')[1]?.trim() ?? '' }))
                          .filter((m) => m.remote && m.local),
                      })
                    }
                  />
                  <span className="hint">What this server calls a folder = what that agent calls it.</span>
                </div>
                <div className="inline" style={{ alignSelf: 'center' }}>
                  <button className="btn sm" onClick={() => patch(a.id, { enabled: !a.enabled })}>
                    {a.enabled ? 'Pause' : 'Approve'}
                  </button>
                  <button className="btn sm danger" onClick={() => forget(a)}>
                    Remove
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </Page>
  );
}
