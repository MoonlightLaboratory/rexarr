import assert from 'node:assert/strict';
import test from 'node:test';
import type { NotificationTarget } from '../../shared/types.js';
import { buildRequest, jobEvent, ripEvent } from './notify.js';

const target = (over: Partial<NotificationTarget>): NotificationTarget => ({
  id: 't', name: 'Test', kind: 'discord', enabled: true, url: '', events: ['encode.done'], ...over,
});
const payload = { event: 'encode.done' as const, title: 'Encode finished', message: 'Frieren S01E05' };
const body = (r: { init: RequestInit } | null) => JSON.parse(String(r!.init.body));
const headers = (r: { init: RequestInit } | null) => r!.init.headers as Record<string, string>;

test('Discord and Slack get the shape each expects', () => {
  const d = buildRequest(target({ kind: 'discord', url: 'https://discord.com/api/webhooks/1/abc' }), payload);
  assert.equal(d!.url, 'https://discord.com/api/webhooks/1/abc');
  assert.match(body(d).content, /\*\*Encode finished\*\*/);
  const s = buildRequest(target({ kind: 'slack', url: 'https://hooks.slack.com/services/x' }), payload);
  assert.match(body(s).text, /^\*Encode finished\*/);
});

test('Telegram needs both the bot token and the chat', () => {
  assert.equal(buildRequest(target({ kind: 'telegram', token: 'bot', url: '' }), payload), null, 'no chat id');
  const r = buildRequest(target({ kind: 'telegram', token: '123:abc', target: '42' }), payload);
  assert.equal(r!.url, 'https://api.telegram.org/bot123:abc/sendMessage');
  assert.equal(body(r).chat_id, '42');
});

test('ntfy takes the topic from the URL or beside it, and marks failures urgent', () => {
  const direct = buildRequest(target({ kind: 'ntfy', url: 'https://ntfy.sh/rexarr/' }), payload);
  assert.equal(direct!.url, 'https://ntfy.sh/rexarr');
  assert.equal(String(direct!.init.body), 'Frieren S01E05', 'ntfy takes the message as the body');
  const split = buildRequest(target({ kind: 'ntfy', url: 'https://ntfy.example', target: 'rexarr' }), { ...payload, failed: true });
  assert.equal(split!.url, 'https://ntfy.example/rexarr');
  assert.equal(headers(split).priority, 'high');
});

test('Gotify and Pushbullet carry their token the way each wants it', () => {
  const g = buildRequest(target({ kind: 'gotify', url: 'https://gotify.example/', token: 'tok en' }), payload);
  assert.equal(g!.url, 'https://gotify.example/message?token=tok%20en');
  const pb = buildRequest(target({ kind: 'pushbullet', token: 'o.abc' }), payload);
  assert.equal(headers(pb)['access-token'], 'o.abc');
  assert.equal(body(pb).type, 'note');
});

test('Apprise posts to a saved config, or takes the urls inline', () => {
  const saved = buildRequest(target({ kind: 'apprise', url: 'http://apprise:8000', token: 'home' }), payload);
  assert.equal(saved!.url, 'http://apprise:8000/notify/home');
  const stateless = buildRequest(target({ kind: 'apprise', url: 'http://apprise:8000', target: 'discord://x/y' }), payload);
  assert.equal(stateless!.url, 'http://apprise:8000/notify');
  assert.equal(body(stateless).urls, 'discord://x/y');
});

test('a plain webhook gets the event itself', () => {
  const r = buildRequest(target({ kind: 'webhook', url: 'https://example.com/hook' }), { ...payload, event: 'rip.failed', failed: true });
  assert.deepEqual(Object.keys(body(r)).sort(), ['at', 'event', 'failed', 'message', 'title']);
  assert.equal(body(r).event, 'rip.failed');
  assert.equal(body(r).failed, true);
});

test('a target without its URL or token builds nothing', () => {
  for (const kind of ['discord', 'slack', 'gotify', 'pushbullet', 'apprise', 'webhook'] as const) {
    assert.equal(buildRequest(target({ kind, url: '', token: '' }), payload), null, `${kind} with nothing configured`);
  }
});

test('only a change into a final state is worth sending', () => {
  assert.equal(jobEvent('encoding', 'done'), 'encode.done');
  assert.equal(jobEvent('encoding', 'failed'), 'encode.failed');
  assert.equal(jobEvent('done', 'done'), null, 'the same status twice is not news');
  assert.equal(jobEvent(undefined, 'encoding'), null);
  assert.equal(jobEvent('encoding', 'cancelled'), null, 'cancelling is the user doing it');
  assert.equal(ripEvent('delivering', 'done'), 'rip.done');
  assert.equal(ripEvent('ripping', 'failed'), 'rip.failed');
  assert.equal(ripEvent('failed', 'failed'), null);
});
