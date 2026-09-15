/** What the HTTP server is running with right now, and a way to restart it (Settings → General host changes). */
import type { HostRuntime } from '../../shared/types.js';
import { CONFIG_DIR, PATHS } from './config.js';
import { store } from './store.js';
import { effectiveHost, envHost, IN_DOCKER } from './general.js';

export const running = { bindAddress: '*', port: 0, urlBase: '', sslPort: undefined as number | undefined, sslKey: '' };

let restartHandler: (() => Promise<void>) | null = null;
let logLevelHandler: ((level: string) => void) | null = null;
export function onLogLevel(fn: (level: string) => void) {
  logLevelHandler = fn;
}
export function applyLogLevel(level: string) {
  logLevelHandler?.(level);
}
export function onRestart(fn: () => Promise<void>) {
  restartHandler = fn;
}
export async function restart() {
  if (!restartHandler) throw new Error('restart is not available');
  await restartHandler();
}

/** Fingerprint of the SSL settings, to tell whether a restart would change anything. */
export function sslFingerprint() {
  const h = store.settings.general.host;
  return h.enableSsl ? JSON.stringify([h.sslPort, h.sslCertPath, h.sslKeyPath, h.sslCertPassword]) : '';
}

export function hostRuntime(): HostRuntime {
  const want = effectiveHost(store.settings.general);
  const env = envHost();
  return {
    bindAddress: running.bindAddress,
    port: running.port,
    urlBase: running.urlBase,
    sslPort: running.sslPort,
    envOverrides: Object.keys(env),
    docker: IN_DOCKER,
    restartRequired: want.bindAddress !== running.bindAddress || want.port !== running.port || want.urlBase !== running.urlBase || sslFingerprint() !== running.sslKey,
    configDir: CONFIG_DIR,
    defaultBackupFolder: PATHS.backups,
  };
}
