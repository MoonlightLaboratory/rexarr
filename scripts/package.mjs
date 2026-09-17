#!/usr/bin/env node
/**
 * Build the release packages attached to a GitHub release (Sonarr-style names):
 *
 *   rexarr.main.<version>.linux-x64.tar.gz        linux-arm64 / linux-arm / linux-musl-x64 / linux-musl-arm64
 *   rexarr.main.<version>.osx-arm64.tar.gz        osx-x64
 *   rexarr.main.<version>.osx-arm64-app.zip       osx-x64-app   (Rexarr.app)
 *   rexarr.main.<version>.win-x64.zip             win-x86       (installers are built from these by Inno Setup)
 *   rexarr.main.<version>.freebsd-x64.tar.gz      no bundled Node: FreeBSD has no official build (pkg install node22)
 *
 * Every package carries the built app (server/dist, client/dist, production node_modules – pure JavaScript, so the
 * same for all platforms), a Node runtime for its platform in runtime/, a launcher and a package_info file (which
 * also makes Rexarr keep its data in ~/.config/rexarr or C:\ProgramData\rexarr instead of ./data).
 *
 * Usage (after `npm ci && npm run build`):
 *   node scripts/package.mjs [--out release] [--targets linux-x64,osx-arm64-app] [--node-version 22.x.y]
 *                            [--local-node]   use this machine's node for its own platform instead of downloading
 * Requires tar and zip (and unzip for Windows runtimes). Node downloads are verified against SHASUMS256.txt.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const VERSION = fs.readFileSync(path.join(ROOT, 'shared/version.ts'), 'utf8').match(/APP_VERSION = '([^']+)'/)[1];
const BRANCH = opt('branch', 'main');
const NODE_VERSION = opt('node-version', process.versions.node).replace(/^v/, '');
const OUT = path.resolve(ROOT, opt('out', 'release'));
const STAGE = path.join(OUT, 'stage');
const CACHE = path.join(OUT, '.cache');

/** target → Node distribution ("" = none), kind of launcher, archive format */
const TARGETS = {
  'freebsd-x64': { node: '', os: 'unix', archive: 'tar.gz' },
  'linux-arm': { node: 'linux-armv7l', os: 'unix', archive: 'tar.gz' },
  'linux-arm64': { node: 'linux-arm64', os: 'unix', archive: 'tar.gz' },
  'linux-musl-arm64': { node: 'linux-arm64-musl', os: 'unix', archive: 'tar.gz', unofficial: true },
  'linux-musl-x64': { node: 'linux-x64-musl', os: 'unix', archive: 'tar.gz', unofficial: true },
  'linux-x64': { node: 'linux-x64', os: 'unix', archive: 'tar.gz' },
  'osx-arm64-app': { node: 'darwin-arm64', os: 'app', archive: 'zip' },
  'osx-arm64': { node: 'darwin-arm64', os: 'unix', archive: 'tar.gz' },
  'osx-x64-app': { node: 'darwin-x64', os: 'app', archive: 'zip' },
  'osx-x64': { node: 'darwin-x64', os: 'unix', archive: 'tar.gz' },
  'win-x64': { node: 'win-x64', os: 'windows', archive: 'zip' },
  'win-x86': { node: 'win-x86', os: 'windows', archive: 'zip' },
};
const selected = (opt('targets', '') || Object.keys(TARGETS).join(',')).split(',').map((t) => t.trim()).filter(Boolean);
for (const t of selected) if (!TARGETS[t]) throw new Error(`unknown target ${t} (one of ${Object.keys(TARGETS).join(', ')})`);

const run = (cmd, argv, cwd = ROOT, env = {}) => execFileSync(cmd, argv, { cwd, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, COPYFILE_DISABLE: '1', ...env } });
const log = (msg) => console.log(`[package] ${msg}`);
const write = (file, content, mode) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mode) fs.chmodSync(file, mode);
};
const crlf = (s) => s.replace(/\r?\n/g, '\r\n');

// ---------------------------------------------------------------- app (shared by every target)
function buildApp() {
  for (const p of ['server/dist/server/src/index.js', 'client/dist/index.html']) {
    if (!fs.existsSync(path.join(ROOT, p))) throw new Error(`${p} is missing: run "npm run build" first`);
  }
  const app = path.join(STAGE, '_app');
  fs.rmSync(app, { recursive: true, force: true });
  fs.mkdirSync(app, { recursive: true });

  log('installing production dependencies');
  const deps = path.join(STAGE, '_deps');
  fs.rmSync(deps, { recursive: true, force: true });
  for (const f of ['package.json', 'package-lock.json', 'server/package.json', 'client/package.json']) {
    fs.mkdirSync(path.dirname(path.join(deps, f)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), path.join(deps, f));
  }
  run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--prefer-offline', '--no-audit', '--no-fund', '-w', 'server'], deps);
  const modules = path.join(deps, 'node_modules');
  // workspace links and bin shims are symlinks (bad in zips) and unused at runtime
  for (const bin of run('find', [modules, '-type', 'd', '-name', '.bin']).toString().trim().split('\n').filter(Boolean)) fs.rmSync(bin, { recursive: true, force: true });
  fs.rmSync(path.join(modules, '@rexarr'), { recursive: true, force: true });
  fs.rmSync(path.join(modules, '.package-lock.json'), { force: true });
  for (const d of fs.readdirSync(modules)) {
    const p = path.join(modules, d);
    if (fs.statSync(p).isDirectory() && !fs.readdirSync(p).length) fs.rmdirSync(p);
  }
  const links = run('find', [modules, '-type', 'l']).toString().trim();
  if (links) throw new Error(`symlinks left in node_modules:\n${links}`);
  fs.cpSync(modules, path.join(app, 'node_modules'), { recursive: true });

  fs.cpSync(path.join(ROOT, 'server/dist'), path.join(app, 'server/dist'), { recursive: true, filter: (src) => !src.endsWith('.test.js') && !src.endsWith('.map') });
  fs.copyFileSync(path.join(ROOT, 'server/package.json'), path.join(app, 'server/package.json'));
  fs.cpSync(path.join(ROOT, 'client/dist'), path.join(app, 'client/dist'), { recursive: true });
  const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  write(path.join(app, 'package.json'), `${JSON.stringify({ name: 'rexarr', version: VERSION, private: true, type: 'module', license: rootPkg.license, homepage: rootPkg.homepage }, null, 2)}\n`);
  for (const f of ['LICENSE.md', 'COPYRIGHT.md']) fs.copyFileSync(path.join(ROOT, f), path.join(app, f));
  fs.copyFileSync(path.join(ROOT, 'logo/rexarr.ico'), path.join(app, 'rexarr.ico'));
  return app;
}

// ---------------------------------------------------------------- Node runtimes
async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const shasums = new Map();
async function nodeRuntime(dist, unofficial) {
  const base = unofficial ? `https://unofficial-builds.nodejs.org/download/release/v${NODE_VERSION}` : `https://nodejs.org/dist/v${NODE_VERSION}`;
  const isWin = dist.startsWith('win-');
  const name = `node-v${NODE_VERSION}-${dist}`;
  const file = `${name}.${isWin ? 'zip' : 'tar.gz'}`;
  const dir = path.join(CACHE, name);
  if (fs.existsSync(path.join(dir, '.ok'))) return dir;

  if (flag('local-node') && dist === localDist()) {
    log(`using this machine's node for ${dist}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(process.execPath, path.join(dir, 'node'));
    fs.chmodSync(path.join(dir, 'node'), 0o755);
    write(path.join(dir, 'LICENSE'), 'Node.js is licensed under the MIT license: https://github.com/nodejs/node/blob/main/LICENSE\n');
    write(path.join(dir, '.ok'), '');
    return dir;
  }

  if (!shasums.has(base)) shasums.set(base, (await fetchBuffer(`${base}/SHASUMS256.txt`)).toString());
  const expected = shasums.get(base).split('\n').find((l) => l.trim().endsWith(`  ${file}`))?.split(/\s+/)[0];
  if (!expected) throw new Error(`${file} is not listed in ${base}/SHASUMS256.txt`);
  log(`downloading ${file}`);
  const buf = await fetchBuffer(`${base}/${file}`);
  const actual = crypto.createHash('sha256').update(buf).digest('hex');
  if (actual !== expected) throw new Error(`${file}: checksum mismatch (${actual} != ${expected})`);

  const tmp = path.join(CACHE, `${name}.extract`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const archive = path.join(tmp, file);
  fs.writeFileSync(archive, buf);
  if (isWin) run('unzip', ['-q', archive, `${name}/node.exe`, `${name}/LICENSE`, '-d', tmp]);
  else run('tar', ['-xzf', archive, '-C', tmp, `${name}/bin/node`, `${name}/LICENSE`]);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const bin = isWin ? 'node.exe' : 'node';
  fs.renameSync(path.join(tmp, name, isWin ? 'node.exe' : 'bin/node'), path.join(dir, bin));
  fs.renameSync(path.join(tmp, name, 'LICENSE'), path.join(dir, 'LICENSE'));
  if (!isWin) fs.chmodSync(path.join(dir, bin), 0o755);
  fs.rmSync(tmp, { recursive: true, force: true });
  write(path.join(dir, '.ok'), '');
  return dir;
}

function localDist() {
  const arch = process.arch === 'arm' ? 'armv7l' : process.arch;
  if (process.platform === 'darwin') return `darwin-${arch}`;
  if (process.platform === 'win32') return `win-${arch === 'ia32' ? 'x86' : arch}`;
  if (process.platform === 'linux') return `linux-${arch}${process.report?.getReport?.().header?.glibcVersionRuntime ? '' : '-musl'}`;
  return '';
}

// ---------------------------------------------------------------- launchers
const UNIX_LAUNCHER = `#!/bin/sh
# Rexarr launcher. Options: --browser opens the web UI once it is running.
# Data lives in ~/.config/rexarr unless REXARR_CONFIG_DIR is set; port 3939 unless REXARR_PORT is set.
SOURCE="$0"
while [ -h "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  case "$SOURCE" in /*) ;; *) SOURCE="$DIR/$SOURCE" ;; esac
done
DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
NODE="$DIR/runtime/node"
if [ ! -x "$NODE" ]; then
  NODE="$(command -v node || true)"
  if [ -z "$NODE" ]; then
    echo "rexarr: Node.js 22 or newer is required (FreeBSD: pkg install node22)" >&2
    exit 1
  fi
fi
exec "$NODE" "$DIR/server/dist/server/src/index.js" "$@"
`;

const APP_LAUNCHER = `#!/bin/sh
# rexarr.app: runs the server in the background and opens the web UI. Stop it from System → Shutdown.
# Data lives in ~/.config/rexarr; logs in ~/.config/rexarr/log.
APP="$(cd "$(dirname "$0")/../Resources/rexarr" && pwd)"
exec "$APP/runtime/node" "$APP/server/dist/server/src/index.js" --browser
`;

const WIN_CMD = `@echo off
rem Rexarr in a console window: close the window or press Ctrl+C to stop it.
rem Data lives in C:\\ProgramData\\rexarr unless REXARR_CONFIG_DIR is set; port 3939 unless REXARR_PORT is set.
"%~dp0runtime\\node.exe" "%~dp0server\\dist\\server\\src\\index.js" %*
`;

const WIN_VBS = `' Rexarr without a console window; opens the web UI in your browser. Stop it from System > Shutdown.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run """" & dir & "\\runtime\\node.exe"" """ & dir & "\\server\\dist\\server\\src\\index.js"" --browser", 0, False
`;

const infoPlist = (arch) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>Rexarr</string>
  <key>CFBundleExecutable</key><string>Rexarr</string>
  <key>CFBundleIconFile</key><string>Rexarr</string>
  <key>CFBundleIdentifier</key><string>com.moonlightlaboratory.rexarr</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Rexarr</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.video</string>
  <key>LSArchitecturePriority</key><array><string>${arch}</string></array>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>Copyright 2026 MoonlightLaboratory. GPL-3.0-or-later.</string>
</dict>
</plist>
`;

const packageInfo = (target) => `PackageVersion=${VERSION}
PackageAuthor=[MoonlightLaboratory](https://github.com/MoonlightLaboratory/rexarr)
Branch=${BRANCH}
Runtime=${target}
NodeVersion=${TARGETS[target].node ? NODE_VERSION : 'system'}
ReleaseUrl=https://github.com/MoonlightLaboratory/rexarr/releases/tag/v${VERSION}
`;

// ---------------------------------------------------------------- packages
async function packageTarget(target, app) {
  const t = TARGETS[target];
  const work = path.join(STAGE, target);
  fs.rmSync(work, { recursive: true, force: true });
  const top = t.os === 'app' ? path.join(work, 'Rexarr.app') : path.join(work, 'rexarr');
  const files = t.os === 'app' ? path.join(top, 'Contents/Resources/rexarr') : top;
  fs.cpSync(app, files, { recursive: true });
  write(path.join(files, 'package_info'), t.os === 'windows' ? crlf(packageInfo(target)) : packageInfo(target));

  if (t.node) {
    const rt = await nodeRuntime(t.node, t.unofficial);
    const bin = t.os === 'windows' ? 'node.exe' : 'node';
    fs.mkdirSync(path.join(files, 'runtime'), { recursive: true });
    fs.copyFileSync(path.join(rt, bin), path.join(files, 'runtime', bin));
    fs.copyFileSync(path.join(rt, 'LICENSE'), path.join(files, 'runtime', 'LICENSE'));
    if (t.os !== 'windows') fs.chmodSync(path.join(files, 'runtime', bin), 0o755);
  }

  if (t.os === 'unix') write(path.join(files, 'Rexarr'), UNIX_LAUNCHER, 0o755);
  if (t.os === 'windows') {
    write(path.join(files, 'rexarr.cmd'), crlf(WIN_CMD));
    write(path.join(files, 'rexarr.vbs'), crlf(WIN_VBS));
  }
  if (t.os === 'app') {
    fs.rmSync(path.join(files, 'rexarr.ico'));
    write(path.join(top, 'Contents/Info.plist'), infoPlist(target.includes('arm64') ? 'arm64' : 'x86_64'));
    write(path.join(top, 'Contents/PkgInfo'), 'APPL????');
    write(path.join(top, 'Contents/MacOS/Rexarr'), APP_LAUNCHER, 0o755);
    fs.copyFileSync(path.join(ROOT, 'logo/rexarr.icns'), path.join(top, 'Contents/Resources/Rexarr.icns'));
  } else if (t.os !== 'windows') fs.rmSync(path.join(files, 'rexarr.ico'));

  const out = path.join(OUT, `rexarr.${BRANCH}.${VERSION}.${target}.${t.archive}`);
  fs.rmSync(out, { force: true });
  if (t.archive === 'tar.gz') run('tar', ['-czf', out, '-C', work, path.basename(top)]);
  else run('zip', ['-qry9', out, path.basename(top)], work);
  log(`${path.basename(out)} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
  return out;
}

fs.mkdirSync(CACHE, { recursive: true });
log(`Rexarr ${VERSION} (${BRANCH}), Node ${NODE_VERSION}: ${selected.join(', ')}`);
const app = buildApp();
for (const target of selected) await packageTarget(target, app);
if (!flag('keep-stage')) {
  for (const d of fs.readdirSync(STAGE)) if (d.startsWith('_')) fs.rmSync(path.join(STAGE, d), { recursive: true, force: true });
}
log(`done: ${OUT}`);
