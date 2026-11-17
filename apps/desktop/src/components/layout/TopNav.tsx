import { NavLink } from "react-router-dom";
import { MODULES } from "@/app/modules";

/** Phase whose modules are already functional; later ones are shown dimmed. */
const CURRENT_PHASE = 5;

/** Main navigation as a horizontal bar at the top of the window. */
export function TopNav() {
  return (
    <header className="flex h-14 shrink-0 items-center gap-4 border-b border-ink-800 bg-ink-900 px-4">
      <div className="flex shrink-0 items-center gap-2">
        <span className="h-2.5 w-2.5 rounded-full bg-live-500 shadow-[0_0_10px] shadow-live-500/70" />
        <span className="text-base font-bold tracking-[0.2em]">LIVEPLAYER</span>
      </div>

      <nav aria-label="Navegación principal" className="min-w-0 flex-1">
        <ul className="flex items-center justify-center gap-1">
          {MODULES.map(({ id, path, label, icon: Icon, phase }) => {
            const planned = phase > CURRENT_PHASE;
            return (
              <li key={id}>
                <NavLink
                  to={path}
                  end={path === "/"}
                  title={planned ? `${label} · disponible en la Fase ${phase}` : label}
                  className={({ isActive }) =>
                    [
                      "flex h-10 items-center gap-2 rounded-lg px-3 text-[13px] font-medium whitespace-nowrap transition-colors",
                      isActive
                        ? "bg-ink-800 text-ink-100 shadow-[inset_0_-2px_0] shadow-info-400"
                        : planned
                          ? "text-ink-400 hover:bg-ink-850 hover:text-ink-300"
                          : "text-ink-300 hover:bg-ink-850 hover:text-ink-100",
                    ].join(" ")
                  }
                >
                  <Icon size={17} strokeWidth={2} />
                  <span className="hidden xl:inline">{label}</span>
                </NavLink>
              </li>
            );
          })}
        </ul>
      </nav>

      <span className="shrink-0 font-mono text-[11px] text-ink-400">v0.5.0 · Fase 5</span>
    </header>
  );
}
