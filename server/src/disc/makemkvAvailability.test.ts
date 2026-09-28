import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makemkvInfo } from './makemkv.js';

test('availability probe distinguishes a MakeMKV disc error from an unusable executable', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rexarr-tool-probe-'));
  const tool = path.join(dir, 'makemkvcon');
  const script = (body: string, mode = 0o755) => {
    fs.writeFileSync(tool, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(tool, mode);
  };
  try {
    script('echo "MakeMKV v1.18.4 linux(x64-release) started"; exit 1');
    assert.deepEqual(await makemkvInfo(tool, true), { available: true, path: tool, version: '1.18.4' });
    script('echo "not MakeMKV"; exit 1');
    assert.equal((await makemkvInfo(tool, true)).available, false);
    script('exit 0');
    assert.equal((await makemkvInfo(tool, true)).available, false);
    script('exit 0', 0o644);
    const denied = await makemkvInfo(tool, true);
    assert.equal(denied.available, false);
    assert.match(denied.error!, /not executable/);
    // A real file with a missing interpreter reliably produces ENOENT, even if
    // MakeMKV happens to be installed in a default location on the test host.
    fs.writeFileSync(tool, '#!/rexarr-test-missing-interpreter\n');
    fs.chmodSync(tool, 0o755);
    const missing = await makemkvInfo(tool, true);
    assert.equal(missing.available, false);
    assert.match(missing.error!, /not found/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
