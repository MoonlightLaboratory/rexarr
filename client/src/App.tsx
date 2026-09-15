import { URL_BASE } from './base';
import { createContext, lazy, Suspense, useContext, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import type { DiscDrive, DiscRip, HealthCheck, Job, Profile, Settings } from '@shared/types';
import { api } from './api';
import { useJobs, type Toast } from './hooks/useEvents';
import { Layout } from './components/Layout';
const MoviesPage = lazy(() => import('./pages/Movies').then((m) => ({ default: m.MoviesPage })));
const MovieDetailPage = lazy(() => import('./pages/MovieDetail').then((m) => ({ default: m.MovieDetailPage })));
const SeriesPage = lazy(() => import('./pages/Series').then((m) => ({ default: m.SeriesPage })));
const MusicPage = lazy(() => import('./pages/Music').then((m) => ({ default: m.MusicPage })));
const LocalItemPage = lazy(() => import('./pages/LocalItem').then((m) => ({ default: m.LocalItemPage })));
const ArtistPage = lazy(() => import('./pages/Music').then((m) => ({ default: m.ArtistPage })));
const SearchPage = lazy(() => import('./pages/Search').then((m) => ({ default: m.SearchPage })));
const ActivityPage = lazy(() => import('./pages/Activity').then((m) => ({ default: m.ActivityPage })));
const ProfilesPage = lazy(() => import('./pages/Profiles').then((m) => ({ default: m.ProfilesPage })));
const SettingsPage = lazy(() => import('./pages/Settings').then((m) => ({ default: m.SettingsPage })));
const SettingsGeneralPage = lazy(() => import('./pages/SettingsGeneral').then((m) => ({ default: m.SettingsGeneralPage })));
const SystemPage = lazy(() => import('./pages/System').then((m) => ({ default: m.SystemPage })));
const DiscsPage = lazy(() => import('./pages/Discs').then((m) => ({ default: m.DiscsPage })));
const TasksPage = lazy(() => import('./pages/SystemPages').then((m) => ({ default: m.TasksPage })));
const BackupPage = lazy(() => import('./pages/SystemPages').then((m) => ({ default: m.BackupPage })));
const EventsPage = lazy(() => import('./pages/SystemPages').then((m) => ({ default: m.EventsPage })));
const LogsPage = lazy(() => import('./pages/SystemPages').then((m) => ({ default: m.LogsPage })));

export interface AppState {
  jobs: Job[];
  rips: DiscRip[];
  drives: DiscDrive[];
  /** Activity → Pause: nothing new starts. */
  queuePaused: boolean;
  profiles: Profile[];
  settings: Settings | null;
  health: HealthCheck[];
  /** False until the first health check has answered (it can take a few seconds on slow shares). */
  healthLoaded: boolean;
  reloadHealth: () => Promise<void>;
  reloadProfiles: () => Promise<void>;
  reloadSettings: () => Promise<void>;
  toast: (level: Toast['level'], message: string) => void;
}

const Ctx = createContext<AppState>(null as unknown as AppState);
export const useApp = () => useContext(Ctx);

export default function App() {
  const { jobs, rips, drives, connected, queuePaused, toasts, toast, toastControls } = useJobs();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [health, setHealth] = useState<HealthCheck[]>([]);
  const [healthLoaded, setHealthLoaded] = useState(false);
  const reloadHealth = async () => {
    setHealth(await api.health());
    setHealthLoaded(true);
  };

  const reloadProfiles = async () => setProfiles(await api.profiles());
  const reloadSettings = async () => setSettings(await api.settings());

  useEffect(() => {
    reloadProfiles().catch((e) => toast('error', `Could not load profiles: ${e.message}`));
    reloadSettings().catch((e) => toast('error', `Could not load settings: ${e.message}`));
    reloadHealth().catch(() => {});
    api.discStatus().catch(() => {}); // pushes a 'drives' event so the sidebar knows the drive state
    const t = setInterval(() => reloadHealth().catch(() => {}), 5 * 60_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Ctx.Provider value={{ jobs, rips, drives, queuePaused, profiles, settings, health, healthLoaded, reloadHealth, reloadProfiles, reloadSettings, toast }}>
      <BrowserRouter basename={URL_BASE || undefined}>
        <Layout jobs={jobs} rips={rips} drives={drives} health={health} connected={connected} toasts={toasts} toastControls={toastControls}>
          <Suspense fallback={<div className="pageToolbar" />}>
          <Routes>
            <Route path="/" element={<Navigate to="/movies" replace />} />
            <Route path="/movies" element={<MoviesPage />} />
            <Route path="/movies/:id" element={<MovieDetailPage />} />
            <Route path="/series" element={<SeriesPage />} />
            <Route path="/series/:id" element={<SeriesPage />} />
            <Route path="/music" element={<MusicPage />} />
            <Route path="/music/artist/:id" element={<ArtistPage />} />
            <Route path="/local/:id" element={<LocalItemPage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/activity" element={<ActivityPage />} />
            <Route path="/discs" element={<DiscsPage />} />
            <Route path="/profiles" element={<ProfilesPage />} />
            <Route path="/profiles/:id" element={<ProfilesPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/settings/general" element={<SettingsGeneralPage />} />
            <Route path="/system" element={<SystemPage />} />
            <Route path="/system/tasks" element={<TasksPage />} />
            <Route path="/system/backup" element={<BackupPage />} />
            <Route path="/system/events" element={<EventsPage />} />
            <Route path="/system/logs" element={<LogsPage />} />
            <Route path="*" element={<Navigate to="/movies" replace />} />
          </Routes>
          </Suspense>
        </Layout>
      </BrowserRouter>
    </Ctx.Provider>
  );
}
