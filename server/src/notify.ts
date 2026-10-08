/**
 * Notifications: Discord, Slack, Telegram, ntfy, Gotify, Pushbullet, an Apprise server or a plain webhook,
 * told when an encode or a disc rip finishes or fails and when a new release is out.
 *
 * Nothing here is allowed to break the thing it is reporting on: every send is capped by a timeout, failures are
 * written to System → Events and swallowed, and a target that is off or not subscribed is skipped before any work.
 */
import type { Job, DiscRip, NotificationEvent, NotificationTarget } from '../../shared/types.js';
import { bus } from './events.js';
import { httpFetch } from './net.js';
import { store } from './store.js';
import { appEvents } from './system.js';

export interface NotifyPayload {
  event: NotificationEvent;
  title: string;
  message: string;
  /** True for the failure events, so targets that show severity can use it. */
  failed?: boolean;
}

/** The request a target needs for this payload, or null when it is not configured enough to send. */
export function buildRequest(t: NotificationTarget, p: NotifyPayload): { url: string; init: RequestInit } | null {
  const json = (url: string, body: unknown, headers: Record<string, string> = {}): { url: string; init: RequestInit } => ({
    url,
    init: { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) },
  });
  const url = t.url.trim().replace(/\/+$/, '');
  switch (t.kind) {
    case 'discord':
      return url ? json(url, { content: `**${p.title}**\n${p.message}` }) : null;
    case 'slack':
      return url ? json(url, { text: `*${p.title}*\n${p.message}` }) : null;
    case 'telegram':
      return t.token && t.target
        ? json(`https://api.telegram.org/bot${t.token}/sendMessage`, { chat_id: t.target, text: `${p.title}\n${p.message}`, disable_web_page_preview: true })
        : null;
    case 'ntfy': {
      // The URL can be the topic itself (https://ntfy.sh/rexarr) or the server, with the topic beside it.
      const dest = t.target ? `${url}/${t.target.replace(/^\/+/, '')}` : url;
      if (!dest) return null;
      return {
        url: dest,
        init: {
          method: 'POST',
          headers: {
            'content-type': 'text/plain',
            title: p.title,
            priority: p.failed ? 'high' : 'default',
            tags: p.failed ? 'rotating_light' : 'white_check_mark',
            ...(t.token ? { authorization: `Bearer ${t.token}` } : {}),
          },
          body: p.message,
        },
      };
    }
    case 'gotify':
      return url && t.token ? json(`${url}/message?token=${encodeURIComponent(t.token)}`, { title: p.title, message: p.message, priority: p.failed ? 8 : 4 }) : null;
    case 'pushbullet':
      return t.token ? json('https://api.pushbullet.com/v2/pushes', { type: 'note', title: p.title, body: p.message }, { 'access-token': t.token }) : null;
    case 'apprise': {
      // A stateful Apprise API server uses a saved config key; a stateless one takes the urls with the request.
      if (!url) return null;
      const body: Record<string, unknown> = { title: p.title, body: p.message, type: p.failed ? 'failure' : 'success' };
      if (t.target) body.urls = t.target;
      return json(t.token ? `${url}/notify/${encodeURIComponent(t.token)}` : `${url}/notify`, body);
    }
    case 'webhook':
      return url ? json(url, { event: p.event, title: p.title, message: p.message, failed: p.failed === true, at: new Date().toISOString() }) : null;
    default:
      return null;
  }
}

async function send(t: NotificationTarget, p: NotifyPayload): Promise<string | null> {
  const req = buildRequest(t, p);
  if (!req) return `${t.kind} target "${t.name}" is missing its URL or token`;
  try {
    const res = await httpFetch(req.url, { ...req.init, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return `${res.status} ${res.statusText}`.trim();
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/** Send one test message, so the Settings page can say whether a target works. */
export async function testTarget(t: NotificationTarget): Promise<string | null> {
  return send(t, { event: 'encode.done', title: 'Rexarr', message: 'Test notification – if you can read this, the target works.' });
}

/** Tell every enabled target that is subscribed to this event. Never throws. */
export async function notify(p: NotifyPayload): Promise<void> {
  const targets = (store.settings.notifications?.targets ?? []).filter((t) => t.enabled && t.events?.includes(p.event));
  if (!targets.length) return;
  await Promise.all(
    targets.map(async (t) => {
      const error = await send(t, p);
      if (error) appEvents.add('warning', 'Notifications', `${t.name} (${t.kind}) did not accept the message: ${error}`);
    }),
  );
}

// ---- what is worth telling you about -----------------------------------------------------------

/** The event a job's new status is worth sending, if any. Only a change into a final state counts. */
export function jobEvent(previous: Job['status'] | undefined, status: Job['status']): NotificationEvent | null {
  if (previous === status) return null;
  if (status === 'done') return 'encode.done';
  if (status === 'failed') return 'encode.failed';
  return null;
}

/** The same for a disc rip. */
export function ripEvent(previous: DiscRip['status'] | undefined, status: DiscRip['status']): NotificationEvent | null {
  if (previous === status) return null;
  if (status === 'done') return 'rip.done';
  if (status === 'failed') return 'rip.failed';
  return null;
}

const jobStatus = new Map<string, Job['status']>();
const ripStatus = new Map<string, DiscRip['status']>();

/** Watch the event bus rather than reaching into the queue and the disc manager. */
export function startNotifications(): void {
  bus.on('event', (e: { type: string; job?: Job; rip?: DiscRip }) => {
    if (e.type === 'job' && e.job) {
      const job = e.job;
      const event = jobEvent(jobStatus.get(job.id), job.status);
      jobStatus.set(job.id, job.status);
      if (jobStatus.size > 500) for (const id of [...jobStatus.keys()].slice(0, 100)) jobStatus.delete(id);
      if (event) {
        const what = [job.title, job.subtitle].filter(Boolean).join(' · ');
        void notify({
          event,
          title: event === 'encode.done' ? 'Encode finished' : 'Encode failed',
          message: event === 'encode.done' ? `${what} (${job.profileName})` : `${what}: ${job.error ?? 'no reason given'}`,
          failed: event === 'encode.failed',
        });
      }
    }
    if (e.type === 'rip' && e.rip) {
      const rip = e.rip;
      const event = ripEvent(ripStatus.get(rip.id), rip.status);
      ripStatus.set(rip.id, rip.status);
      if (ripStatus.size > 500) for (const id of [...ripStatus.keys()].slice(0, 100)) ripStatus.delete(id);
      if (event) {
        const what = rip.media?.title || rip.label || rip.volumeName || 'Disc';
        void notify({
          event,
          title: event === 'rip.done' ? 'Disc finished' : 'Disc failed',
          message: event === 'rip.done' ? `${what} was ripped and handed to the *arr apps` : `${what}: ${rip.error ?? 'no reason given'}`,
          failed: event === 'rip.failed',
        });
      }
    }
  });
}

/** Called by the update check the first time it sees a newer release. */
export async function notifyUpdate(version: string, current: string): Promise<void> {
  await notify({ event: 'update.available', title: 'Rexarr update available', message: `Rexarr ${version} is out – this is ${current}.` });
}
