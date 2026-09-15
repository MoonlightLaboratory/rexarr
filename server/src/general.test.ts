import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, isLocalAddress, isLocalHostname, listenHost, normalizeUrlBase, verifyPassword } from './general.js';
import { matchesBypass } from './net.js';

test('passwords are salted scrypt hashes', () => {
  const h = hashPassword('correct horse');
  assert.match(h, /^scrypt\$16384\$/);
  assert.notEqual(h, hashPassword('correct horse'));
  assert.equal(verifyPassword('correct horse', h), true);
  assert.equal(verifyPassword('wrong', h), false);
  assert.equal(verifyPassword('x', 'garbage'), false);
});

test('local addresses and host names', () => {
  for (const ip of ['127.0.0.1', '::1', '::ffff:192.168.1.20', '10.0.0.5', '172.20.1.1', '192.168.0.10', 'fd00::1', 'fe80::1', '100.64.0.1']) assert.equal(isLocalAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '2001:4860::1', '']) assert.equal(isLocalAddress(ip), false, ip);
  assert.equal(isLocalHostname('nas'), true);
  assert.equal(isLocalHostname('sonarr.local'), true);
  assert.equal(isLocalHostname('api.thetvdb.com'), false);
});

test('url base, bind address and proxy bypass list', () => {
  assert.equal(normalizeUrlBase('rexarr/'), '/rexarr');
  assert.equal(normalizeUrlBase('/'), '');
  assert.equal(listenHost('*'), '0.0.0.0');
  assert.equal(listenHost('192.168.1.10'), '192.168.1.10');
  assert.equal(matchesBypass('sonarr.local', '*.local, 192.168.1.*'), true);
  assert.equal(matchesBypass('192.168.1.20', '*.local, 192.168.1.*'), true);
  assert.equal(matchesBypass('image.tmdb.org', '*.local, 192.168.1.*'), false);
});
