import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from './main.js';

test('the agent takes its settings from flags or the environment', () => {
  const a = parseArgs(['--server', 'http://nas:3939/', '--key', 'abc', '--name', 'shelf-pi-1'], {});
  assert.equal(a.server, 'http://nas:3939'); // the trailing slash would double up in every URL
  assert.equal(a.key, 'abc');
  assert.equal(a.name, 'shelf-pi-1');
  const b = parseArgs([], { REXARR_SERVER: 'http://nas:3939', REXARR_API_KEY: 'k', REXARR_AGENT_NAME: 'pi', REXARR_VIRTUAL_DRIVES: '/discs' });
  assert.equal(b.name, 'pi');
  assert.equal(b.virtualDrives, '/discs');
  // a flag beats the environment, so a one-off run can point somewhere else
  assert.equal(parseArgs(['--name', 'flag'], { REXARR_SERVER: 'http://x:1', REXARR_API_KEY: 'k', REXARR_AGENT_NAME: 'env' }).name, 'flag');
});
