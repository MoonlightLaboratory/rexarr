import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Profile, SmartCondition, SmartOutcome, SmartProfile, SmartRule } from '@shared/types';
import { decide, fieldInfo, operatorsFor, OPERATOR_LABELS, ruleMatches, SAMPLE_SOURCES, SMART_FIELDS } from '@shared/smart';
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
  kind: 'start' | 'branch' | 'all' | 'compare' | 'read' | 'outcome';
  pos: Pos;
  ruleIndex?: number;
  condIndex?: number;
}

/** A wire between two ports. */
interface Wire {
  from: string;
  to: string;
  kind: 'flow' | 'data';
  dim?: boolean;
}

const condNodeId = (ruleId: string, i: number, kind: 'compare' | 'read') => `${kind}:${ruleId}:${i}`;

/** Where nodes go when nothing has been dragged: the chain down the left, what each branch does to its right. */
function autoLayout(sp: SmartProfile): Record<string, Pos> {
  const out: Record<string, Pos> = { start: { x: 30, y: 180 } };
  let y = 180;
  sp.rules.forEach((rule, i) => {
    const branchId = `rule:${rule.id}`;
    out[branchId] = { x: 250, y };
    out[`out:${rule.id}`] = { x: 560, y: y - 70 };
    const many = rule.when.length > 1;
    if (many) out[`all:${rule.id}`] = { x: 250, y: y + 180 };
    const base = many ? y + 330 : y + 190;
    let anyCompare = false;
    rule.when.forEach((c, ci) => {
      const kind = fieldInfo(c.field)?.kind === 'boolean' ? 'read' : 'compare';
      out[condNodeId(rule.id, ci, kind)] = { x: 210 + ci * 300, y: base };
      // a comparison reads its A side from a node below it, which is what makes a branch's stack tall
      if (kind === 'compare') {
        out[`read:${rule.id}:${ci}`] = { x: 210 + ci * 300, y: base + 200 };
        anyCompare = true;
      }
    });
    y = base + (anyCompare ? 200 + 180 : 180) + 70;
  });
  out['else'] = { x: 560, y };
  return out;
}

function Port({ id, side, tone, label }: { id: string; side: 'left' | 'right' | 'top' | 'bottom'; tone?: 'flow' | 'data' | 'value'; label?: string }) {
  return (
    <span className={`gPort ${side} ${tone ?? 'flow'}`} data-port={id}>
      {label && <span className="gPortLabel">{label}</span>}
    </span>
  );
}

export function SmartGraphPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const { profiles, smartProfiles, reloadSmartProfiles, toast } = useApp();
  const [sp, setSp] = useState<SmartProfile | null>(null);
  const [sample, setSample] = useState(0);
  const [showTry, setShowTry] = useState(true);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState({ x: 0, y: 0, z: 1 });
  const [ports, setPorts] = useState<Record<string, Pos>>({});
  const surface = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const drag = useRef<{ node?: string; startPos: Pos; origin: Pos; panning?: boolean } | null>(null);

  useEffect(() => {
    if (sp) return;
    if (id === 'new') {
      setSp({
        id: '', name: '', description: '', builtin: false, mediaType: 'any',
        rules: [{ id: 'r1', when: [{ field: 'audio.objectBased', op: 'isTrue' }], then: { kind: 'keep' } }],
        otherwise: { kind: 'profile', profileId: 'builtin-remux-flac' },
        createdAt: '', updatedAt: '',
      });
      return;
    }
    const found = smartProfiles.find((x) => x.id === id);
    if (found) setSp(structuredClone(found));
  }, [id, smartProfiles, sp]);

  const readOnly = Boolean(sp?.builtin);
  const profileName = useCallback((pid: string) => profiles.find((p) => p.id === pid)?.name, [profiles]);
  const facts = SAMPLE_SOURCES[sample].facts;
  const decision = useMemo(() => (sp ? decide(sp, facts) : null), [sp, facts]);

  // ---- the nodes and wires this profile draws as -------------------------------------------------
  const { nodes, wires } = useMemo(() => {
    if (!sp) return { nodes: [] as Node[], wires: [] as Wire[] };
    const auto = autoLayout(sp);
    const at = (nid: string): Pos => sp.layout?.[nid] ?? auto[nid] ?? { x: 0, y: 0 };
    const nodes: Node[] = [{ id: 'start', kind: 'start', pos: at('start') }];
    const wires: Wire[] = [];
    sp.rules.forEach((rule, i) => {
      const branchId = `rule:${rule.id}`;
      nodes.push({ id: branchId, kind: 'branch', pos: at(branchId), ruleIndex: i });
      // what happens when this branch says yes
      nodes.push({ id: `out:${rule.id}`, kind: 'outcome', pos: at(`out:${rule.id}`), ruleIndex: i });
      wires.push({ from: `${branchId}:yes`, to: `out:${rule.id}:in`, kind: 'flow' });
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
      // the chain: a No falls through to the next question
      const next = sp.rules[i + 1];
      wires.push({ from: `${branchId}:no`, to: next ? `rule:${next.id}:in` : 'else:in', kind: 'flow' });
    });
    nodes.push({ id: 'else', kind: 'outcome', pos: at('else') });
    const first = sp.rules[0];
    wires.push({ from: 'start:out', to: first ? `rule:${first.id}:in` : 'else:in', kind: 'flow' });
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
  }, [nodes, view.z, sp]);

  // ---- dragging a node, panning the canvas --------------------------------------------------------
  const onNodeDown = (e: React.MouseEvent, nodeId: string, pos: Pos) => {
    if (readOnly) return;
    e.stopPropagation();
    drag.current = { node: nodeId, startPos: pos, origin: { x: e.clientX, y: e.clientY } };
  };
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
    drag.current = { panning: true, startPos: { x: view.x, y: view.y }, origin: { x: e.clientX, y: e.clientY } };
  };
  const onWheel = (e: React.WheelEvent) => {
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
    const rect = surface.current?.getBoundingClientRect();
    if (!rect || !nodes.length) return;
    const xs = nodes.map((n) => n.pos.x);
    const ys = nodes.map((n) => n.pos.y);
    const w = Math.max(...xs) + 300 - Math.min(...xs);
    const h = Math.max(...ys) + 220 - Math.min(...ys);
    // never shrink past readable; panning is there for the rest
    const z = Math.max(0.65, Math.min(1, Math.min((rect.width - 60) / w, (rect.height - 60) / h)));
    setView({ z, x: 30 - Math.min(...xs) * z, y: 30 - Math.min(...ys) * z });
  }, [nodes]);
  useEffect(() => {
    if (sp && nodes.length) fit();
    // only when the profile first loads
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sp?.id]);

  // ---- editing ------------------------------------------------------------------------------------
  const setRule = (i: number, rule: SmartRule) => setSp((x) => (x ? { ...x, rules: x.rules.map((r, j) => (j === i ? rule : r)) } : x));
  const setCond = (ri: number, ci: number, c: SmartCondition) => sp && setRule(ri, { ...sp.rules[ri], when: sp.rules[ri].when.map((x, j) => (j === ci ? c : x)) });
  const addRule = () =>
    setSp((x) =>
      x ? { ...x, rules: [...x.rules, { id: Math.random().toString(36).slice(2, 10), when: [{ field: 'audio.maxChannels', op: 'atMost', number: 2 }], then: { kind: 'keep' } }] } : x,
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
      if (sp.id) await api.updateSmartProfile(sp.id, sp);
      else {
        const created = await api.createSmartProfile(sp);
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

  const wire = (w: Wire) => {
    const a = ports[w.from];
    const b = ports[w.to];
    if (!a || !b) return null;
    const vertical = Math.abs(b.y - a.y) > Math.abs(b.x - a.x) && w.kind === 'data';
    const d = vertical
      ? `M ${a.x} ${a.y} C ${a.x} ${(a.y + b.y) / 2}, ${b.x} ${(a.y + b.y) / 2}, ${b.x} ${b.y}`
      : `M ${a.x} ${a.y} C ${a.x + Math.max(40, (b.x - a.x) / 2)} ${a.y}, ${b.x - Math.max(40, (b.x - a.x) / 2)} ${b.y}, ${b.x} ${b.y}`;
    return <path key={`${w.from}->${w.to}`} d={d} className={`gWire ${w.kind}${w.dim ? ' dim' : ''}`} />;
  };

  return (
    <div className="graphPage">
      <div className="graphBar">
        <button className="btn sm" onClick={() => nav('/profiles')} title="Back to profiles">
          <Icon.ArrowLeftCircle /> Profiles
        </button>
        <input className="graphName" value={sp.name} readOnly={readOnly} placeholder="Name this smart profile" onChange={(e) => setSp({ ...sp, name: e.target.value })} />
        {readOnly && <span className="badge muted">Built-in · read-only</span>}
        <span className="spacer" />
        <button className="btn sm" onClick={fit} title="Fit the whole graph">
          <Icon.Search /> Fit
        </button>
        <button className="btn sm" onClick={() => setSp({ ...sp, layout: {} })} disabled={readOnly} title="Put every node back where it started">
          Tidy up
        </button>
        <button className="btn sm" onClick={addRule} disabled={readOnly}>
          <Icon.Plus /> Branch
        </button>
        <button className="btn sm primary" onClick={save} disabled={busy || readOnly || !sp.name.trim()}>
          {busy ? <span className="spinner" /> : <Icon.Check />} Save
        </button>
      </div>

      <div className="graphSurface" ref={surface} onMouseDown={onSurfaceDown} onWheel={onWheel} style={{ backgroundSize: `${22 * view.z}px ${22 * view.z}px`, backgroundPosition: `${view.x}px ${view.y}px` }}>
        <div className="graphLayer" ref={layer} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}>
          <svg className="graphWires">{wires.map(wire)}</svg>

          {nodes.map((n) => {
            const rule = n.ruleIndex !== undefined ? sp.rules[n.ruleIndex] : undefined;
            const chosen = decision && ((n.kind === 'branch' && decision.ruleIndex === n.ruleIndex) || (n.id === 'else' && decision.ruleIndex === -1) || (n.kind === 'outcome' && rule && decision.ruleIndex === n.ruleIndex));
            const live = rule ? ruleMatches(rule, facts) : false;
            return (
              <div key={n.id} className={`gNode ${n.kind}${chosen ? ' chosen' : ''}`} style={{ left: n.pos.x, top: n.pos.y }}>
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
                      <span>Branch</span>
                      <span className="spacer" />
                      {live && <span className="gTag">true</span>}
                      <button className="gIcon" disabled={readOnly || n.ruleIndex === 0} onClick={() => moveRule(n.ruleIndex!, -1)} title="Ask this one earlier">↑</button>
                      <button className="gIcon" disabled={readOnly || n.ruleIndex === sp.rules.length - 1} onClick={() => moveRule(n.ruleIndex!, 1)} title="Ask this one later">↓</button>
                      <button className="gIcon danger" disabled={readOnly} onClick={() => removeRule(n.ruleIndex!)} title="Remove this branch">
                        <Icon.Trash />
                      </button>
                    </div>
                    <div className="gBranchRows">
                      <div className="gRow">
                        Yes
                        <Port id={`rule:${rule.id}:yes`} side="right" />
                      </div>
                      <div className="gRow">
                        No
                        <Port id={`rule:${rule.id}:no`} side="right" />
                      </div>
                    </div>
                    <Port id={`rule:${rule.id}:in`} side="left" />
                    <Port id={`rule:${rule.id}:cond`} side="bottom" tone="data" label="Condition" />
                  </>
                )}

                {/* ---- every condition has to hold ---- */}
                {n.kind === 'all' && rule && (
                  <>
                    <div className="gHead" onMouseDown={(e) => onNodeDown(e, n.id, n.pos)}>
                      <span>All of</span>
                    </div>
                    <div className="gBody small dim">Every one has to hold</div>
                    <Port id={`all:${rule.id}:out`} side="top" tone="data" label="Output" />
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
                    <Port id={`${n.id}:out`} side="top" tone="data" label="Output" />
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
                    <Port id={`${n.id}:out`} side="top" tone="data" label="Output" />
                  </>
                )}

                {/* ---- what happens ---- */}
                {n.kind === 'outcome' && (
                  <>
                    <div className="gHead" onMouseDown={(e) => onNodeDown(e, n.id, n.pos)}>
                      <span>{n.id === 'else' ? 'Anything else' : 'Then'}</span>
                      <span className="spacer" />
                      {chosen && <span className="gTag on">this one</span>}
                    </div>
                    <div className="gBody">
                      <OutcomeSelect
                        value={n.id === 'else' ? sp.otherwise : rule!.then}
                        profiles={profiles}
                        disabled={readOnly}
                        onChange={(o) => (n.id === 'else' ? setSp({ ...sp, otherwise: o }) : setRule(n.ruleIndex!, { ...rule!, then: o }))}
                      />
                    </div>
                    <Port id={`${n.id}:in`} side="left" />
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
            <div className="small">
              → <strong>{decision.outcome.kind === 'keep' ? 'left as it is' : (profileName(decision.outcome.profileId) ?? decision.outcome.profileId)}</strong>
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

function OutcomeSelect({ value, profiles, disabled, onChange }: { value: SmartOutcome; profiles: Profile[]; disabled?: boolean; onChange: (o: SmartOutcome) => void }) {
  return (
    <select
      value={value.kind === 'keep' ? 'keep' : value.profileId}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value === 'keep' ? { kind: 'keep' } : { kind: 'profile', profileId: e.target.value })}
    >
      <option value="keep">Leave the file as it is</option>
      <optgroup label="Encode with">
        {profiles
          .filter((p) => p.mediaType !== 'music')
          .map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
      </optgroup>
    </select>
  );
}
