/**
 * The rip farm's two sides.
 *
 *   /api/agents/...     what an agent calls: enrol once, then poll. Authenticated by the API key, like any other
 *                       script talking to Rexarr, so an agent needs no account of its own.
 *   /api/agents         what the Agents page calls: list them, approve one, set how much it takes on, and the
 *                       path mappings for where it mounts the shared folder.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Agent, JobProgress } from '../../../shared/types.js';
import { store } from '../store.js';
import { clientIp } from '../auth.js';
import { agentSettings, cancelTask, claimFor, enrol, forgetAgent, getAgent, getTask, isOnline, listAgents, listTasks, logTask, mapArgs, reportProgress, finishTask, sweepOffline } from '../agents/registry.js';
import { bus } from '../events.js';

const capabilitiesSchema = z.object({
  rip: z.boolean(),
  transcode: z.boolean(),
  makemkvVersion: z.string().max(80).optional(),
  ffmpegVersion: z.string().max(200).optional(),
  videoEncoders: z.array(z.string().max(40)).max(40).optional(),
  hardware: z.string().max(80).optional(),
  platform: z.string().max(40),
  arch: z.string().max(40),
  cpus: z.number().int().min(0).max(4096),
  totalMemoryBytes: z.number().min(0),
});

const driveSchema = z.object({}).passthrough();

const enrolSchema = z.object({
  id: z.string().min(8).max(80),
  name: z.string().min(1).max(80),
  version: z.string().max(40),
  capabilities: capabilitiesSchema,
  drives: z.array(driveSchema).max(32).default([]),
});

const progressSchema = z.object({
  percent: z.number(),
  fps: z.number().optional(),
  speed: z.string().max(40).optional(),
  bitrate: z.string().max(40).optional(),
  outTimeSeconds: z.number().optional(),
  etaSeconds: z.number().nullable().optional(),
  frame: z.number().optional(),
  sizeBytes: z.number().optional(),
});

const pollSchema = z.object({
  drives: z.array(driveSchema).max(32).optional(),
  capabilities: capabilitiesSchema.optional(),
  running: z.array(z.string().max(80)).max(32).default([]),
  tasks: z
    .array(
      z.object({
        id: z.string().max(80),
        status: z.enum(['running', 'done', 'failed']),
        progress: progressSchema.optional(),
        log: z.array(z.string().max(2000)).max(200).optional(),
        exitCode: z.number().nullable().optional(),
        error: z.string().max(2000).optional(),
        // a scan's answer is its stdout, which the server parses; a Blu-ray's is big but not huge
        output: z.string().max(4_000_000).optional(),
      }),
    )
    .max(32)
    .default([]),
});

export default async function agentRoutes(app: FastifyInstance) {
  // ---- what an agent calls ----

  app.post('/api/agents/enrol', async (req, reply) => {
    if (!agentSettings().enabled) return reply.code(403).send({ error: 'rip farm mode is off on this server (Settings → Connections → Rip farm)' });
    const parsed = enrolSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    const known = getAgent(parsed.data.id);
    const agent = enrol({ ...parsed.data, capabilities: parsed.data.capabilities as unknown as Agent['capabilities'], drives: parsed.data.drives as unknown as Agent['drives'], address: clientIp(req) });
    if (!known) bus.notice(agent.enabled ? 'info' : 'warn', agent.enabled ? `Agent "${agent.name}" joined the farm` : `Agent "${agent.name}" is waiting to be approved (Settings → Connections → Rip farm)`);
    return { ok: true, approved: agent.enabled, pollSeconds: 5, name: agent.name };
  });

  /**
   * One call does everything: the agent says what it is doing, and is told what to start and what to drop. One
   * round trip a few seconds apart is cheap enough, and it means an agent needs no inbound port of its own.
   */
  app.post<{ Params: { id: string } }>('/api/agents/:id/poll', async (req, reply) => {
    const parsed = pollSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' });
    const agent = getAgent(req.params.id);
    if (!agent) return reply.code(404).send({ error: 'unknown agent – enrol first' });

    for (const t of parsed.data.tasks) {
      const task = getTask(t.id);
      if (!task) continue;
      if (t.log?.length) logTask(t.id, t.log);
      if (t.status === 'running' && t.progress) reportProgress(t.id, t.progress as JobProgress);
      else if (t.status !== 'running') finishTask(t.id, t.exitCode ?? (t.status === 'done' ? 0 : 1), t.error, t.output);
    }

    agent.lastSeen = new Date().toISOString();
    agent.address = clientIp(req);
    if (parsed.data.drives) agent.drives = parsed.data.drives as unknown as Agent['drives'];
    if (parsed.data.capabilities) agent.capabilities = parsed.data.capabilities as unknown as Agent['capabilities'];
    // what it says it is running is the truth; anything else it was given has finished or died with it
    agent.running = parsed.data.running.filter((id) => getTask(id)?.status === 'running');
    store.saveAgent(agent);

    const start = agent.enabled && agentSettings().enabled ? claimFor(agent) : [];
    for (const t of start) agent.running.push(t.id);
    if (start.length) store.saveAgent(agent);

    return {
      pollSeconds: 5,
      approved: agent.enabled,
      // the arguments as this agent sees them: its own mount of the shared folder, not the server's
      start: start.map((t) => ({ id: t.id, kind: t.kind, label: t.label, program: t.program, args: mapArgs(agent, t.args), durationSeconds: t.durationSeconds, capture: t.capture })),
      cancel: parsed.data.running.filter((id) => getTask(id)?.status === 'cancelled'),
    };
  });

  // ---- what the Agents page calls ----

  app.get('/api/agents', async () => {
    sweepOffline();
    const tasks = listTasks();
    return listAgents().map((a) => ({
      ...a,
      online: isOnline(a),
      tasks: tasks.filter((t) => t.takenBy === a.id && t.status === 'running'),
    }));
  });

  app.get('/api/agents/tasks', async () => listTasks());

  app.patch<{ Params: { id: string } }>('/api/agents/:id', async (req, reply) => {
    const agent = getAgent(req.params.id);
    if (!agent) return reply.code(404).send({ error: 'unknown agent' });
    const parsed = z
      .object({
        name: z.string().min(1).max(80).optional(),
        enabled: z.boolean().optional(),
        concurrency: z.number().int().min(1).max(16).optional(),
        pathMappings: z.array(z.object({ remote: z.string().max(500), local: z.string().max(500) })).max(20).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' });
    Object.assign(agent, parsed.data);
    store.saveAgent(agent);
    return agent;
  });

  app.delete<{ Params: { id: string } }>('/api/agents/:id', async (req, reply) => {
    if (!getAgent(req.params.id)) return reply.code(404).send({ error: 'unknown agent' });
    forgetAgent(req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/agents/tasks/:id/cancel', async (req, reply) => {
    if (!getTask(req.params.id)) return reply.code(404).send({ error: 'unknown task' });
    cancelTask(req.params.id);
    return { ok: true };
  });
}
