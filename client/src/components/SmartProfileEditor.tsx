import { useMemo, useState } from 'react';
import type { Profile, SmartCondition, SmartOutcome, SmartProfile, SmartRule } from '@shared/types';
import { decide, describeCondition, fieldInfo, operatorsFor, OPERATOR_LABELS, ruleMatches, SAMPLE_SOURCES, SMART_FIELDS } from '@shared/smart';
import { Icon } from './Icons';
import { Modal } from './Modal';

const newId = () => Math.random().toString(36).slice(2, 10);

/** A condition that is valid the moment it is added, so a half-built node never silently matches nothing. */
function blankCondition(): SmartCondition {
  return { field: 'audio.maxChannels', op: 'atMost', number: 2 };
}

/** The target of a node: one of the real profiles, or leaving the file alone. */
function OutcomePicker({ value, profiles, onChange }: { value: SmartOutcome; profiles: Profile[]; onChange: (o: SmartOutcome) => void }) {
  const usable = profiles.filter((p) => p.mediaType !== 'music');
  return (
    <select
      value={value.kind === 'keep' ? 'keep' : value.profileId}
      onChange={(e) => onChange(e.target.value === 'keep' ? { kind: 'keep' } : { kind: 'profile', profileId: e.target.value })}
    >
      <option value="keep">Leave the file as it is (no encode)</option>
      <optgroup label="Encode with">
        {usable.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </optgroup>
    </select>
  );
}

function ConditionRow({ c, onChange, onRemove }: { c: SmartCondition; onChange: (c: SmartCondition) => void; onRemove: () => void }) {
  const info = fieldInfo(c.field);
  const kind = info?.kind ?? 'number';
  const ops = operatorsFor(kind);
  return (
    <div className="smartCond">
      <select
        value={c.field}
        onChange={(e) => {
          const next = fieldInfo(e.target.value as SmartCondition['field']);
          const op = operatorsFor(next?.kind ?? 'number')[0];
          onChange({ field: e.target.value as SmartCondition['field'], op, number: next?.kind === 'number' ? 2 : undefined, list: next?.kind === 'list' ? [] : undefined });
        }}
      >
        {SMART_FIELDS.map((f) => (
          <option key={f.field} value={f.field}>
            {f.label}
          </option>
        ))}
      </select>
      <select value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as SmartCondition['op'] })}>
        {ops.map((op) => (
          <option key={op} value={op}>
            {OPERATOR_LABELS[op]}
          </option>
        ))}
      </select>
      {kind === 'number' && (
        <input type="number" value={c.number ?? 0} min={0} onChange={(e) => onChange({ ...c, number: Number(e.target.value) })} />
      )}
      {kind === 'list' && (
        <div className="chips">
          {(info?.options ?? []).map((o) => {
            const on = (c.list ?? []).includes(o.value);
            return (
              <span key={o.value} className={`chip${on ? ' on' : ''}`} onClick={() => onChange({ ...c, list: on ? (c.list ?? []).filter((v) => v !== o.value) : [...(c.list ?? []), o.value] })}>
                {o.label}
              </span>
            );
          })}
        </div>
      )}
      <span className="spacer" />
      <button className="btn xs ghost" onClick={onRemove} title="Remove this condition">
        <Icon.Trash />
      </button>
      {info?.help && <div className="help smartHelp">{info.help}</div>}
    </div>
  );
}

export function SmartProfileEditor({ initial, profiles, onClose, onSaved }: { initial: SmartProfile; profiles: Profile[]; onClose: () => void; onSaved: (s: SmartProfile) => Promise<void> | void }) {
  const [sp, setSp] = useState<SmartProfile>(structuredClone(initial));
  const [sample, setSample] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const isNew = !initial.id;
  const profileName = (id: string) => profiles.find((p) => p.id === id)?.name;

  const facts = SAMPLE_SOURCES[sample].facts;
  const decision = useMemo(() => decide(sp, facts), [sp, facts]);
  const missing = useMemo(
    () => [...sp.rules.map((r) => r.then), sp.otherwise].filter((o) => o.kind === 'profile' && !profileName(o.profileId)),
    [sp, profiles],
  );

  const setRule = (i: number, rule: SmartRule) => setSp((x) => ({ ...x, rules: x.rules.map((r, j) => (j === i ? rule : r)) }));
  const addRule = () => setSp((x) => ({ ...x, rules: [...x.rules, { id: newId(), when: [blankCondition()], then: { kind: 'keep' } }] }));
  const removeRule = (i: number) => setSp((x) => ({ ...x, rules: x.rules.filter((_, j) => j !== i) }));
  const moveRule = (i: number, by: number) =>
    setSp((x) => {
      const rules = [...x.rules];
      const j = i + by;
      if (j < 0 || j >= rules.length) return x;
      [rules[i], rules[j]] = [rules[j], rules[i]];
      return { ...x, rules };
    });

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await onSaved(sp);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={isNew ? 'New smart profile' : sp.name}
      wide
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !sp.name.trim() || missing.length > 0} onClick={save}>
            {busy ? <span className="spinner" /> : <Icon.Check />} Save
          </button>
        </>
      }
    >
      <>
        <div className="grid-2">
          <div className="field stack">
            <label>Name</label>
            <input value={sp.name} onChange={(e) => setSp({ ...sp, name: e.target.value })} placeholder="Keep Atmos, FLAC the rest" />
          </div>
          <div className="field stack">
            <label>For</label>
            <select value={sp.mediaType} onChange={(e) => setSp({ ...sp, mediaType: e.target.value as SmartProfile['mediaType'] })}>
              <option value="any">Anything</option>
              <option value="movie">Movies</option>
              <option value="tv">TV</option>
              <option value="anime">Anime</option>
            </select>
          </div>
        </div>
        <div className="field stack">
          <label>Description</label>
          <input value={sp.description} onChange={(e) => setSp({ ...sp, description: e.target.value })} placeholder="What this decides, and why" />
        </div>

        <div className="subhead row">
          <span>Nodes</span>
          <span className="spacer" />
          <span className="small dim">Checked top to bottom; the first one that fits decides.</span>
        </div>

        <div className="smartFlow">
          {sp.rules.map((rule, i) => {
            const hit = ruleMatches(rule, facts);
            const chosen = decision.ruleIndex === i;
            return (
              <div key={rule.id} className={`smartNode${chosen ? ' chosen' : hit ? ' hit' : ''}`}>
                <div className="smartNode-h">
                  <span className="smartNode-n">{i + 1}</span>
                  <span className="muted small">If all of</span>
                  <span className="spacer" />
                  {chosen && <span className="badge green">this one</span>}
                  <button className="btn xs ghost" disabled={i === 0} onClick={() => moveRule(i, -1)} title="Move up">
                    ↑
                  </button>
                  <button className="btn xs ghost" disabled={i === sp.rules.length - 1} onClick={() => moveRule(i, 1)} title="Move down">
                    ↓
                  </button>
                  <button className="btn xs ghost" onClick={() => removeRule(i)} title="Remove this node">
                    <Icon.Trash />
                  </button>
                </div>
                <div className="smartNode-b">
                  {rule.when.map((c, ci) => (
                    <ConditionRow
                      key={ci}
                      c={c}
                      onChange={(next) => setRule(i, { ...rule, when: rule.when.map((x, j) => (j === ci ? next : x)) })}
                      onRemove={() => setRule(i, { ...rule, when: rule.when.filter((_, j) => j !== ci) })}
                    />
                  ))}
                  {rule.when.length === 0 && <div className="warn small">This node has no conditions, so it never matches.</div>}
                  <div className="inline">
                    <button className="btn xs" onClick={() => setRule(i, { ...rule, when: [...rule.when, blankCondition()] })}>
                      <Icon.Plus /> and
                    </button>
                    <span className="spacer" />
                    <span className="small muted">then</span>
                    <OutcomePicker value={rule.then} profiles={profiles} onChange={(then) => setRule(i, { ...rule, then })} />
                  </div>
                </div>
                <div className="smartEdge">otherwise</div>
              </div>
            );
          })}

          <div className={`smartNode last${decision.ruleIndex === -1 ? ' chosen' : ''}`}>
            <div className="smartNode-h">
              <span className="smartNode-n">◆</span>
              <span className="muted small">Anything else</span>
              <span className="spacer" />
              {decision.ruleIndex === -1 && <span className="badge green">this one</span>}
            </div>
            <div className="smartNode-b">
              <div className="inline">
                <span className="small muted">then</span>
                <OutcomePicker value={sp.otherwise} profiles={profiles} onChange={(otherwise) => setSp({ ...sp, otherwise })} />
              </div>
            </div>
          </div>
        </div>

        <button className="btn sm mt" onClick={addRule}>
          <Icon.Plus /> Add node
        </button>

        <div className="subhead row mt">
          <span>Try it</span>
          <span className="spacer" />
          <select value={sample} onChange={(e) => setSample(Number(e.target.value))}>
            {SAMPLE_SOURCES.map((s, i) => (
              <option key={s.name} value={i}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="smartTry small">
          <span className="mono">{facts.audio.maxChannels}ch {facts.audio.codecs.join('/')}{facts.audio.objectBased ? ' · object audio' : ''} · {facts.video.height}p{facts.video.hdr ? ' HDR' : ''}</span>
          <span className="spacer" />
          <span>
            → <strong>{decision.outcome.kind === 'keep' ? 'left as it is' : (profileName(decision.outcome.profileId) ?? decision.outcome.profileId)}</strong>
            {decision.rule ? <span className="dim"> ({decision.rule.when.map(describeCondition).join(' and ')})</span> : <span className="dim"> (nothing matched)</span>}
          </span>
        </div>

        {missing.length > 0 && <div className="warn small mt">A node points at a profile that no longer exists. Pick another one before saving.</div>}
        {error && <div className="warn small mt">{error}</div>}
      </>
    </Modal>
  );
}
