/** MQA scan results cached by path + size + mtime (data/mqa.json). */
import fs from 'node:fs';
import path from 'node:path';
import type { MqaInfo } from '../../../shared/types.js';
import { DATA_DIR } from '../config.js';
import { store } from '../store.js';
import { detectMqa } from './mqa.js';
import { probeAudio } from '../music/freac.js';

const MQA_FILE = path.join(DATA_DIR, 'mqa.json');
let mqaCache: Record<string, MqaInfo & { key: string }> = {};
try {
  if (fs.existsSync(MQA_FILE)) mqaCache = JSON.parse(fs.readFileSync(MQA_FILE, 'utf8'));
} catch {
  mqaCache = {};
}
let mqaSaveTimer: NodeJS.Timeout | null = null;
function saveMqa() {
  if (mqaSaveTimer) return;
  mqaSaveTimer = setTimeout(() => {
    mqaSaveTimer = null;
    fs.writeFileSync(MQA_FILE, JSON.stringify(mqaCache));
  }, 1000);
}
const fileKey = (p: string) => {
  try {
    const st = fs.statSync(p);
    return `${st.size}:${Math.round(st.mtimeMs)}`;
  } catch {
    return '';
  }
};

export function cachedMqa(localPath: string): MqaInfo | undefined {
  const hit = mqaCache[localPath];
  return hit && hit.key === fileKey(localPath) ? hit : undefined;
}

/** Scan a file for MQA (cached). Only lossless stereo files can carry MQA. */
export async function scanMqa(localPath: string): Promise<MqaInfo> {
  const cached = cachedMqa(localPath);
  if (cached) return cached;
  const info = await probeAudio(store.settings.ffprobePath, localPath);
  const result: MqaInfo = info.lossless && info.channels === 2 ? await detectMqa(store.settings.ffmpegPath, localPath, { sampleRate: info.sampleRate, channels: 2 }) : { detected: false, scannedSeconds: 0 };
  mqaCache[localPath] = { ...result, key: fileKey(localPath) };
  saveMqa();
  return result;
}

