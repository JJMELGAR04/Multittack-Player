import { Outlet } from "react-router-dom";
import { DeviceBanner } from "@/features/audio/DeviceBanner";
import { TopNav } from "./TopNav";

export function AppShell() {
  return (
    <div className="flex h-full flex-col">
      <TopNav />
      <DeviceBanner />
      <main className="min-h-0 flex-1 overflow-y-auto bg-ink-950">
        <Outlet />
      </main>
    </div>
  );
}
