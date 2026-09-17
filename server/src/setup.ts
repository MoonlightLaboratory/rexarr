/**
 * Recommended external programs: whether each is found, and how to install it on this platform.
 * Shown on first launch (until closed) and under System → Tools.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { SetupPlatform, SetupStep, SetupTool, SetupTools } from '../../shared/types.js';
import { DATA_DIR } from './config.js';
import { IN_DOCKER } from './general.js';
import { store } from './store.js';
import { ffmpegCapabilities } from './ffmpeg/capabilities.js';
import { freacInfo } from './music/freac.js';
import { makemkvInfo } from './disc/makemkv.js';
import { testConnection } from './routes/settings.js';

const STATE_FILE = path.join(DATA_DIR, 'setup.json');

const URLS = {
  ffmpegWindows: 'https://www.gyan.dev/ffmpeg/builds/',
  ffmpegMac: 'https://evermeet.cx/ffmpeg/',
  ffmpegLinux: 'https://ffmpeg.org/download.html#build-linux',
  freac: 'https://github.com/enzo1982/freac/releases/latest',
  makemkv: 'https://www.makemkv.com/download/',
  makemkvLinux: 'https://forum.makemkv.com/forum/viewtopic.php?f=3&t=224',
  slskd: 'https://github.com/slskd/slskd/releases/latest',
  slskdGuide: 'https://github.com/slskd/slskd#quick-start',
};

const SLSKD_DOCKER = 'docker run -d --name slskd -p 5030:5030 -p 50300:50300 -e SLSKD_REMOTE_CONFIGURATION=true -v ./slskd:/app slskd/slskd';

export function setupPlatform(): SetupPlatform {
  if (IN_DOCKER) return 'docker';
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'freebsd') return 'freebsd';
  return 'linux';
}

const INSTALL: Record<SetupPlatform, Record<SetupTool['id'], { steps: SetupStep[]; note?: string }>> = {
  windows: {
    ffmpeg: {
      steps: [
        { label: 'Install with winget', command: 'winget install --id Gyan.FFmpeg -e' },
        { label: 'Or download a "release full" build, extract it and set Settings → FFmpeg path to its bin\\ffmpeg.exe', url: URLS.ffmpegWindows },
      ],
      note: 'Restart Rexarr after installing so it picks up the new PATH.',
    },
    freac: {
      steps: [
        { label: 'Install with winget', command: 'winget install --id enzo1982.freac -e' },
        { label: 'Or download the Windows installer (freac-…-windows-x64.exe)', url: URLS.freac },
      ],
    },
    makemkv: {
      steps: [
        { label: 'Install with winget', command: 'winget install --id GuinpinSoft.MakeMKV -e' },
        { label: 'Or download MakeMKV for Windows', url: URLS.makemkv },
      ],
    },
    slskd: {
      steps: [
        { label: 'Download slskd-…-win-x64.zip, extract it and run slskd.exe', url: URLS.slskd },
        { label: 'Setup guide (username, API key in slskd.yml)', url: URLS.slskdGuide },
      ],
    },
  },
  macos: {
    ffmpeg: {
      steps: [
        { label: 'Install with Homebrew', command: 'brew install ffmpeg' },
        { label: 'Or download static ffmpeg and ffprobe builds', url: URLS.ffmpegMac },
      ],
    },
    freac: {
      steps: [
        { label: 'Install with Homebrew', command: 'brew install --cask freac' },
        { label: 'Or download the macOS disk image (freac-…-macos11.dmg)', url: URLS.freac },
      ],
    },
    makemkv: {
      steps: [
        { label: 'Install with Homebrew', command: 'brew install --cask makemkv' },
        { label: 'Or download MakeMKV for macOS', url: URLS.makemkv },
      ],
    },
    slskd: {
      steps: [
        { label: 'Download slskd-…-osx-arm64.zip (Apple silicon) or osx-x64 (Intel)', url: URLS.slskd },
        { label: 'Setup guide (username, API key in slskd.yml)', url: URLS.slskdGuide },
      ],
    },
  },
  linux: {
    ffmpeg: {
      steps: [
        { label: 'Debian / Ubuntu', command: 'sudo apt install ffmpeg' },
        { label: 'Fedora (RPM Fusion)', command: 'sudo dnf install ffmpeg' },
        { label: 'Arch', command: 'sudo pacman -S ffmpeg' },
        { label: 'Or a static build', url: URLS.ffmpegLinux },
      ],
    },
    freac: {
      steps: [
        { label: 'Debian / Ubuntu', command: 'sudo apt install freac cdparanoia' },
        { label: 'Other distributions: fre:ac downloads', url: URLS.freac },
      ],
      note: 'cdparanoia is only needed for audio CD ripping.',
    },
    makemkv: {
      steps: [
        { label: 'Build MakeMKV from source (official instructions)', url: URLS.makemkvLinux },
        { label: 'Downloads and beta key', url: URLS.makemkv },
      ],
    },
    slskd: {
      steps: [
        { label: 'Run slskd with Docker', command: SLSKD_DOCKER },
        { label: 'Or download slskd-…-linux-x64.zip', url: URLS.slskd },
        { label: 'Setup guide', url: URLS.slskdGuide },
      ],
    },
  },
  freebsd: {
    ffmpeg: { steps: [{ label: 'Install with pkg', command: 'pkg install ffmpeg' }] },
    freac: { steps: [{ label: 'Download freac-…-freebsd-x64.tar.gz', url: URLS.freac }] },
    makemkv: { steps: [{ label: 'MakeMKV has no FreeBSD build; rip discs with Rexarr on Windows, macOS or Linux', url: URLS.makemkv }] },
    slskd: { steps: [{ label: 'Run slskd on another machine (Docker, Linux, Windows or macOS) and connect to it', url: URLS.slskdGuide }] },
  },
  docker: {
    ffmpeg: { steps: [], note: 'Included in the Rexarr image.' },
    freac: { steps: [], note: 'Included in the Rexarr image (without the WavPack and Monkey\'s Audio encoders).' },
    makemkv: {
      steps: [
        { label: 'Build the Rexarr image with MakeMKV and pass your drive with --device /dev/sr0 --device /dev/sg0', command: 'docker build -f docker/Dockerfile.makemkv -t rexarr:makemkv .' },
        { label: 'MakeMKV beta key', url: URLS.makemkv },
      ],
    },
    slskd: {
      steps: [
        { label: 'Run slskd next to Rexarr', command: SLSKD_DOCKER },
        { label: 'Setup guide', url: URLS.slskdGuide },
      ],
    },
  },
};

function readState(): { dismissed?: boolean } {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as { dismissed?: boolean };
  } catch {
    return {};
  }
}

export function setDismissed(dismissed: boolean) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...readState(), dismissed, at: new Date().toISOString() }, null, 2));
}

export async function setupTools(refresh = false): Promise<SetupTools> {
  const s = store.settings;
  const platform = setupPlatform();
  const [ffmpeg, freac, makemkv, slskd] = await Promise.all([
    ffmpegCapabilities(s.ffmpegPath, refresh),
    freacInfo(s.freacPath, refresh),
    makemkvInfo(s.disc.makemkvPath, refresh),
    testConnection('slskd', s.slskd),
  ]);
  const tool = (id: SetupTool['id'], base: Omit<SetupTool, 'id' | 'steps' | 'note'>): SetupTool => ({ id, ...base, ...INSTALL[platform][id] });
  return {
    platform,
    dismissed: Boolean(readState().dismissed),
    tools: [
      tool('ffmpeg', {
        name: 'FFmpeg',
        purpose: 'Encodes video and audio, reads media details and makes previews. Rexarr cannot transcode without it.',
        required: true,
        available: ffmpeg.available,
        detail: ffmpeg.available ? ffmpeg.version : ffmpeg.error,
      }),
      tool('freac', {
        name: 'fre:ac',
        purpose: 'Music profiles, audio CD ripping, and splitting single-file albums with a cue sheet so Lidarr can import them.',
        required: false,
        available: freac.available,
        detail: freac.available ? freac.version : freac.error,
      }),
      tool('makemkv', {
        name: 'MakeMKV',
        purpose: 'Rips DVDs and Blu-rays, and full-disc downloads (ISO, BDMV, VIDEO_TS). Free while in beta; Blu-ray needs the current beta key or a licence.',
        required: false,
        available: makemkv.available,
        detail: makemkv.available ? makemkv.version : makemkv.error,
      }),
      tool('slskd', {
        name: 'slskd',
        purpose: 'Soulseek album search on the Music pages. It runs as its own server; connect it under Settings → Connections.',
        required: false,
        available: slskd.configured && slskd.ok,
        detail: slskd.ok ? (slskd.version ? `connected, v${slskd.version}` : 'connected') : slskd.configured ? slskd.error : 'not connected',
      }),
    ],
  };
}
