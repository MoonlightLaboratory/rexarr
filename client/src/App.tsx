import { createContext, useContext, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import type { DiscDrive, DiscRip, HealthCheck, Job, Profile, Settings } from '@shared/types';
import { api } from './api';
import { useJobs, type Toast } from './hooks/useEvents';
import { Layout } from './components/Layout';
import { MoviesPage } from './pages/Movies';
import { MovieDetailPage } from './pages/MovieDetail';
import { SeriesPage } from './pages/Series';
import { SearchPage } from './pages/Search';
import { ActivityPage } from './pages/Activity';
import { ProfilesPage } from './pages/Profiles';
import { SettingsPage } from './pages/Settings';
import { SystemPage } from './pages/System';
import { DiscsPage } from './pages/Discs';

export interface AppState {
  jobs: Job[];
  rips: DiscRip[];
  drives: DiscDrive[];
  profiles: Profile[];
  settings: Settings | null;
  health: HealthCheck[];
  reloadHealth: () => Promise<void>;
  reloadProfiles: () => Promise<void>;
  reloadSettings: () => Promise<void>;
  toast: (level: Toast['level'], message: string) => void;
}

const Ctx = createContext<AppState>(null as unknown as AppState);
export const useApp = () => useContext(Ctx);

export default function App() {
  const { jobs, rips, drives, connected, toasts, toast } = useJobs();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [health, setHealth] = useState<HealthCheck[]>([]);
  const reloadHealth = async () => setHealth(await api.health());

  const reloadProfiles = async () => setProfiles(await api.profiles());
  const reloadSettings = async () => setSettings(await api.settings());

  useEffect(() => {
    reloadProfiles().catch((e) => toast('error', `Could not load profiles: ${e.message}`));
    reloadSettings().catch((e) => toast('error', `Could not load settings: ${e.message}`));
    reloadHealth().catch(() => {});
    const t = setInterval(() => reloadHealth().catch(() => {}), 5 * 60_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Ctx.Provider value={{ jobs, rips, drives, profiles, settings, health, reloadHealth, reloadProfiles, reloadSettings, toast }}>
      <BrowserRouter>
        <Layout jobs={jobs} rips={rips} health={health} connected={connected} toasts={toasts}>
          <Routes>
            <Route path="/" element={<Navigate to="/movies" replace />} />
            <Route path="/movies" element={<MoviesPage />} />
            <Route path="/movies/:id" element={<MovieDetailPage />} />
            <Route path="/series" element={<SeriesPage />} />
            <Route path="/series/:id" element={<SeriesPage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/activity" element={<ActivityPage />} />
            <Route path="/discs" element={<DiscsPage />} />
            <Route path="/profiles" element={<ProfilesPage />} />
            <Route path="/profiles/:id" element={<ProfilesPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/system" element={<SystemPage />} />
            <Route path="*" element={<Navigate to="/movies" replace />} />
          </Routes>
        </Layout>
      </BrowserRouter>
    </Ctx.Provider>
  );
}
