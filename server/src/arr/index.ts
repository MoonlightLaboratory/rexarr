import { store } from '../store.js';
import { Radarr } from './radarr.js';
import { Sonarr } from './sonarr.js';
import { Prowlarr } from './prowlarr.js';

/** Fresh clients built from the current settings (settings can change at runtime). */
export function arr() {
  const s = store.settings;
  return {
    radarr: new Radarr(s.radarr),
    sonarr: new Sonarr(s.sonarr),
    prowlarr: new Prowlarr(s.prowlarr),
  };
}
