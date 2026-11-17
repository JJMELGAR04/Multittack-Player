import { NavLink } from "react-router-dom";
import { MODULES } from "@/app/modules";

export function Sidebar() {
  return (
    <nav
      aria-label="Navegación principal"
      className="flex w-64 shrink-0 flex-col border-r border-ink-800 bg-ink-900"
    >
      <div className="flex h-16 items-center gap-2 px-5">
        <span className="h-2.5 w-2.5 rounded-full bg-live-500 shadow-[0_0_10px] shadow-live-500/70" />
        <span className="text-lg font-bold tracking-[0.2em]">LIVEPLAYER</span>
      </div>

      <ul className="flex-1 space-y-1 px-3 py-2">
        {MODULES.map(({ id, path, label, icon: Icon, phase }) => (
          <li key={id}>
            <NavLink
              to={path}
              end={path === "/"}
              className={({ isActive }) =>
                [
                  "group flex h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-ink-800 text-ink-100 shadow-[inset_3px_0_0] shadow-info-400"
                    : "text-ink-300 hover:bg-ink-850 hover:text-ink-100",
                ].join(" ")
              }
            >
              <Icon size={18} strokeWidth={2} />
              <span className="flex-1 truncate">{label}</span>
              {phase > 1 && (
                <span title={`Disponible en la Fase ${phase}`} className="whitespace-nowrap rounded bg-ink-800 px-1.5 py-0.5 text-[10px] text-ink-400 group-hover:bg-ink-700">
                  Fase {phase}
                </span>
              )}
            </NavLink>
          </li>
        ))}
      </ul>

      <div className="border-t border-ink-800 px-5 py-3 font-mono text-[11px] text-ink-400">
        v0.2.0 · Fase 2
      </div>
    </nav>
  );
}
