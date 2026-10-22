import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Profile, SmartAssignment, SmartCondition, SmartProfile, SmartRule, SmartSettingPath } from '@shared/types';
import { baseProfile, describeCondition, isPassThrough, fieldInfo, operatorsFor, OPERATOR_LABELS, settingInfo, SMART_FIELDS, SMART_SETTINGS } from '@shared/smart';
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

const newId = () => Math.random().toString(36).slice(2, 10);

type Pos = { x: number; y: number };
const GRID = 10;
const snap = (n: number) => Math.round(n / GRID) * GRID;

/** The same switch the Settings pages use, remembered in the same place. */
const ADVANCED_KEY = 'rexarr.showAdvanced';
const readAdvanced = () => {
  try {
    return localStorage.getItem(ADVANCED_KEY) === '1';
  } catch {
    return false;
  }
};

/** Every entry, under its heading. Nothing is hidden: a long list is easier to read grouped than shortened. */
function OptionList<T extends { group: string; label: string }>({ all, valueOf }: { all: T[]; valueOf: (t: T) => string }) {
  const groups = [...new Set(all.map((o) => o.group))];
  return (
    <>
      {groups.map((g) => (
        <optgroup key={g} label={g}>
          {all
            .filter((o) => o.group === g)
            .map((o) => (
              <option key={valueOf(o)} value={valueOf(o)}>
                {o.label}
              </option>
            ))}
        </optgroup>
      ))}
    </>
  );
}

/** Every node on the canvas, with the id its position is stored under. */
interface Node {
  id: string;
  kind: 'start' | 'base' | 'branch' | 'all' | 'compare' | 'read' | 'set' | 'result';
  pos: Pos;
  ruleIndex?: number;
  condIndex?: number;
  /** Index into sp.loose, for a condition with no cable to a branch. */
  looseIndex?: number;
}

/** A wire between two ports. */
interface Wire {
  from: string;
  to: string;
  kind: 'flow' | 'data';
}

const condNodeId = (ruleId: string, i: number, kind: 'compare' | 'read') => `${kind}:${ruleId}:${i}`;

/** Where nodes go when nothing has been dragged: the chain down the left, what each branch does to its right. */
function autoLayout(sp: SmartProfile): Record<string, Pos> {
  const out: Record<string, Pos> = { start: { x: 20, y: 170 }, base: { x: 170, y: 130 } };
  let y = 140;
  sp.rules.forEach((rule, i) => {
    const branchId = `rule:${rule.id}`;
    out[branchId] = { x: 500, y };
    out[`set:${rule.id}`] = { x: 760, y: y - 20 };
    const many = rule.when.length > 1;
    if (many) out[`all:${rule.id}`] = { x: 500, y: y + 185 };
    const base = many ? y + 305 : y + 195;
    let anyCompare = false;
    rule.when.forEach((c, ci) => {
      const kind = fieldInfo(c.field)?.kind === 'boolean' ? 'read' : 'compare';
      out[condNodeId(rule.id, ci, kind)] = { x: 510 + ci * 290, y: base };
      if (kind === 'compare') {
        out[`read:${rule.id}:${ci}`] = { x: 510 + ci * 290, y: base + 185 };
        anyCompare = true;
      }
    });
    y = base + (anyCompare ? 185 + 150 : 150) + 50;
  });
  out['result'] = { x: 760, y };
  return out;
}

function Port({ id, side, tone, label, onClick, live }: { id: string; side: 'left' | 'right' | 'top' | 'bottom'; tone?: 'flow' | 'data' | 'value'; label?: string; /** Set while cables can be run, which makes the port a target. */ onClick?: () => void; live?: boolean }) {
  return (
    <span
      className={`gPort ${side} ${tone ?? 'flow'}${onClick ? ' plug' : ''}${live ? ' live' : ''}`}
      data-port={id}
      onMouseDown={onClick ? (e) => (e.stopPropagation(), e.preventDefault(), onClick()) : undefined}
      title={onClick ? 'Click to run a cable here' : undefined}
    >
      {label && <span className="gPortLabel">{label}</span>}
    </span>
  );
}

function BranchRow({ id, label }: { id: string; label: string }) {
  return (
    <div className="gRow">
      {label}
      <Port id={id} side="right" />
    </div>
  );
}

/**
 * Undo and redo over the whole profile. Every change is a new profile object, so a step is just the JSON of what
 * it was before. Changes that arrive in a stream – dragging a node, typing a name – settle for a moment first, so
 * a drag is one step rather than forty.
 */
function useHistory(value: SmartProfile | null, restore: (v: SmartProfile) => void, settle = 400) {
  const past = useRef<string[]>([]);
  const future = useRef<string[]>([]);
  const committed = useRef<string>('');
  /** Where the current burst of changes started, which is what an undo goes back to. */
  const base = useRef<string>('');
  const restoring = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [, bump] = useState(0);

  useEffect(() => {
    if (!value) return;
    const now = JSON.stringify(value);
    if (now === committed.current) return;
    if (restoring.current) {
      restoring.current = false;
      committed.current = now;
      bump((n) => n + 1);
      return;
    }
    // a burst of changes is one step, and the step goes back to where the burst started – not to the state one
    // mouse-move before it ended
    if (!timer.current) base.current = committed.current;
    else clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      if (base.current && base.current !== now) {
        past.current.push(base.current);
        if (past.current.length > 100) past.current.shift();
        future.current = [];
      }
      committed.current = now;
      bump((n) => n + 1);
    }, settle);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [value, settle]);

  /** Opening a profile is where undo stops, not a step of its own. */
  const reset = (v: SmartProfile) => {
    past.current = [];
    future.current = [];
    committed.current = JSON.stringify(v);
  };

  const step = (from: string[], to: string[]) => {
    const text = from.pop();
    if (!text) return;
    to.push(committed.current);
    committed.current = text;
    restoring.current = true;
    restore(JSON.parse(text) as SmartProfile);
    bump((n) => n + 1);
  };

  return {
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
    undo: () => step(past.current, future.current),
    redo: () => step(future.current, past.current),
    reset,
  };
}

export function SmartGraphPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const { profiles, smartProfiles, reloadSmartProfiles, toast } = useApp();
  const [sp, setSp] = useState<SmartProfile | null>(null);
  const [details, setDetails] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [advanced, setAdvanced] = useState(readAdvanced);
  /** The loose condition waiting for its other end, while a cable is being run. */
  const [plugging, setPlugging] = useState<number | null>(null);
  const [palette, setPalette] = useState(false);
  const menu = useRef<HTMLDivElement | null>(null);
  const history = useHistory(sp, (v) => setSp(v));
  const [marquee, setMarquee] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState({ x: 0, y: 0, z: 1 });
  const [ports, setPorts] = useState<Record<string, Pos>>({});
  const surface = useRef<HTMLDivElement>(null);
  // the ref alone cannot drive an effect: the surface is not in the tree until the profile has loaded, so an
  // effect keyed on mount found nothing and never looked again
  const [surfaceEl, setSurfaceEl] = useState<HTMLDivElement | null>(null);
  const layer = useRef<HTMLDivElement>(null);
  const drag = useRef<{ node?: string; startPos: Pos; origin: Pos; panning?: boolean; group?: Record<string, Pos>; marquee?: Pos } | null>(null);
  const nodeSizes = useRef<Record<string, { w: number; h: number }>>({});
  /** The marquee as a normalised box, kept in a ref so the mouseup handler sees the latest one. */
  const marqueeBox = useRef<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
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
      history.reset(blank);
      return;
    }
    const found = smartProfiles.find((x) => x.id === id);
    if (found) {
      const copy = structuredClone(found);
      setSp(copy);
      setSaved(JSON.stringify(found));
      history.reset(copy);
    }
  }, [id, smartProfiles, sp]);

  const readOnly = Boolean(sp?.builtin);
  // the settings before any branch, which is what the end of the chain shows
  const baseline = useMemo(() => (sp ? baseProfile(sp) : null), [sp]);
  // layout moves count as changes too: where a node sits is part of the profile
  const dirty = Boolean(sp) && JSON.stringify(sp) !== saved;
  const leave = () => {
    if (dirty && !readOnly && !confirm('Leave without saving? The changes to this smart profile will be lost.')) return;
    nav('/profiles');
  };

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
      wires.push({ from: `${branchId}:then`, to: `set:${rule.id}:in`, kind: 'flow' });
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
    // conditions with no cable: they hang about on the canvas until one is run to a branch
    (sp.loose ?? []).forEach((l, i) => {
      const kind = fieldInfo(l.when.field)?.kind === 'boolean' ? 'read' : 'compare';
      const nid = `loose:${l.id}`;
      const spot = sp.layout?.[nid] ?? { x: 60 + i * 290, y: 620 };
      nodes.push({ id: nid, kind, pos: spot, looseIndex: i });
      // a comparison reads its left-hand side off the file, so it brings its own reader along
      if (kind === 'compare') {
        const rid = `looseread:${l.id}`;
        nodes.push({ id: rid, kind: 'read', pos: sp.layout?.[rid] ?? { x: spot.x, y: spot.y + 185 }, looseIndex: i });
        wires.push({ from: `${rid}:out`, to: `${nid}:a`, kind: 'data' });
      }
    });
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
  /** A mouse position in canvas coordinates, which is what node positions are in. */
  const pointIn = (e: { clientX: number; clientY: number }): Pos | null => {
    const base = layer.current?.getBoundingClientRect();
    if (!base) return null;
    return { x: (e.clientX - base.left) / view.z, y: (e.clientY - base.top) / view.z };
  };

  /** Where every node sits right now, so a group drag can move them all from where they started. */
  const positionsOf = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, nodes.find((n) => n.id === id)?.pos ?? { x: 0, y: 0 }]));

  const onNodeDown = (e: React.MouseEvent, nodeId: string, pos: Pos) => {
    // shift + click on a node adds it to the selection, or takes it out again
    if (e.button === 0 && e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      setSelected((list) => (list.includes(nodeId) ? list.filter((id) => id !== nodeId) : [...list, nodeId]));
      return;
    }
    if (e.button !== 0 || readOnly) return;
    e.stopPropagation();
    // dragging one of a selection takes the whole selection along; dragging anything else drops it
    const group = selected.includes(nodeId) ? selected : [];
    if (!group.length && selected.length) setSelected([]);
    drag.current = { node: nodeId, startPos: pos, origin: { x: e.clientX, y: e.clientY }, group: group.length > 1 ? positionsOf(group) : undefined };
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !readOnly) {
        e.preventDefault();
        if (e.shiftKey) history.redo();
        else history.undo();
        return;
      }
      if (e.key !== 'Escape') return;
      setDetails(false);
      setSelected([]);
      setPalette(false);
      setPlugging(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [history, readOnly]);

  // The node menu hangs off its button, and the button moves as the bar wraps, so it is nudged back inside.
  useLayoutEffect(() => {
    const el = menu.current;
    if (!el) return;
    el.style.transform = '';
    const r = el.getBoundingClientRect();
    const over = r.right > window.innerWidth - 8 ? window.innerWidth - 8 - r.right : r.left < 8 ? 8 - r.left : 0;
    if (over) el.style.transform = `translateX(${Math.round(over)}px)`;
  }, [palette]);
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = (e.clientX - d.origin.x) / view.z;
      const dy = (e.clientY - d.origin.y) / view.z;
      if (d.panning) setView((v) => ({ ...v, x: d.startPos.x + dx * v.z, y: d.startPos.y + dy * v.z }));
      else if (d.marquee) {
        const at = pointIn(e);
        if (at) {
          const box = { x1: Math.min(d.marquee.x, at.x), y1: Math.min(d.marquee.y, at.y), x2: Math.max(d.marquee.x, at.x), y2: Math.max(d.marquee.y, at.y) };
          marqueeBox.current = box;
          setMarquee(box);
        }
      } else if (d.group) {
        // every node of the selection moves by the same amount, from where it was when the drag started
        setSp((x) => (x ? { ...x, layout: { ...x.layout, ...Object.fromEntries(Object.entries(d.group!).map(([id, p]) => [id, { x: snap(p.x + dx), y: snap(p.y + dy) }])) } } : x));
      } else if (d.node) setSp((x) => (x ? { ...x, layout: { ...x.layout, [d.node!]: { x: snap(d.startPos.x + dx), y: snap(d.startPos.y + dy) } } } : x));
    };
    const up = () => {
      // a marquee picks up everything it touched
      if (drag.current?.marquee && marqueeBox.current) {
        const box = marqueeBox.current;
        const hit = nodes.filter((n) => {
          const size = nodeSizes.current[n.id] ?? { w: 260, h: 150 };
          return n.pos.x < box.x2 && n.pos.x + size.w > box.x1 && n.pos.y < box.y2 && n.pos.y + size.h > box.y1;
        });
        setSelected(hit.map((n) => n.id));
      }
      drag.current = null;
      setMarquee(null);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [view.z, nodes]);

  const onSurfaceDown = (e: React.MouseEvent) => {
    // shift + drag draws a box over the canvas and takes everything it touches; without shift it pans
    if (e.button === 0 && e.shiftKey) {
      const at = pointIn(e);
      if (!at) return;
      e.preventDefault();
      marqueeBox.current = { x1: at.x, y1: at.y, x2: at.x, y2: at.y };
      setMarquee(marqueeBox.current);
      drag.current = { marquee: at, startPos: at, origin: { x: e.clientX, y: e.clientY } };
      return;
    }
    if (e.button !== 0) return;
    touched.current = true;
    setSelected([]);
    setPlugging(null);
    setPalette(false);
    drag.current = { panning: true, startPos: { x: view.x, y: view.y }, origin: { x: e.clientX, y: e.clientY } };
  };
  /** Zoom about the middle of the canvas, so the graph does not walk off the corner as it grows. */
  const zoomBy = (by: number) => {
    touched.current = true;
    const rect = surface.current?.getBoundingClientRect();
    const mx = (rect?.width ?? 0) / 2;
    const my = (rect?.height ?? 0) / 2;
    setView((v) => {
      const z = Math.min(2, Math.max(0.3, v.z * by));
      return { z, x: mx - ((mx - v.x) / v.z) * z, y: my - ((my - v.y) / v.z) * z };
    });
  };

  /**
   * The wheel, as a trackpad actually uses it.
   *
   * Every wheel event used to zoom by a fixed step, which a mouse survives and a trackpad does not: two fingers
   * on a trackpad are a scroll, so panning the canvas zoomed it instead, and a pinch arrives as a burst of small
   * events that each zoomed a full step - the canvas shot in and out. A pinch is a wheel event with ctrlKey set,
   * which is the only thing that separates the two, so that zooms and everything else pans.
   *
   * The listener is attached by hand because React's onWheel is passive: preventDefault does nothing there, and
   * without it a pinch zooms the whole page behind the canvas as well.
   */
  useEffect(() => {
    const el = surfaceEl;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      touched.current = true;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        setView((v) => {
          // scaled by how far the pinch moved, so a trackpad is smooth and a mouse notch still steps
          const z = Math.min(2, Math.max(0.3, v.z * Math.exp(-e.deltaY / 240)));
          // keep the point under the cursor still
          return { z, x: mx - ((mx - v.x) / v.z) * z, y: my - ((my - v.y) / v.z) * z };
        });
        return;
      }
      e.preventDefault();
      setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [surfaceEl]);

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
    const usable = rect.width - 80;
    const z = Math.max(0.6, Math.min(1, Math.min(usable / w, (rect.height - 80) / h)));
    setView({ z, x: Math.max(30, (usable - w * z) / 2) - minX * z, y: Math.max(30, (rect.height - h * z) / 2) - minY * z });
  }, [nodes]);
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
      x ? { ...x, rules: [...x.rules, { id: newId(), when: [{ field: 'audio.maxChannels', op: 'atMost', number: 2 }], set: [{ path: 'audio.encoder', value: 'flac' }] }] } : x,
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

  /** Take the cable off a branch: the condition stays on the canvas, where it was, doing nothing. */
  const unplug = (ruleIndex: number, condIndex: number, nodeId: string) => {
    if (!sp) return;
    const rule = sp.rules[ruleIndex];
    const when = rule.when[condIndex];
    const id = newId();
    const reader = nodes.find((n) => n.id === `read:${rule.id}:${condIndex}`);
    setSp({
      ...sp,
      rules: sp.rules.map((r, i) => (i === ruleIndex ? { ...r, when: r.when.filter((_, j) => j !== condIndex) } : r)),
      loose: [...(sp.loose ?? []), { id, when }],
      // it keeps the place it already had on the canvas, reader and all
      layout: {
        ...sp.layout,
        [`loose:${id}`]: nodes.find((n) => n.id === nodeId)?.pos ?? { x: 60, y: 620 },
        ...(reader ? { [`looseread:${id}`]: reader.pos } : {}),
      },
    });
    setPlugging(null);
  };

  /** Run the waiting cable into a branch: the condition becomes one of that branch's questions. */
  const plugInto = (ruleIndex: number) => {
    if (!sp || plugging === null) return;
    const entry = (sp.loose ?? [])[plugging];
    if (!entry) return;
    const rule = sp.rules[ruleIndex];
    const ci = rule.when.length;
    const kind = fieldInfo(entry.when.field)?.kind === 'boolean' ? 'read' : 'compare';
    // the node lands where it was sitting, not back in the auto-layout, and its old places are forgotten
    const layout = { ...sp.layout };
    const spot = layout[`loose:${entry.id}`];
    const readerSpot = layout[`looseread:${entry.id}`];
    delete layout[`loose:${entry.id}`];
    delete layout[`looseread:${entry.id}`];
    if (spot) layout[condNodeId(rule.id, ci, kind)] = spot;
    if (readerSpot && kind === 'compare') layout[`read:${rule.id}:${ci}`] = readerSpot;
    setSp({
      ...sp,
      rules: sp.rules.map((r, i) => (i === ruleIndex ? { ...r, when: [...r.when, entry.when] } : r)),
      loose: (sp.loose ?? []).filter((_, i) => i !== plugging),
      layout,
    });
    setPlugging(null);
  };

  /** A node of your own, dropped where there is room for it. */
  const addNode = (kind: 'compare' | 'read' | 'branch') => {
    if (!sp) return;
    setPalette(false);
    if (kind === 'branch') return addRule();
    const id = newId();
    const when: SmartCondition = kind === 'read' ? { field: 'audio.objectBased', op: 'isTrue' } : { field: 'audio.maxChannels', op: 'atMost', number: 2 };
    const lowest = nodes.reduce((y, n) => Math.max(y, n.pos.y), 0);
    setSp({ ...sp, loose: [...(sp.loose ?? []), { id, when }], layout: { ...sp.layout, [`loose:${id}`]: { x: 60, y: lowest + 80 } } });
  };

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

  if (!sp || !baseline) return <div className="graphPage"><div className="empty">Loading…</div></div>;

  const wire = (w: Wire) => {
    const a = ports[w.from];
    const b = ports[w.to];
    if (!a || !b) return null;
    const vertical = Math.abs(b.y - a.y) > Math.abs(b.x - a.x) && w.kind === 'data';
    const d = vertical
      ? `M ${a.x} ${a.y} C ${a.x} ${(a.y + b.y) / 2}, ${b.x} ${(a.y + b.y) / 2}, ${b.x} ${b.y}`
      : `M ${a.x} ${a.y} C ${a.x + Math.max(40, (b.x - a.x) / 2)} ${a.y}, ${b.x - Math.max(40, (b.x - a.x) / 2)} ${b.y}, ${b.x} ${b.y}`;
    return <path key={`${w.from}->${w.to}`} d={d} className={`gWire ${w.kind}`} />;
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
        <div className="gZoom gHistory">
          <button className="gIcon" disabled={!history.canUndo || readOnly} onClick={history.undo} title="Undo (⌘Z)">
            <Icon.Undo />
          </button>
          <button className="gIcon" disabled={!history.canRedo || readOnly} onClick={history.redo} title="Redo (⇧⌘Z)">
            <Icon.Redo />
          </button>
        </div>
        <button
          className={`btn sm${advanced ? ' primary' : ''}`}
          title={advanced ? 'Hide the settings and conditions most branches do not need' : 'Offer every condition and every setting, not just the everyday ones'}
          onClick={() => {
            setAdvanced((a: boolean) => {
              try {
                localStorage.setItem(ADVANCED_KEY, a ? '0' : '1');
              } catch {
                /* private window */
              }
              return !a;
            });
          }}
        >
          Advanced
        </button>
        {readOnly && <span className="badge muted">Built-in · read-only</span>}
        {selected.length > 0 && (
          <button className="btn sm" onClick={() => setSelected([])} title="Drop the selection (Esc)">
            {selected.length} selected
          </button>
        )}
        {plugging !== null && (
          <button className="badge amber" onClick={() => setPlugging(null)} title="Put the cable down (Esc)">
            Cable in hand – click a branch’s condition port
          </button>
        )}
        {dirty && !readOnly && <span className="badge amber">Unsaved</span>}
        <span className="spacer" />
        <div className="gZoom">
          <button className="gIcon" onClick={() => zoomBy(1 / 1.15)} title="Zoom out">
            –
          </button>
          <button className="gIcon wide" onClick={fit} title="Fit the whole graph">
            {Math.round(view.z * 100)}%
          </button>
          <button className="gIcon" onClick={() => zoomBy(1.15)} title="Zoom in">
            +
          </button>
        </div>
        <button className="btn sm" onClick={() => setSp({ ...sp, layout: {} })} disabled={readOnly} title="Put every node back where it started">
          Tidy up
        </button>
        {advanced ? (
          <div className="gMenuWrap">
            <button className={`btn sm${palette ? ' primary' : ''}`} disabled={readOnly} onClick={() => setPalette((o) => !o)} title="Add a node to the canvas">
              <Icon.Plus /> Node
            </button>
            {palette && (
              <div className="gMenu" ref={menu} onMouseLeave={() => setPalette(false)}>
                <button onClick={() => addNode('branch')}>
                  <strong>Branch</strong>
                  <span>a question, with what it changes</span>
                </button>
                <button onClick={() => addNode('compare')}>
                  <strong>Comparison</strong>
                  <span>a number read off the file, measured against yours</span>
                </button>
                <button onClick={() => addNode('read')}>
                  <strong>Yes / no</strong>
                  <span>something the file either is or is not</span>
                </button>
              </div>
            )}
          </div>
        ) : (
          <button className="btn sm" onClick={addRule} disabled={readOnly}>
            <Icon.Plus /> Branch
          </button>
        )}
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

      <div className="graphSurface" ref={(el) => { surface.current = el; setSurfaceEl(el); }} onMouseDown={onSurfaceDown} style={{ backgroundSize: `${22 * view.z}px ${22 * view.z}px`, backgroundPosition: `${view.x}px ${view.y}px` }}>
        <div className="graphLayer" ref={layer} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}>
          <svg className="graphWires">{wires.map(wire)}</svg>

          {marquee && (
            <div className="gMarquee" style={{ left: marquee.x1, top: marquee.y1, width: marquee.x2 - marquee.x1, height: marquee.y2 - marquee.y1 }} />
          )}

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
            const cond = n.looseIndex !== undefined ? sp.loose?.[n.looseIndex]?.when : n.condIndex !== undefined ? rule?.when[n.condIndex] : undefined;
            const putCond = (c: SmartCondition): void => {
              if (n.looseIndex !== undefined) setSp({ ...sp, loose: (sp.loose ?? []).map((l, i) => (i === n.looseIndex ? { ...l, when: c } : l)) });
              else setCond(n.ruleIndex!, n.condIndex!, c);
            };
            const dropCond = (): void => {
              if (n.looseIndex === undefined) {
                setRule(n.ruleIndex!, { ...rule!, when: rule!.when.filter((_, j) => j !== n.condIndex) });
                return;
              }
              const gone = sp.loose![n.looseIndex].id;
              const layout = { ...sp.layout };
              delete layout[`loose:${gone}`];
              delete layout[`looseread:${gone}`];
              setSp({ ...sp, loose: sp.loose!.filter((_, i) => i !== n.looseIndex), layout });
              setPlugging(null);
            };
            const cable =
              advanced && cond ? (
                n.looseIndex === undefined ? (
                  <button className="gIcon" disabled={readOnly} onClick={() => unplug(n.ruleIndex!, n.condIndex!, n.id)} title="Take the cable off – the node stays, wired to nothing">
                    ⌁
                  </button>
                ) : (
                  <button className={`gIcon${plugging === n.looseIndex ? ' on' : ''}`} disabled={readOnly} onClick={() => setPlugging(plugging === n.looseIndex ? null : n.looseIndex!)} title="Run a cable from here to a branch">
                    ⌁
                  </button>
                )
              ) : null;
            return (
              <div
                key={n.id}
                data-node={n.id}
                className={`gNode ${n.kind}${rule?.enabled === false ? ' off' : ''}${selected.includes(n.id) ? ' selected' : ''}${n.looseIndex !== undefined ? ' loose' : ''}${plugging !== null && plugging === n.looseIndex ? ' plugging' : ''}`}
                style={{ left: n.pos.x, top: n.pos.y }}
                onMouseDown={(e) => e.button === 0 && e.shiftKey && onNodeDown(e, n.id, n.pos)}
              >
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
                      <BranchRow id={`rule:${rule.id}:then`} label="Then" />
                      <BranchRow id={`rule:${rule.id}:next`} label="Carry on" />
                    </div>
                    <Port id={`rule:${rule.id}:in`} side="left" />
                    <Port
                      id={`rule:${rule.id}:cond`}
                      side="bottom"
                      tone="data"
                      label={plugging !== null ? 'Plug in here' : 'Condition'}
                      onClick={plugging !== null && !readOnly ? () => plugInto(n.ruleIndex!) : undefined}
                      live={plugging !== null}
                    />
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
                {n.kind === 'compare' && cond && (
                  <>
                    <div className="gHead" onMouseDown={(e) => onNodeDown(e, n.id, n.pos)}>
                      <span>{fieldInfo(cond.field)?.kind === 'list' ? 'Is one of' : 'Comparison'}</span>
                      <span className="spacer" />
                      {cable}
                      <button className="gIcon danger" disabled={readOnly || (n.looseIndex === undefined && (rule?.when.length ?? 0) < 2)} onClick={dropCond} title="Remove this condition">
                        <Icon.Trash />
                      </button>
                    </div>
                    <div className="gBody">
                      {fieldInfo(cond.field)?.kind === 'number' && <label className="gLabel">Operation</label>}
                      <select value={cond.op} disabled={readOnly} onChange={(e) => putCond({ ...cond, op: e.target.value as SmartCondition['op'] })}>
                        {operatorsFor(fieldInfo(cond.field)?.kind ?? 'number').map((op) => (
                          <option key={op} value={op}>
                            {OPERATOR_LABELS[op]}
                          </option>
                        ))}
                      </select>
                      {fieldInfo(cond.field)?.kind === 'number' ? (
                        <div className="gB">
                          <span className="gLabel">B:</span>
                          <input type="number" min={0} disabled={readOnly} value={cond.number ?? 0} onChange={(e) => putCond({ ...cond, number: Number(e.target.value) })} />
                          <span className="gUnit">{fieldInfo(cond.field)?.unit}</span>
                        </div>
                      ) : (
                        <div className="chips">
                          {(fieldInfo(cond.field)?.options ?? []).map((o) => {
                            const on = (cond.list ?? []).includes(o.value);
                            return (
                              <span
                                key={o.value}
                                className={`chip${on ? ' on' : ''}`}
                                onClick={() => !readOnly && putCond({ ...cond, list: on ? (cond.list ?? []).filter((v) => v !== o.value) : [...(cond.list ?? []), o.value] })}
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
                {n.kind === 'read' && cond && (
                  <>
                    <div className="gHead" onMouseDown={(e) => onNodeDown(e, n.id, n.pos)}>
                      <span>Read from the file</span>
                      {fieldInfo(cond.field)?.kind === 'boolean' && (
                        <>
                          <span className="spacer" />
                          {cable}
                          <button className="gIcon danger" disabled={readOnly || (n.looseIndex === undefined && (rule?.when.length ?? 0) < 2)} onClick={dropCond} title="Remove this condition">
                            <Icon.Trash />
                          </button>
                        </>
                      )}
                    </div>
                    <div className="gBody">
                      <select
                        value={cond.field}
                        disabled={readOnly}
                        onChange={(e) => {
                          const next = fieldInfo(e.target.value as SmartCondition['field']);
                          putCond({ field: e.target.value as SmartCondition['field'], op: operatorsFor(next?.kind ?? 'number')[0], number: next?.kind === 'number' ? 2 : undefined, list: next?.kind === 'list' ? [] : undefined });
                        }}
                      >
                        <OptionList all={SMART_FIELDS} valueOf={(f) => f.field} />
                      </select>
                      {fieldInfo(cond.field)?.kind === 'boolean' && (
                        <select value={cond.op} disabled={readOnly} onChange={(e) => putCond({ ...cond, op: e.target.value as SmartCondition['op'] })}>
                          <option value="isTrue">yes</option>
                          <option value="isFalse">no</option>
                        </select>
                      )}
                      {fieldInfo(cond.field)?.help && (
                        <div className="gHelp" title={fieldInfo(cond.field)!.help}>
                          {fieldInfo(cond.field)!.help}
                        </div>
                      )}
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
                      <Assignments list={sp.base} readOnly={readOnly} advanced={advanced} onChange={(base) => setSp({ ...sp, base })} />
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
                      <span className="gSub">{rule.label || `branch ${n.ruleIndex! + 1}`}</span>
                    </div>
                    <div className="gBody">
                      <Assignments list={rule.set} readOnly={readOnly} advanced={advanced} onChange={(set) => setRule(n.ruleIndex!, { ...rule, set })} />
                    </div>
                    <Port id={`set:${rule.id}:in`} side="left" />
                  </>
                )}

                {/* ---- where the chain ends, before any branch has had a say ---- */}
                {n.kind === 'result' && (
                  <>
                    <div className="gHead" onMouseDown={(e) => onNodeDown(e, n.id, n.pos)}>
                      <span>If nothing matches</span>
                    </div>
                    <div className="gBody">
                      <div className="gResultRows">
                        {summarise(baseline).map(({ label, value }) => (
                          <div key={label} className="gResultRow">
                            <span className="gLabel">{label}</span>
                            <span className="spacer" />
                            <span className="gResultValue">{value}</span>
                          </div>
                        ))}
                      </div>
                      {isPassThrough(baseline) && <div className="gHelp">Every stream copied into the same container – such a file is left alone, with no encode queued.</div>}
                    </div>
                    <Port id="result:in" side="left" />
                  </>
                )}
              </div>
            );
          })}
        </div>

      </div>
    </div>
  );
}

/** The rows that make up a Start from or a Set node: a setting and the value it is given. */
function Assignments({ list, readOnly, advanced, onChange }: { list: SmartAssignment[]; readOnly?: boolean; advanced: boolean; onChange: (list: SmartAssignment[]) => void }) {
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
              <OptionList all={SMART_SETTINGS} valueOf={(x) => x.path} />
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

/** The encode in four lines, the way someone would say it out loud. */
function summarise(p: Profile): { label: string; value: string }[] {
  const v = p.video;
  const a = p.audio;
  const video =
    v.encoder === 'copy'
      ? 'copied, as it is'
      : [VIDEO_ENCODER_INFO[v.encoder]?.label.split(' (')[0] ?? v.encoder, `CRF ${v.quality}`, v.preset, v.tune !== 'none' ? `tune ${v.tune}` : '', v.maxHeight ? `≤${v.maxHeight}p` : '']
          .filter(Boolean)
          .join(' · ');
  const audio =
    a.encoder === 'copy'
      ? 'copied, as it is'
      : [AUDIO_ENCODER_INFO[a.encoder]?.label.split(' (')[0] ?? a.encoder, a.bitrate && !AUDIO_ENCODER_INFO[a.encoder]?.lossless ? `${a.bitrate}k` : '', a.channels ? `${a.channels}ch` : 'source layout']
          .filter(Boolean)
          .join(' · ');
  const subs = { copy: 'copied', 'copy-text': 'text only', burn: 'burned in', none: 'dropped' }[p.subtitles.mode] ?? p.subtitles.mode;
  return [
    { label: 'Video', value: video },
    { label: 'Audio', value: audio },
    { label: 'Subtitles', value: subs },
    { label: 'Container', value: p.container.toUpperCase() },
  ];
}
