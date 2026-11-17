import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import { DashboardPage } from "@/features/dashboard/DashboardPage";
import { PlannedModulePage } from "@/features/placeholder/PlannedModulePage";
import { AudioSettingsPage } from "@/features/audio/AudioSettingsPage";
import { SongEditorPage } from "@/features/editor/SongEditorPage";
import { LivePage } from "@/features/live/LivePage";
import { SetlistsPage } from "@/features/setlists/SetlistsPage";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { SongsPage } from "@/features/songs/SongsPage";
import { StudioPage } from "@/features/studio/StudioPage";
import { MODULES } from "./modules";

/** Modules with a real page (the rest show "planned for phase N"). */
const IMPLEMENTED = ["studio", "songs", "audio-settings", "setlists", "live", "song-editor", "settings"];

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<DashboardPage />} />
        <Route path="/studio" element={<StudioPage />} />
        <Route path="/songs" element={<SongsPage />} />
        <Route path="/audio-settings" element={<AudioSettingsPage />} />
        <Route path="/setlists" element={<SetlistsPage />} />
        <Route path="/live" element={<LivePage />} />
        <Route path="/song-editor" element={<SongEditorPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        {MODULES.filter((m) => m.path !== "/" && !IMPLEMENTED.includes(m.id)).map((m) => (
          <Route key={m.id} path={m.path} element={<PlannedModulePage module={m} />} />
        ))}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

/** HashRouter: works with Tauri's custom protocol without server-side routing. */
export function App() {
  return (
    <HashRouter>
      <AppRoutes />
    </HashRouter>
  );
}
