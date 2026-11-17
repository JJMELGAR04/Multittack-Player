import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import { DashboardPage } from "@/features/dashboard/DashboardPage";
import { PlannedModulePage } from "@/features/placeholder/PlannedModulePage";
import { StudioPage } from "@/features/studio/StudioPage";
import { MODULES } from "./modules";

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<DashboardPage />} />
        <Route path="/studio" element={<StudioPage />} />
        {MODULES.filter((m) => m.path !== "/" && m.id !== "studio").map((m) => (
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
