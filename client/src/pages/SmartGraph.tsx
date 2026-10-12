import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Profile, SmartAssignment, SmartCondition, SmartProfile, SmartRule, SmartSettingPath } from '@shared/types';
import { decide, describeCondition, isPassThrough, fieldInfo, operatorsFor, OPERATOR_LABELS, ruleMatches, SAMPLE_SOURCES, settingInfo, SMART_FIELDS, SMART_SETTINGS } from '@shared/smart';
import { AUDIO_ENCODER_INFO, CONTAINER_INFO, VIDEO_ENCODER_INFO } from '@shared/presets';
import { api } from '../api';
import { useApp } from '../App';
import { Icon } from '../components/Icons';

/**
 * The node canvas. A smart profile is a chain – branch, branch, fallback – and the wires are drawn from that
 * chain rather than dragged by hand: a Yes goes to what that branch does, a No goes to the next question. What a
 * node asks and what it does is edited in the node itself, and nodes can be dragged anywhere; where they sit is
 * saved with the profile.
 */

type Pos = { x: number; y: number };
const GRID = 10;
const snap = (n: number) => Math.round(n / GRID) * GRID;

/** Every node on the canvas, with the id its position is stored under. */
interface Node {
  id: string;
  kind: 'start' | 'base' | 'branch' | 'all' | 'compare' | 'read' | 'set' | 'result';
  pos: Pos;
  ruleIndex?: number;
  condIndex?: number;
}

/** A wire between two ports. */
interface Wire {
  from: string;
  to: string;
  kind: 'flow' | 'data';
  /** Which branch this leaves, so the path the sample disc takes can be drawn differently. */
  rule?: number;
  branch?: 'yes' | 'no';
}

const condNodeId = (ruleId: string, i: number, kind: 'compare' | 'read') => `${kind}:${ruleId}:${i}`;

/** Where nodes go when nothing has been dragged: the chain down the left, what each branch does to its right. */
function autoLayout(sp: SmartProfile): Record<string, Pos> {
  const out: Record<string, Pos> = { start: { x: 30, y: 180 }, base: { x: 210, y: 140 } };
  let y = 150;
  sp.rules.forEach((rule, i) => {
    const branchId = `rule:${rule.id}`;
    out[branchId] = { x: 530, y };
    out[`set:${rule.id}`] = { x: 840, y: y - 30 };
    const many = rule.when.length > 1;
    if (many) out[`all:${rule.id}`] = { x: 530, y: y + 200 };
    const base = many ? y + 330 : y + 210;
    let anyCompare = false;
    rule.when.forEach((c, ci) => {
      const kind = fieldInfo(c.field)?.kind === 'boolean' ? 'read' : 'compare';
      out[condNodeId(rule.id, ci, kind)] = { x: 490 + ci * 300, y: base };
      if (kind === 'compare') {
        out[`read:${rule.id}:${ci}`] = { x: 490 + ci * 300, y: base + 210 };
        anyCompare = true;
      }
    });
    y = base + (anyCompare ? 210 + 170 : 170) + 70;
  });
  out['result'] = { x: 840, y };
  return out;
}

function Port({ id, side, tone, label }: { id: string; side: 'left' | 'right' | 'top' | 'bottom'; tone?: 'flow' | 'data' | 'value'; label?: string }) {
  return (
    <span className={`gPort ${side} ${tone ?? 'flow'}`} data-port={id}>
      {label && <span className="gPortLabel">{label}</span>}
    </span>
  );
}

/** Which way the sample disc leaves a branch, so the row it takes can be marked. */
function BranchRow({ id, label, taken }: { id: string; label: string; taken?: boolean }) {
  return (
    <div className={`gRow${taken ? ' taken' : ''}`}>
      {label}
      <Port id={id} side="right" />
    </div>
  );
}

export function SmartGraphPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const { profiles, smartProfiles, reloadSmartProfiles, toast } = useApp();
  const [sp, setSp] = useState<SmartProfile | null>(null);
  const [sample, setSample] = useState(0);
  const [showTry, setShowTry] = useState(true);
  const [details, setDetails] = useState(false);
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState({ x: 0, y: 0, z: 1 });
  const [ports, setPorts] = useState<Record<string, Pos>>({});
  const surface = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const drag = useRef<{ node?: string; startPos: Pos; origin: Pos; panning?: boolean } | null>(null);
  const nodeSizes = useRef<Record<string, { w: number; h: number }>>({});
  // once the view has been moved by hand, resizing the window stops re-framing it
  const touched = useRef(false);

  useEffect(() => {
    if (sp) return;
    if (id === 'new') {
      const blank: SmartProfile = {
        id: '', name: '', description: '', builtin: false, mediaType: 'any',
        container: 'mkv',
        base: [
          { path: 'video.encoder', value: 'copy' },
          { path: 'audio.encoder', value: 'copy' },
          { path: 'subtitles.mode', value: 'copy' },
        ],
        rules: [{ id: 'r1', when: [{ field: 'audio.objectBased', op: 'isFalse' }], set: [{ path: 'audio.encoder', value: 'flac' }] }],
        createdAt: '', updatedAt: '',
      };
      setSp(blank);
      // a new one starts dirty: there is something to save
      setSaved('');
      return;
    }
    const found = smartProfiles.find((x) => x.id === id);
    if (found) {
      setSp(structuredClone(found));
      setSaved(JSON.stringify(found));
    }
  }, [id, smartProfiles, sp]);

  const readOnly = Boolean(sp?.builtin);
  // layout moves count as changes too: where a node sits is part of the profile
  const dirty = Boolean(sp) && JSON.stringify(sp) !== saved;
  const leave = () => {
    if (dirty && !readOnly && !confirm('Leave without saving? The changes to this smart profile will be lost.')) return;
    nav('/profiles');
  };
  const profileName = useCallback((pid: string) => profiles.find((p) => p.id === pid)?.name, [profiles]);
  const facts = SAMPLE_SOURCES[sample].facts;
  const decision = useMemo(() => (sp ? decide(sp, facts) : null), [sp, facts]);

  // ---- the nodes and wires this profile draws as -------------------------------------------------
  const { nodes, wires } = useMemo(() => {
    if (!sp) return { nodes: [] as Node[], wires: [] as Wire[] };
    const auto = autoLayout(sp);
    const at = (nid: string): Pos => sp.layout?.[nid] ?? auto[nid] ?? { x: 0, y: 0 };
    const nodes: Node[] = [
      { id: 'start', kind: 'start', pos: at('start') },
      { id: 'base', kind: 'base', pos: at('base') },
    ];
    const wires: Wire[] = [{ from: 'start:out', to: 'base:in', kind: 'flow' }];
    let previous = 'base:out';
    sp.rules.forEach((rule, i) => {
      const branchId = `rule:${rule.id}`;
      nodes.push({ id: branchId, kind: 'branch', pos: at(branchId), ruleIndex: i });
      // the spine runs through every branch: each one that fits changes the settings and the file carries on
      wires.push({ from: previous, to: `${branchId}:in`, kind: 'flow' });
      previous = `${branchId}:next`;
      // what this branch changes when it fits
      nodes.push({ id: `set:${rule.id}`, kind: 'set', pos: at(`set:${rule.id}`), ruleIndex: i });
      wires.push({ from: `${branchId}:then`, to: `set:${rule.id}:in`, kind: 'flow', rule: i, branch: 'yes' });
      // and where the question comes from
      const many = rule.when.length > 1;
      const allId = `all:${rule.id}`;
      if (many) {
        nodes.push({ id: allId, kind: 'all', pos: at(allId), ruleIndex: i });
        wires.push({ from: `${allId}:out`, to: `${branchId}:cond`, kind: 'data' });
      }
      rule.when.forEach((c, ci) => {
        const kind = fieldInfo(c.field)?.kind === 'boolean' ? 'read' : 'compare';
        const nid = condNodeId(rule.id, ci, kind);
        nodes.push({ id: nid, kind, pos: at(nid), ruleIndex: i, condIndex: ci });
        wires.push({ from: `${nid}:out`, to: many ? `${allId}:in${ci}` : `${branchId}:cond`, kind: 'data' });
        if (kind === 'compare') {
          const rid = `read:${rule.id}:${ci}`;
          nodes.push({ id: rid, kind: 'read', pos: at(rid), ruleIndex: i, condIndex: ci });
          wires.push({ from: `${rid}:out`, to: `${nid}:a`, kind: 'data' });
        }
      });
    });
    nodes.push({ id: 'result', kind: 'result', pos: at('result') });
    wires.push({ from: previous, to: 'result:in', kind: 'flow' });
    return { nodes, wires };
  }, [sp]);

  // ---- port positions, measured: node heights depend on what is in them ---------------------------
  useLayoutEffect(() => {
    const el = layer.current;
    if (!el) return;
    const base = el.getBoundingClientRect();
    const next: Record<string, Pos> = {};
    el.querySelectorAll<HTMLElement>('[data-port]').forEach((p) => {
      const r = p.getBoundingClientRect();
      next[p.dataset.port!] = { x: (r.left + r.width / 2 - base.left) / view.z, y: (r.top + r.height / 2 - base.top) / view.z };
    });
    setPorts(next);
    // how big each node actually came out, so Fit frames what is there rather than a guess at it
    const sizes: Record<string, { w: number; h: number }> = {};
    el.querySelectorAll<HTMLElement>('[data-node]').forEach((n) => {
      const r = n.getBoundingClientRect();
      sizes[n.dataset.node!] = { w: r.width / view.z, h: r.height / view.z };
    });
    nodeSizes.current = sizes;
  }, [nodes, view.z, sp]);

  // ---- dragging a node, panning the canvas --------------------------------------------------------
  const onNodeDown = (e: React.MouseEvent, nodeId: string, pos: Pos) => {
    if (readOnly) return;
    e.stopPropagation();
    drag.current = { node: nodeId, startPos: pos, origin: { x: e.clientX, y: e.clientY } };
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDetails(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = (e.clientX - d.origin.x) / view.z;
      const dy = (e.clientY - d.origin.y) / view.z;
      if (d.panning) setView((v) => ({ ...v, x: d.startPos.x + dx * v.z, y: d.startPos.y + dy * v.z }));
      else if (d.node) setSp((x) => (x ? { ...x, layout: { ...x.layout, [d.node!]: { x: snap(d.startPos.x + dx), y: snap(d.startPos.y + dy) } } } : x));
    };
    const up = () => (drag.current = null);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [view.z]);

  const onSurfaceDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    touched.current = true;
    drag.current = { panning: true, startPos: { x: view.x, y: view.y }, origin: { x: e.clientX, y: e.clientY } };
  };
  const onWheel = (e: React.WheelEvent) => {
    touched.current = true;
    const rect = surface.current!.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    setView((v) => {
      const z = Math.min(2, Math.max(0.3, v.z * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
      // keep the point under the cursor still
      return { z, x: mx - ((mx - v.x) / v.z) * z, y: my - ((my - v.y) / v.z) * z };
    });
  };

  const fit = useCallback(() => {
    touched.current = false;
    const rect = surface.current?.getBoundingClientRect();
    if (!rect || !nodes.length) return;
    const size = (nid: string) => nodeSizes.current[nid] ?? { w: 260, h: 150 };
    const minX = Math.min(...nodes.map((n) => n.pos.x));
    const minY = Math.min(...nodes.map((n) => n.pos.y));
    const w = Math.max(...nodes.map((n) => n.pos.x + size(n.id).w)) - minX;
    const h = Math.max(...nodes.map((n) => n.pos.y + size(n.id).h)) - minY;
    // never shrink past readable – panning is there for the rest – and sit the graph in the middle of the space
    // leave the sample-disc panel its corner rather than framing nodes underneath it
    const usable = rect.width - (showTry ? 340 : 80);
    const z = Math.max(0.6, Math.min(1, Math.min(usable / w, (rect.height - 80) / h)));
    setView({ z, x: Math.max(30, (usable - w * z) / 2) - minX * z, y: Math.max(30, (rect.height - h * z) / 2) - minY * z });
  }, [nodes, showTry]);
  useEffect(() => {
    if (sp && nodes.length) fit();
    // only when the profile first loads
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sp?.id]);

  // the first fit can run before the pane has settled, and the sidebar can be collapsed later
  useEffect(() => {
    const el = surface.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (!touched.current) fit();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);

  // ---- editing ------------------------------------------------------------------------------------
  const setRule = (i: number, rule: SmartRule) => setSp((x) => (x ? { ...x, rules: x.rules.map((r, j) => (j === i ? rule : r)) } : x));
  const setCond = (ri: number, ci: number, c: SmartCondition) => sp && setRule(ri, { ...sp.rules[ri], when: sp.rules[ri].when.map((x, j) => (j === ci ? c : x)) });
  const addRule = () =>
    setSp((x) =>
      x ? { ...x, rules: [...x.rules, { id: Math.random().toString(36).slice(2, 10), when: [{ field: 'audio.maxChannels', op: 'atMost', number: 2 }], set: [{ path: 'audio.encoder', value: 'flac' }] }] } : x,
    );
  const removeRule = (i: number) => setSp((x) => (x ? { ...x, rules: x.rules.filter((_, j) => j !== i) } : x));
  const moveRule = (i: number, by: number) =>
    setSp((x) => {
      if (!x) return x;
      const rules = [...x.rules];
      const j = i + by;
      if (j < 0 || j >= rules.length) return x;
      [rules[i], rules[j]] = [rules[j], rules[i]];
      return { ...x, rules };
    });

  const save = async () => {
    if (!sp) return;
    setBusy(true);
    try {
      if (sp.id) {
        await api.updateSmartProfile(sp.id, sp);
        setSaved(JSON.stringify(sp));
      } else {
        const created = await api.createSmartProfile(sp);
        setSp(created);
        setSaved(JSON.stringify(created));
        nav(`/profiles/smart/${created.id}`, { replace: true });
      }
      await reloadSmartProfiles();
      toast('info', `Saved “${sp.name}”`);
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!sp) return <div className="graphPage"><div className="empty">Loading…</div></div>;

  /** Does this wire carry anything for the sample disc? Only the branches that fit change its settings. */
  const onPath = (w: Wire) => {
    if (!decision || w.rule === undefined) return undefined;
    return decision.applied.some((a) => a.index === w.rule);
  };
  const passThrough = decision ? isPassThrough(decision.profile) : false;

  const wire = (w: Wire) => {
    const a = ports[w.from];
    const b = ports[w.to];
    if (!a || !b) return null;
    const vertical = Math.abs(b.y - a.y) > Math.abs(b.x - a.x) && w.kind === 'data';
    const d = vertical
      ? `M ${a.x} ${a.y} C ${a.x} ${(a.y + b.y) / 2}, ${b.x} ${(a.y + b.y) / 2}, ${b.x} ${b.y}`
      : `M ${a.x} ${a.y} C ${a.x + Math.max(40, (b.x - a.x) / 2)} ${a.y}, ${b.x - Math.max(40, (b.x - a.x) / 2)} ${b.y}, ${b.x} ${b.y}`;
    const live = onPath(w);
    return <path key={`${w.from}->${w.to}`} d={d} className={`gWire ${w.kind}${live === true ? ' live' : live === false ? ' dim' : ''}`} />;
  };

  return (
    <div className="graphPage">
      <div className="graphBar">
        <button className="btn sm" onClick={leave} title="Back to profiles">
          <Icon.ArrowLeftCircle /> Profiles
        </button>
        <input className="graphName" value={sp.name} readOnly={readOnly} placeholder="Name this smart profile" onChange={(e) => setSp({ ...sp, name: e.target.value })} />
        <button className={`btn sm${details ? ' primary' : ''}`} onClick={() => setDetails((d) => !d)} title="Description and what this is for">
          Details
        </button>
        {readOnly && <span className="badge muted">Built-in · read-only</span>}
        {dirty && !readOnly && <span className="badge amber">Unsaved</span>}
        <span className="spacer" />
        <div className="gZoom">
          <button className="gIcon" onClick={() => setView((v) => ({ ...v, z: Math.max(0.3, v.z / 1.15) }))} title="Zoom out">
            –
          </button>
          <button className="gIcon wide" onClick={fit} title="Fit the whole graph">
            {Math.round(view.z * 100)}%
          </button>
          <button className="gIcon" onClick={() => setView((v) => ({ ...v, z: Math.min(2, v.z * 1.15) }))} title="Zoom in">
            +
          </button>
        </div>
        <button className="btn sm" onClick={() => setSp({ ...sp, layout: {} })} disabled={readOnly} title="Put every node back where it started">
          Tidy up
        </button>
        <button className="btn sm" onClick={addRule} disabled={readOnly}>
          <Icon.Plus /> Branch
        </button>
        <button className="btn sm primary" onClick={save} disabled={busy || readOnly || !sp.name.trim() || !dirty}>
          {busy ? <span className="spinner" /> : <Icon.Check />} Save
        </button>
      </div>

      {details && (
        <div className="graphDetails">
          <div className="field stack">
            <label>Description</label>
            <input value={sp.description} readOnly={readOnly} placeholder="What this decides, and why" onChange={(e) => setSp({ ...sp, description: e.target.value })} />
          </div>
          <div className="field stack">
            <label>For</label>
            <select value={sp.mediaType} disabled={readOnly} onChange={(e) => setSp({ ...sp, mediaType: e.target.value as SmartProfile['mediaType'] })}>
              <option value="any">Anything</option>
              <option value="movie">Movies</option>
              <option value="tv">TV</option>
              <option value="anime">Anime</option>
            </select>
          </div>
        </div>
      )}

      <div className="graphSurface" ref={surface} onMouseDown={onSurfaceDown} onWheel={onWheel} style={{ backgroundSize: `${22 * view.z}px ${22 * view.z}px`, backgroundPosition: `${view.x}px ${view.y}px` }}>
        <div className="graphLayer" ref={layer} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}>
          <svg className="graphWires">{wires.map(wire)}</svg>

          {!sp.rules.length && (
            <div className="gEmpty" style={{ left: 250, top: 150 }}>
              No branches yet – every file goes straight to <em>Anything else</em>.
              <button className="btn sm mt" onClick={addRule} disabled={readOnly}>
                <Icon.Plus /> Add the first branch
              </button>
            </div>
          )}
          {nodes.map((n) => {
            const rule = n.ruleIndex !== undefined ? sp.rules[n.ruleIndex] : undefined;
            const chosen = Boolean(decision && n.ruleIndex !== undefined && decision.applied.some((a) => a.index === n.ruleIndex));
            const live = rule ? ruleMatches(rule, facts) : false;
            return (
              <div key={n.id} data-node={n.id} className={`gNode ${n.kind}${chosen ? ' chosen' : ''}${rule?.enabled === false ? ' off' : ''}`} style={{ left: n.pos.x, top: n.pos.y }}>
                {/* ---- the entry pill ---- */}
                {n.kind === 'start' && (
                  <div className="gStart" onMouseDown={(e) => onNodeDown(e, n.id, n.pos)}>
                    A file to encode
                    <Port id="start:out" side="right" />
                  </div>
                )}

                {/* ---- a question with a Yes and a No ---- */}
                {n.kind === 'branch' && rule && (
                  <>
                    <div className="gHead" onMouseDown={(e) => onNodeDown(e, n.id, n.pos)}>
                      <input
                        className="gName"
                        value={rule.label ?? ''}
                        readOnly={readOnly}
                        placeholder={`Branch ${n.ruleIndex! + 1}`}
                        onMouseDown={(e) => e.stopPropagation()}
                        onChange={(e) => setRule(n.ruleIndex!, { ...rule, label: e.target.value })}
                      />
                      <span className="spacer" />
                      {live && rule.enabled !== false && <span className="gTag">true</span>}
                      <button
                        className={`gIcon${rule.enabled === false ? ' off' : ''}`}
                        disabled={readOnly}
                        onClick={() => setRule(n.ruleIndex!, { ...rule, enabled: rule.enabled === false })}
                        title={rule.enabled === false ? 'Switched off – click to use this branch again' : 'Switch this branch off without deleting it'}
                      >
                        {rule.enabled === false ? '○' : '●'}
                      </button>
                      <button className="gIcon" disabled={readOnly || n.ruleIndex === 0} onClick={() => moveRule(n.ruleIndex!, -1)} title="Ask this one earlier">↑</button>
                      <button className="gIcon" disabled={readOnly || n.ruleIndex === sp.rules.length - 1} onClick={() => moveRule(n.ruleIndex!, 1)} title="Ask this one later">↓</button>
                      <button className="gIcon danger" disabled={readOnly} onClick={() => removeRule(n.ruleIndex!)} title="Remove this branch">
                        <Icon.Trash />
                      </button>
                    </div>
                    <div className="gAskHead">
                      <select
                        className="gAnyAll"
                        value={rule.match ?? 'all'}
                        disabled={readOnly}
                        onChange={(e) => setRule(n.ruleIndex!, { ...rule, match: e.target.value as 'all' | 'any' })}
                      >
                        <option value="all">All of</option>
                        <option value="any">Any of</option>
                      </select>
                      <span className="gAsk" title={rule.when.map(describeCondition).join(rule.match === 'any' ? ' or ' : ' and ')}>
                        {rule.when.map(describeCondition).join(rule.match === 'any' ? ' or ' : ' and ') || 'Nothing yet – this branch never matches'}
                      </span>
                    </div>
                    <div className="gBranchRows">
                      <BranchRow id={`rule:${rule.id}:then`} label="Then" taken={live} />
                      <BranchRow id={`rule:${rule.id}:next`} label="Carry on" />
                    </div>
                    <Port id={`rule:${rule.id}:in`} side="left" />
                    <Port id={`rule:${rule.id}:cond`} side="bottom" tone="data" label="Condition" />
                  </>
                )}

                {/* ---- every condition has to hold ---- */}
                {n.kind === 'all' && rule && (
                  <>
                    <div className="gHead" onMouseDown={(e) => onNodeDown(e, n.id, n.pos)}>
                      <span>{rule.match === 'any' ? 'Any of' : 'All of'}</span>
                    </div>
                    <div className="gBody small dim">All {rule.when.length} have to hold</div>
                    <Port id={`all:${rule.id}:out`} side="top" tone="data" />
                    <div className="gInputs">
                      {rule.when.map((_, ci) => (
                        <Port key={ci} id={`all:${rule.id}:in${ci}`} side="bottom" tone="data" label={String(ci + 1)} />
                      ))}
                    </div>
                  </>
                )}

                {/* ---- compare a number ---- */}
                {n.kind === 'compare' && rule && n.condIndex !== undefined && (
                  <>
                    <div className="gHead" onMouseDown={(e) => onNodeDown(e, n.id, n.pos)}>
                      <span>{fieldInfo(rule.when[n.condIndex].field)?.kind === 'list' ? 'Is one of' : 'Comparison'}</span>
                      <span className="spacer" />
                      <button className="gIcon danger" disabled={readOnly || rule.when.length < 2} onClick={() => setRule(n.ruleIndex!, { ...rule, when: rule.when.filter((_, j) => j !== n.condIndex) })} title="Remove this condition">
                        <Icon.Trash />
                      </button>
                    </div>
                    <div className="gBody">
                      <label className="gLabel">Operation</label>
                      <select value={rule.when[n.condIndex].op} disabled={readOnly} onChange={(e) => setCond(n.ruleIndex!, n.condIndex!, { ...rule.when[n.condIndex!], op: e.target.value as SmartCondition['op'] })}>
                        {operatorsFor(fieldInfo(rule.when[n.condIndex].field)?.kind ?? 'number').map((op) => (
                          <option key={op} value={op}>
                            {OPERATOR_LABELS[op]}
                          </option>
                        ))}
                      </select>
                      {fieldInfo(rule.when[n.condIndex].field)?.kind === 'number' ? (
                        <div className="gB">
                          <span className="gLabel">B:</span>
                          <input type="number" min={0} disabled={readOnly} value={rule.when[n.condIndex].number ?? 0} onChange={(e) => setCond(n.ruleIndex!, n.condIndex!, { ...rule.when[n.condIndex!], number: Number(e.target.value) })} />
                          <span className="gUnit">{fieldInfo(rule.when[n.condIndex].field)?.unit}</span>
                        </div>
                      ) : (
                        <div className="chips">
                          {(fieldInfo(rule.when[n.condIndex].field)?.options ?? []).map((o) => {
                            const on = (rule.when[n.condIndex!].list ?? []).includes(o.value);
                            return (
                              <span
                                key={o.value}
                                className={`chip${on ? ' on' : ''}`}
                                onClick={() => !readOnly && setCond(n.ruleIndex!, n.condIndex!, { ...rule.when[n.condIndex!], list: on ? (rule.when[n.condIndex!].list ?? []).filter((v) => v !== o.value) : [...(rule.when[n.condIndex!].list ?? []), o.value] })}
                              >
                                {o.label}
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    <Port id={`${n.id}:out`} side="top" tone="data" />
                    <Port id={`${n.id}:a`} side="bottom" tone="value" label="A" />
                  </>
                )}

                {/* ---- read something off the file ---- */}
                {n.kind === 'read' && rule && n.condIndex !== undefined && (
                  <>
                    <div className="gHead" onMouseDown={(e) => onNodeDown(e, n.id, n.pos)}>
                      <span>Read from the file</span>
                      {fieldInfo(rule.when[n.condIndex].field)?.kind === 'boolean' && (
                        <>
                          <span className="spacer" />
                          <button className="gIcon danger" disabled={readOnly || rule.when.length < 2} onClick={() => setRule(n.ruleIndex!, { ...rule, when: rule.when.filter((_, j) => j !== n.condIndex) })} title="Remove this condition">
                            <Icon.Trash />
                          </button>
                        </>
                      )}
                    </div>
                    <div className="gBody">
                      <select
                        value={rule.when[n.condIndex].field}
                        disabled={readOnly}
                        onChange={(e) => {
                          const next = fieldInfo(e.target.value as SmartCondition['field']);
                          setCond(n.ruleIndex!, n.condIndex!, { field: e.target.value as SmartCondition['field'], op: operatorsFor(next?.kind ?? 'number')[0], number: next?.kind === 'number' ? 2 : undefined, list: next?.kind === 'list' ? [] : undefined });
                        }}
                      >
                        {SMART_FIELDS.map((f) => (
                          <option key={f.field} value={f.field}>
                            {f.label}
                          </option>
                        ))}
                      </select>
                      {fieldInfo(rule.when[n.condIndex].field)?.kind === 'boolean' && (
                        <select value={rule.when[n.condIndex].op} disabled={readOnly} onChange={(e) => setCond(n.ruleIndex!, n.condIndex!, { ...rule.when[n.condIndex!], op: e.target.value as SmartCondition['op'] })}>
                          <option value="isTrue">yes</option>
                          <option value="isFalse">no</option>
                        </select>
                      )}
                      <div className="gHelp">{fieldInfo(rule.when[n.condIndex].field)?.help}</div>
                    </div>
                    <Port id={`${n.id}:out`} side="top" tone="data" />
                  </>
                )}

                {/* ---- the settings this profile starts from ---- */}
                {n.kind === 'base' && (
                  <>
                    <div className="gHead" onMouseDown={(e) => onNodeDown(e, n.id, n.pos)}>
                      <span>Start from</span>
                    </div>
                    <div className="gBody">
                      <label className="gLabel">Container</label>
                      <select value={sp.container} disabled={readOnly} onChange={(e) => setSp({ ...sp, container: e.target.value as SmartProfile['container'] })}>
                        {Object.entries(CONTAINER_INFO)
                          .filter(([, v]) => !v.music)
                          .map(([value, v]) => (
                            <option key={value} value={value}>
                              {v.label}
                            </option>
                          ))}
                      </select>
                      <Assignments list={sp.base} readOnly={readOnly} onChange={(base) => setSp({ ...sp, base })} />
                    </div>
                    <Port id="base:in" side="left" />
                    <Port id="base:out" side="right" />
                  </>
                )}

                {/* ---- what a branch changes ---- */}
                {n.kind === 'set' && rule && (
                  <>
                    <div className="gHead" onMouseDown={(e) => onNodeDown(e, n.id, n.pos)}>
                      <span>Set</span>
                      <span className="spacer" />
                      {chosen && <span className="gTag on">applied</span>}
                    </div>
                    <div className="gBody">
                      <Assignments list={rule.set} readOnly={readOnly} onChange={(set) => setRule(n.ruleIndex!, { ...rule, set })} />
                    </div>
                    <Port id={`set:${rule.id}:in`} side="left" />
                  </>
                )}

                {/* ---- and what that comes to for the disc being tried ---- */}
                {n.kind === 'result' && decision && (
                  <>
                    <div className="gHead" onMouseDown={(e) => onNodeDown(e, n.id, n.pos)}>
                      <span>Encode with</span>
                      <span className="spacer" />
                      <span className="gTag">{SAMPLE_SOURCES[sample].name}</span>
                    </div>
                    <div className="gBody">
                      <div className="gResultRows">
                        {RESULT_ROWS.map(({ path, show }) => {
                          const value = show(decision.profile);
                          const branch = decision.from[path];
                          return (
                            <div key={path} className={`gResultRow${branch !== undefined ? ' set' : ''}`}>
                              <span className="gLabel">{settingInfo(path)?.label ?? path}</span>
                              <span className="spacer" />
                              <span>{value}</span>
                              {branch !== undefined && <span className="gTag">#{branch + 1}</span>}
                            </div>
                          );
                        })}
                      </div>
                      {passThrough && <div className="gHelp">Every stream copied into the same container – Rexarr queues no encode at all for this one.</div>}
                    </div>
                    <Port id="result:in" side="left" />
                  </>
                )}
              </div>
            );
          })}
        </div>

        {showTry && decision && (
          <div className="graphTry">
            <div className="inline">
              <strong className="small">Try it</strong>
              <span className="spacer" />
              <button className="gIcon" onClick={() => setShowTry(false)} title="Hide">
                <Icon.X />
              </button>
            </div>
            <select value={sample} onChange={(e) => setSample(Number(e.target.value))}>
              {SAMPLE_SOURCES.map((s, i) => (
                <option key={s.name} value={i}>
                  {s.name}
                </option>
              ))}
            </select>
            <div className="small dim mono">
              {facts.audio.maxChannels}ch {facts.audio.codecs.join('/')}
              {facts.audio.objectBased ? ' · object audio' : ''} · {facts.video.height}p{facts.video.hdr ? ' HDR' : ''}
            </div>
            <div className="small gResult">
              →{' '}
              <strong>
                {passThrough
                  ? 'nothing to encode'
                  : `${decision.profile.video.encoder === 'copy' ? 'video kept' : `${decision.profile.video.encoder} CRF ${decision.profile.video.quality}`} · ${decision.profile.audio.encoder === 'copy' ? 'audio kept' : decision.profile.audio.encoder}`}
              </strong>
              <div className="dim">{decision.applied.length ? `branch ${decision.applied.map((a) => a.index + 1).join(', ')} applied` : 'no branch matched'}</div>
            </div>
          </div>
        )}
        {!showTry && (
          <button className="btn sm graphTryShow" onClick={() => setShowTry(true)}>
            Try it
          </button>
        )}
      </div>
    </div>
  );
}

/** The rows that make up a Start from or a Set node: a setting and the value it is given. */
function Assignments({ list, readOnly, onChange }: { list: SmartAssignment[]; readOnly?: boolean; onChange: (list: SmartAssignment[]) => void }) {
  const set = (i: number, a: SmartAssignment) => onChange(list.map((x, j) => (j === i ? a : x)));
  const add = () => {
    const used = new Set(list.map((a) => a.path));
    const next = SMART_SETTINGS.find((s) => !used.has(s.path)) ?? SMART_SETTINGS[0];
    onChange([...list, { path: next.path, value: defaultValue(next.path) }]);
  };
  return (
    <div className="gAssigns">
      {list.map((a, i) => {
        const info = settingInfo(a.path);
        return (
          <div key={`${a.path}-${i}`} className="gAssign">
            <select
              value={a.path}
              disabled={readOnly}
              onChange={(e) => set(i, { path: e.target.value as SmartSettingPath, value: defaultValue(e.target.value as SmartSettingPath) })}
            >
              {SMART_SETTINGS.map((s) => (
                <option key={s.path} value={s.path}>
                  {s.label}
                </option>
              ))}
            </select>
            {info?.kind === 'number' && (
              <input type="number" min={info.min} max={info.max} disabled={readOnly} value={Number(a.value)} onChange={(e) => set(i, { ...a, value: Number(e.target.value) })} />
            )}
            {info?.kind === 'boolean' && (
              <select value={a.value ? 'yes' : 'no'} disabled={readOnly} onChange={(e) => set(i, { ...a, value: e.target.value === 'yes' })}>
                <option value="yes">yes</option>
                <option value="no">no</option>
              </select>
            )}
            {info?.kind === 'select' && (
              <select value={String(a.value)} disabled={readOnly} onChange={(e) => set(i, { ...a, value: e.target.value })}>
                {(info.options ?? []).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            )}
            {info?.kind === 'text' && (
              <input type="text" className="mono" disabled={readOnly} value={String(a.value ?? '')} onChange={(e) => set(i, { ...a, value: e.target.value })} />
            )}
            {info?.kind === 'languages' && (
              <input
                type="text"
                className="mono"
                disabled={readOnly}
                placeholder="eng jpn – empty keeps all"
                value={(Array.isArray(a.value) ? a.value : []).join(' ')}
                onChange={(e) => set(i, { ...a, value: e.target.value.split(/[\s,]+/).filter(Boolean) })}
              />
            )}
            <button className="gIcon danger" disabled={readOnly} onClick={() => onChange(list.filter((_, j) => j !== i))} title="Remove this setting">
              <Icon.Trash />
            </button>
          </div>
        );
      })}
      {!list.length && <div className="gHelp">Nothing yet – this changes no settings.</div>}
      <button className="btn xs" disabled={readOnly} onClick={add}>
        <Icon.Plus /> Setting
      </button>
    </div>
  );
}

function defaultValue(path: SmartSettingPath): string | number | boolean | string[] {
  const info = settingInfo(path);
  if (info?.kind === 'boolean') return true;
  if (info?.kind === 'number') return path === 'video.quality' ? 20 : 0;
  if (info?.kind === 'languages') return [];
  if (info?.kind === 'text') return '';
  return info?.options?.[0]?.value ?? '';
}

/** What the result node lists, in the order someone reads a profile. */
const RESULT_ROWS: { path: SmartSettingPath; show: (p: Profile) => string }[] = [
  { path: 'container', show: (p) => p.container.toUpperCase() },
  { path: 'video.encoder', show: (p) => VIDEO_ENCODER_INFO[p.video.encoder]?.label.split(' (')[0] ?? p.video.encoder },
  { path: 'video.quality', show: (p) => (p.video.encoder === 'copy' ? '—' : String(p.video.quality)) },
  { path: 'video.tune', show: (p) => p.video.tune },
  { path: 'video.maxHeight', show: (p) => (p.video.maxHeight ? `${p.video.maxHeight}p` : 'source') },
  { path: 'audio.encoder', show: (p) => AUDIO_ENCODER_INFO[p.audio.encoder]?.label.split(' (')[0] ?? p.audio.encoder },
  { path: 'audio.channels', show: (p) => (p.audio.channels ? `${p.audio.channels}ch` : 'source layout') },
  { path: 'subtitles.mode', show: (p) => p.subtitles.mode },
];
