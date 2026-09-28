import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makemkvInfo } from './makemkv.js';

test('availability probe distinguishes a MakeMKV disc error from an unusable executable', { skip: process.platform === 'win32' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rexarr-tool-probe-'));
  const tool = path.join(dir, 'makemkvcon');
  const script = (body: string, mode = 0o755) => {
    fs.writeFileSync(tool, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(tool, mode);
  };
  try {
    const banner = 'MSG:1005,0,1,"MakeMKV v1.18.4 linux(x64-release) started","%1 started","MakeMKV v1.18.4 linux(x64-release)"';
    for (const code of [0, 1]) await t.test(`version banner with exit ${code}`, async () => {
      // Exit 0 and this robot banner were observed with MakeMKV 1.18.4.
      // Exit 1 is a synthetic compatibility case, not a claimed real capture.
      script(`printf '%s\\n' '${banner}'; exit ${code}`);
      assert.deepEqual(await makemkvInfo(tool, true), { available: true, path: tool, version: '1.18.4' });
    });
    await t.test('unrelated failing executable', async () => {
      script('echo "not MakeMKV"; exit 1');
      assert.equal((await makemkvInfo(tool, true)).available, false);
    });
    await t.test('successful executable without a version', async () => {
      script('exit 0');
      assert.equal((await makemkvInfo(tool, true)).available, false);
    });
    await t.test('permission denied', async () => {
      script('exit 0', 0o644);
      const denied = await makemkvInfo(tool, true);
      assert.equal(denied.available, false);
      assert.match(denied.error!, /not executable/);
    });
    // A real file with a missing interpreter reliably produces ENOENT, even if
    // MakeMKV happens to be installed in a default location on the test host.
    await t.test('missing interpreter', async () => {
      fs.writeFileSync(tool, '#!/rexarr-test-missing-interpreter\n');
      fs.chmodSync(tool, 0o755);
      const missing = await makemkvInfo(tool, true);
      assert.equal(missing.available, false);
      assert.match(missing.error!, /not found/);
    });
    await t.test('signal after printing a banner', async () => {
      script(`printf '%s\\n' '${banner}'; kill -TERM $$`);
      assert.equal((await makemkvInfo(tool, true)).available, false);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
