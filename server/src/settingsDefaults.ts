/**
 * Defaults for settings added in later versions, merged over what is on disk.
 *
 * A spread only reaches the top level, so every nested group has to say so itself - and a group left off this
 * list silently loses its new fields until the next save rewrites them from the save schema's defaults. That
 * has now happened twice, so `everyNestedKeySurvives` in the test walks the whole of DEFAULT_SETTINGS and
 * fails if any group here is missing one.
 */
import type { Settings } from '../../shared/types.js';
import { DEFAULT_SETTINGS } from '../../shared/presets.js';

export function withDefaults(saved: Partial<Settings>): Settings {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    ...saved,

  general: {
    ...DEFAULT_SETTINGS.general,
    ...(saved.general ?? {}),
    host: { ...DEFAULT_SETTINGS.general.host, ...(saved.general?.host ?? {}) },
    security: { ...DEFAULT_SETTINGS.general.security, ...(saved.general?.security ?? {}) },
    proxy: { ...DEFAULT_SETTINGS.general.proxy, ...(saved.general?.proxy ?? {}) },
    logging: { ...DEFAULT_SETTINGS.general.logging, ...(saved.general?.logging ?? {}) },
    updates: { ...DEFAULT_SETTINGS.general.updates, ...(saved.general?.updates ?? {}) },
    backups: { ...DEFAULT_SETTINGS.general.backups, ...(saved.general?.backups ?? {}) },
  },
  fileMetadata: { ...DEFAULT_SETTINGS.fileMetadata, ...(saved.fileMetadata ?? {}) },
  radarr: { ...DEFAULT_SETTINGS.radarr, ...(saved.radarr ?? {}) },
  sonarr: { ...DEFAULT_SETTINGS.sonarr, ...(saved.sonarr ?? {}) },
  prowlarr: { ...DEFAULT_SETTINGS.prowlarr, ...(saved.prowlarr ?? {}) },
  bazarr: { ...DEFAULT_SETTINGS.bazarr, ...(saved.bazarr ?? {}) },
  lidarr: { ...DEFAULT_SETTINGS.lidarr, ...(saved.lidarr ?? {}) },
  slskd: { ...DEFAULT_SETTINGS.slskd, ...(saved.slskd ?? {}) },
  localMedia: { ...DEFAULT_SETTINGS.localMedia, ...(saved.localMedia ?? {}) },
  musicbrainz: { ...DEFAULT_SETTINGS.musicbrainz, ...(saved.musicbrainz ?? {}) },
  thediscdb: { ...DEFAULT_SETTINGS.thediscdb, ...(saved.thediscdb ?? {}) },
  omdb: { ...DEFAULT_SETTINGS.omdb, ...(saved.omdb ?? {}) },
  rexdb: { ...DEFAULT_SETTINGS.rexdb, ...(saved.rexdb ?? {}) },
  cddb: { ...DEFAULT_SETTINGS.cddb, ...(saved.cddb ?? {}) },
  ocr: { ...DEFAULT_SETTINGS.ocr, ...(saved.ocr ?? {}) },
  agents: { ...DEFAULT_SETTINGS.agents, ...(saved.agents ?? {}) },
  notifications: { targets: saved.notifications?.targets ?? [] },
  experiments: { ...DEFAULT_SETTINGS.experiments, ...(saved.experiments ?? {}) },
  disc: { ...DEFAULT_SETTINGS.disc, ...(saved.disc ?? {}), cd: { ...DEFAULT_SETTINGS.disc.cd, ...(saved.disc?.cd ?? {}) } },
  anidb: { ...DEFAULT_SETTINGS.anidb, ...(saved.anidb ?? {}) },
  transcoding: { ...DEFAULT_SETTINGS.transcoding, ...(saved.transcoding ?? {}) },
  auto: {
    ...DEFAULT_SETTINGS.auto,
    ...(saved.auto ?? {}),
    sources: { ...DEFAULT_SETTINGS.auto.sources, ...(saved.auto?.sources ?? {}) },
    profiles: { ...DEFAULT_SETTINGS.auto.profiles, ...(saved.auto?.profiles ?? {}) },
  },
  defaultProfiles: { ...DEFAULT_SETTINGS.defaultProfiles, ...(saved.defaultProfiles ?? {}) },
  } as Settings;
}
