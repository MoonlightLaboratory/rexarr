/**
 * The agents a server knows about, and the queue they take work from.
 *
 * Agents pull. Nothing is pushed to an agent and nothing listens on it: it polls the server, says what it can do
 * and what it is doing, and is handed back whatever it should start. That is what makes a shelf of SBCs behind a
 * router workable, and it means an agent that dies simply stops polling - after which its work is handed back to
 * the queue rather than being lost.
 *
 * A task is a program, its arguments and the duration of what is being read. The server builds the arguments, so
 * the agent needs none of the knowledge behind them; it also means an agent only ever runs the two programs it
 * was configured with, never a command the server happens to send.
 */
import { randomUUID } from 'node:crypto';
import type { Agent, AgentTask, AgentTaskKind, JobProgress, PathMapping } from '../../../shared/types.js';
import { store } from '../store.js';

/** Tasks live for as long as the server does: a half-done rip is not something to resume after a restart. */
const tasks = new Map<string, AgentTask>();

/**
 * What the thing that made a task wants to hear about it. The queue and the disc manager each want their own
 * log and progress, so the task carries their callbacks rather than the routes knowing who to tell.
 */
export interface TaskHooks {
  onLog?: (lines: string[]) => void;
  onProgress?: (p: JobProgress) => void;
  onFinish?: (exitCode: number | null, error?: string, output?: string) => void;
}
const hooks = new Map<string, TaskHooks>();

export function agentSettings() {
  return store.settings.agents ?? { enabled: false, requireApproval: true, localFirst: 0, offlineAfterSeconds: 90 };
}

export function isOnline(a: Agent): boolean {
  return Date.now() - new Date(a.lastSeen).getTime() < agentSettings().offlineAfterSeconds * 1000;
}

/** Ready for work: enabled, approved, seen recently, and not already full. */
export function isAvailable(a: Agent): boolean {
  return agentSettings().enabled && a.enabled && isOnline(a) && a.running.length < Math.max(1, a.concurrency);
}

/**
 * Rewrite a path the server knows into the one this agent sees. The mappings are the agent's own, since two
 * machines can mount the same share at different places, and the longest prefix wins so a specific mapping can
 * sit inside a general one.
 */
export function toAgentPath(a: Agent, p: string): string {
  const hit = [...(a.pathMappings ?? [])]
    .filter((m) => m.remote && p.startsWith(m.remote))
    .sort((x, y) => y.remote.length - x.remote.length)[0];
  return hit ? `${hit.local}${p.slice(hit.remote.length)}` : p;
}

/** Every argument an agent is given, with the shared folder rewritten to where that agent mounts it. */
export function mapArgs(a: Agent, args: string[]): string[] {
  if (!a.pathMappings?.length) return args;
  return args.map((arg) => {
    const mapped = toAgentPath(a, arg);
    if (mapped !== arg) return mapped;
    // paths also turn up inside an argument, as makemkvcon's "iso:/path" sources do
    const m = arg.match(/^([a-z]+:)(\/.*)$/i);
    return m ? `${m[1]}${toAgentPath(a, m[2])}` : arg;
  });
}

export function listAgents(): Agent[] {
  return store.agents;
}

export function getAgent(id: string): Agent | undefined {
  return store.agents.find((a) => a.id === id);
}

/** An agent reporting in for the first time, or after a restart. */
export function enrol(input: Pick<Agent, 'id' | 'name' | 'version' | 'capabilities' | 'drives'> & { address?: string }): Agent {
  const now = new Date().toISOString();
  const existing = getAgent(input.id);
  const agent: Agent = existing
    ? { ...existing, ...input, lastSeen: now }
    : {
        ...input,
        concurrency: 1,
        pathMappings: [],
        // approval is the gate, so a newly seen agent is enabled but idle until someone says yes
        enabled: !agentSettings().requireApproval,
        firstSeen: now,
        lastSeen: now,
        running: [],
      };
  store.saveAgent(agent);
  return agent;
}

export function forgetAgent(id: string): void {
  for (const t of tasks.values()) if (t.takenBy === id && (t.status === 'running' || t.status === 'queued')) release(t.id, 'the agent was removed');
  store.deleteAgent(id);
}

// ---- the shared queue ---------------------------------------------------------------------------

export interface NewTask {
  kind: AgentTaskKind;
  ownerId: string;
  label: string;
  program: AgentTask['program'];
  args: string[];
  durationSeconds?: number;
  capture?: boolean;
  /** A rip belongs to the machine the disc is in; an encode can go anywhere. */
  agentId?: string;
  needsEncoders?: string[];
}

export function createTask(t: NewTask, on: TaskHooks = {}): AgentTask {
  const task: AgentTask = { ...t, id: randomUUID(), status: 'queued', createdAt: new Date().toISOString() };
  tasks.set(task.id, task);
  hooks.set(task.id, on);
  return task;
}

export function logTask(id: string, lines: string[]): void {
  hooks.get(id)?.onLog?.(lines);
}

export function getTask(id: string): AgentTask | undefined {
  return tasks.get(id);
}

export function listTasks(): AgentTask[] {
  return [...tasks.values()];
}

export function dropTask(id: string): void {
  tasks.delete(id);
  hooks.delete(id);
}

/** Can this agent run this task at all? */
function suits(a: Agent, t: AgentTask): boolean {
  if (t.agentId && t.agentId !== a.id) return false;
  if ((t.kind === 'rip' || t.kind === 'scan') && !a.capabilities.rip) return false;
  if (t.kind === 'transcode' && !a.capabilities.transcode) return false;
  const have = a.capabilities.videoEncoders ?? [];
  // an agent that did not say which encoders it has is taken at its word
  if (t.needsEncoders?.length && have.length && !t.needsEncoders.every((e) => have.includes(e as never))) return false;
  return true;
}

/** What this agent should start now, oldest first, up to what it has room for. */
export function claimFor(agent: Agent): AgentTask[] {
  if (!isAvailable(agent)) return [];
  const room = Math.max(1, agent.concurrency) - agent.running.length;
  const out: AgentTask[] = [];
  for (const t of [...tasks.values()].sort((x, y) => x.createdAt.localeCompare(y.createdAt))) {
    if (out.length >= room) break;
    if (t.status !== 'queued' || !suits(agent, t)) continue;
    t.status = 'running';
    t.takenBy = agent.id;
    t.startedAt = new Date().toISOString();
    out.push(t);
  }
  return out;
}

export function reportProgress(id: string, progress: JobProgress): void {
  const t = tasks.get(id);
  if (!t || t.status !== 'running') return;
  t.progress = progress;
  hooks.get(id)?.onProgress?.(progress);
}

export function finishTask(id: string, exitCode: number | null, error?: string, output?: string): void {
  const t = tasks.get(id);
  if (!t || t.status === 'cancelled' || t.status === 'done' || t.status === 'failed') return;
  t.status = exitCode === 0 ? 'done' : 'failed';
  t.exitCode = exitCode;
  t.error = error;
  t.finishedAt = new Date().toISOString();
  hooks.get(id)?.onFinish?.(exitCode, error, output);
}

export function cancelTask(id: string): void {
  const t = tasks.get(id);
  if (!t || t.status === 'done' || t.status === 'failed') return;
  t.status = 'cancelled';
  t.finishedAt = new Date().toISOString();
  hooks.get(id)?.onFinish?.(null, 'cancelled');
}

/** Put a task back: its agent went away, or was taken off the farm, mid-way through. */
export function release(id: string, why: string): void {
  const t = tasks.get(id);
  if (!t || (t.status !== 'running' && t.status !== 'queued')) return;
  t.status = 'queued';
  t.takenBy = undefined;
  t.startedAt = undefined;
  t.progress = undefined;
  t.error = `handed back: ${why}`;
  hooks.get(id)?.onLog?.([`Handed back to the queue: ${why}`]);
}

/**
 * Agents that have stopped polling. Their work goes back on the queue - with a shared folder the file is still
 * there, half written, and the server is the one that cleans it up, so nothing is left behind on the agent.
 */
export function sweepOffline(): string[] {
  const gone: string[] = [];
  for (const a of store.agents) {
    if (isOnline(a) || !a.running.length) continue;
    gone.push(a.name);
    for (const id of a.running) release(id, `${a.name} stopped reporting in`);
    a.running = [];
    store.saveAgent(a);
  }
  return gone;
}

export type { PathMapping };
