import { Outlet } from "react-router-dom";
import { TopNav } from "./TopNav";

export function AppShell() {
  return (
    <div className="flex h-full flex-col">
      <TopNav />
      <main className="min-h-0 flex-1 overflow-y-auto bg-ink-950">
        <Outlet />
      </main>
    </div>
  );
}
