import { store } from '../store.js';
import { Radarr } from './radarr.js';
import { Sonarr } from './sonarr.js';
import { Prowlarr } from './prowlarr.js';
import { Lidarr } from './lidarr.js';
import { Slskd } from './slskd.js';

/** Fresh clients built from the current settings (settings can change at runtime). */
export function arr() {
  const s = store.settings;
  return {
    radarr: new Radarr(s.radarr),
    sonarr: new Sonarr(s.sonarr),
    prowlarr: new Prowlarr(s.prowlarr),
    lidarr: new Lidarr(s.lidarr),
    slskd: new Slskd(s.slskd),
  };
}
