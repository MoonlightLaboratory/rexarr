import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import type { DiscRip, Job, Profile, Settings } from '../../shared/types.js';
import { BUILTIN_PROFILES, DEFAULT_SETTINGS } from '../../shared/presets.js';

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
    const tmp = `${p.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(p.value, null, 2));
    fs.renameSync(tmp, p.file);
  }, 150);
}

function flush<T>(p: Persisted<T>) {
  if (p.timer) {
    clearTimeout(p.timer);
    p.timer = null;
  }
  const tmp = `${p.file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(p.value, null, 2));
  fs.renameSync(tmp, p.file);
}

const settingsP = load<Settings>('settings.json', structuredClone(DEFAULT_SETTINGS) as Settings);
const profilesP = load<Profile[]>('profiles.json', []);
const jobsP = load<Job[]>('jobs.json', []);
const ripsP = load<DiscRip[]>('rips.json', []);

// Merge defaults for settings keys added in later versions.
settingsP.value = {
  ...structuredClone(DEFAULT_SETTINGS),
  ...settingsP.value,
  radarr: { ...DEFAULT_SETTINGS.radarr, ...(settingsP.value.radarr ?? {}) },
  sonarr: { ...DEFAULT_SETTINGS.sonarr, ...(settingsP.value.sonarr ?? {}) },
  prowlarr: { ...DEFAULT_SETTINGS.prowlarr, ...(settingsP.value.prowlarr ?? {}) },
  disc: { ...DEFAULT_SETTINGS.disc, ...(settingsP.value.disc ?? {}) },
  defaultProfiles: { ...DEFAULT_SETTINGS.defaultProfiles, ...(settingsP.value.defaultProfiles ?? {}) },
} as Settings;

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
    flush(jobsP);
    flush(ripsP);
  },
};
