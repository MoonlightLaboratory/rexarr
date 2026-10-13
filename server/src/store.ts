import { withGeneralDefaults } from './general.js';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import type { Agent, DiscRip, ExpectedDisc, Job, Profile, Settings, SmartProfile } from '../../shared/types.js';
import { BUILTIN_PROFILES, BUILTIN_SMART_PROFILES, DEFAULT_SETTINGS } from '../../shared/presets.js';

interface Persisted<T> {
  file: string;
  value: T;
  timer: NodeJS.Timeout | null;
}

function load<T>(name: string, fallback: T): Persisted<T> {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, name);
  let value = fallback;
  if (fs.existsSync(file)) {
    try {
      value = JSON.parse(fs.readFileSync(file, 'utf8')) as T;
    } catch (err) {
      console.error(`[store] could not parse ${file}, using defaults`, err);
    }
  }
  return { file, value, timer: null };
}

function save<T>(p: Persisted<T>) {
  if (p.timer) return;
  p.timer = setTimeout(() => {
    p.timer = null;
    // unique temp name: parallel processes (tests, a second instance) must not rename each other's file
    const tmp = `${p.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(p.value, null, 2));
    fs.renameSync(tmp, p.file);
  }, 150);
}

function flush<T>(p: Persisted<T>) {
  if (p.timer) {
    clearTimeout(p.timer);
    p.timer = null;
  }
  const tmp = `${p.file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(p.value, null, 2));
  fs.renameSync(tmp, p.file);
}

const settingsP = load<Settings>('settings.json', structuredClone(DEFAULT_SETTINGS) as Settings);
const profilesP = load<Profile[]>('profiles.json', []);
const smartP = load<SmartProfile[]>('smart-profiles.json', []);
const jobsP = load<Job[]>('jobs.json', []);
const ripsP = load<DiscRip[]>('rips.json', []);
const expectedP = load<ExpectedDisc[]>('expected-discs.json', []);
const agentsP = load<Agent[]>('agents.json', []);

// Merge defaults for settings keys added in later versions.
settingsP.value = {
  ...structuredClone(DEFAULT_SETTINGS),
  ...settingsP.value,
  radarr: { ...DEFAULT_SETTINGS.radarr, ...(settingsP.value.radarr ?? {}) },
  sonarr: { ...DEFAULT_SETTINGS.sonarr, ...(settingsP.value.sonarr ?? {}) },
  prowlarr: { ...DEFAULT_SETTINGS.prowlarr, ...(settingsP.value.prowlarr ?? {}) },
  lidarr: { ...DEFAULT_SETTINGS.lidarr, ...(settingsP.value.lidarr ?? {}) },
  slskd: { ...DEFAULT_SETTINGS.slskd, ...(settingsP.value.slskd ?? {}) },
  localMedia: { ...DEFAULT_SETTINGS.localMedia, ...(settingsP.value.localMedia ?? {}) },
  musicbrainz: { ...DEFAULT_SETTINGS.musicbrainz, ...(settingsP.value.musicbrainz ?? {}) },
  thediscdb: { ...DEFAULT_SETTINGS.thediscdb, ...(settingsP.value.thediscdb ?? {}) },
  omdb: { ...DEFAULT_SETTINGS.omdb, ...(settingsP.value.omdb ?? {}) },
  cddb: { ...DEFAULT_SETTINGS.cddb, ...(settingsP.value.cddb ?? {}) },
  ocr: { ...DEFAULT_SETTINGS.ocr, ...(settingsP.value.ocr ?? {}) },
  agents: { ...DEFAULT_SETTINGS.agents, ...(settingsP.value.agents ?? {}) },
  notifications: { targets: settingsP.value.notifications?.targets ?? [] },
  experiments: { ...DEFAULT_SETTINGS.experiments, ...(settingsP.value.experiments ?? {}) },
  disc: { ...DEFAULT_SETTINGS.disc, ...(settingsP.value.disc ?? {}), cd: { ...DEFAULT_SETTINGS.disc.cd, ...(settingsP.value.disc?.cd ?? {}) } },
  anidb: { ...DEFAULT_SETTINGS.anidb, ...(settingsP.value.anidb ?? {}) },
  transcoding: { ...DEFAULT_SETTINGS.transcoding, ...(settingsP.value.transcoding ?? {}) },
  auto: {
    ...DEFAULT_SETTINGS.auto,
    ...(settingsP.value.auto ?? {}),
    sources: { ...DEFAULT_SETTINGS.auto.sources, ...(settingsP.value.auto?.sources ?? {}) },
    profiles: { ...DEFAULT_SETTINGS.auto.profiles, ...(settingsP.value.auto?.profiles ?? {}) },
  },
  defaultProfiles: { ...DEFAULT_SETTINGS.defaultProfiles, ...(settingsP.value.defaultProfiles ?? {}) },
} as Settings;
/**
 * `audio.firstMatchOnly` became `audio.perLanguage`, which can also keep the best or the smallest track rather
 * than whichever the file listed first. The old value says exactly one of the new ones, so it is rewritten once.
 */
function migratePerLanguage(): boolean {
  let changed = false;
  for (const p of profilesP.value) {
    if (p.audio && p.audio.perLanguage === undefined) {
      p.audio.perLanguage = p.audio.firstMatchOnly ? 'first' : 'all';
      delete p.audio.firstMatchOnly;
      changed = true;
    }
  }
  for (const sp of smartP.value) {
    for (const list of [sp.base, ...sp.rules.map((r) => r.set)]) {
      for (const a of list ?? []) {
        if (a.path !== 'audio.firstMatchOnly') continue;
        a.path = 'audio.perLanguage';
        a.value = a.value ? 'first' : 'all';
        changed = true;
      }
    }
  }
  return changed;
}
if (migratePerLanguage()) {
  save(profilesP);
  save(smartP);
}

const hadApiKey = Boolean(settingsP.value.general?.security?.apiKey);
settingsP.value.general = withGeneralDefaults(settingsP.value);
let settingsChanged = !hadApiKey; // a new API key must be persisted
if (process.env.REXARR_RESET_AUTH === '1' || process.env.REXARR_RESET_AUTH === 'true') {
  // Locked out: turn authentication off (the password is kept, so it can be switched back on).
  settingsP.value.general.security.authentication = 'none';
  settingsChanged = true;
  console.warn('[auth] REXARR_RESET_AUTH set: authentication disabled');
}
if (settingsChanged) save(settingsP);

export const store = {
  get settings(): Settings {
    return settingsP.value;
  },
  saveSettings(next: Settings) {
    settingsP.value = next;
    save(settingsP);
  },

  /** Custom (user) profiles only. */
  get customProfiles(): Profile[] {
    return profilesP.value;
  },
  /** Built-in presets followed by user profiles. */
  get profiles(): Profile[] {
    return [...BUILTIN_PROFILES, ...profilesP.value];
  },
  getProfile(id: string): Profile | undefined {
    return this.profiles.find((p) => p.id === id);
  },

  // ---- smart profiles: a profile chosen per file, from what the file turned out to contain ----
  /** Custom (user) smart profiles only. */
  get ownSmartProfiles(): SmartProfile[] {
    return smartP.value;
  },
  get smartProfiles(): SmartProfile[] {
    return [...BUILTIN_SMART_PROFILES, ...smartP.value];
  },
  getSmartProfile(id: string): SmartProfile | undefined {
    return this.smartProfiles.find((p) => p.id === id);
  },
  saveSmartProfile(profile: SmartProfile) {
    const idx = smartP.value.findIndex((p) => p.id === profile.id);
    if (idx >= 0) smartP.value[idx] = profile;
    else smartP.value.push(profile);
    save(smartP);
  },
  // ---- rip farm: the agents that report in ----
  get agents(): Agent[] {
    return agentsP.value;
  },
  saveAgent(agent: Agent) {
    const i = agentsP.value.findIndex((a) => a.id === agent.id);
    if (i >= 0) agentsP.value[i] = agent;
    else agentsP.value.push(agent);
    save(agentsP);
  },
  deleteAgent(id: string) {
    agentsP.value = agentsP.value.filter((a) => a.id !== id);
    save(agentsP);
  },

  deleteSmartProfile(id: string) {
    smartP.value = smartP.value.filter((p) => p.id !== id);
    save(smartP);
  },
  /** Either kind, by id: a smart profile may be chosen anywhere a profile may be. */
  anyProfile(id: string): { id: string; name: string; profile?: Profile; smart?: SmartProfile } | undefined {
    const profile = this.getProfile(id);
    if (profile) return { id: profile.id, name: profile.name, profile };
    const smart = this.getSmartProfile(id);
    return smart ? { id: smart.id, name: smart.name, smart } : undefined;
  },
  upsertProfile(profile: Profile) {
    const idx = profilesP.value.findIndex((p) => p.id === profile.id);
    if (idx >= 0) profilesP.value[idx] = profile;
    else profilesP.value.push(profile);
    save(profilesP);
  },
  deleteProfile(id: string) {
    profilesP.value = profilesP.value.filter((p) => p.id !== id);
    save(profilesP);
  },

  get jobs(): Job[] {
    return jobsP.value;
  },
  setJobs(jobs: Job[]) {
    jobsP.value = jobs;
    save(jobsP);
  },
  saveJobs() {
    save(jobsP);
  },

  /** Discs a barcode scan said are coming, but that have not been put in a drive yet. */
  get expectedDiscs(): ExpectedDisc[] {
    return expectedP.value;
  },
  setExpectedDiscs(list: ExpectedDisc[]) {
    expectedP.value = list;
    save(expectedP);
  },

  get rips(): DiscRip[] {
    return ripsP.value;
  },
  setRips(rips: DiscRip[]) {
    ripsP.value = rips;
    save(ripsP);
  },
  saveRips() {
    save(ripsP);
  },
  flushAll() {
    flush(settingsP);
    flush(profilesP);
    flush(agentsP);
    flush(smartP);
    flush(jobsP);
    flush(ripsP);
  },
};
