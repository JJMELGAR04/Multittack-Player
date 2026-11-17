import { ChevronLeft, ChevronRight, Pencil, Play, Plus, Sparkles, Trash2 } from "lucide-react";
import type { SectionKind, SectionRecord } from "@/lib/ipc/types";
import { formatTime, kindLabel, SECTION_COLORS, SECTION_KINDS, type TimedSection } from "./model";

interface Props {
  sections: TimedSection[];
  current: number;
  editing: boolean;
  analysing: boolean;
  redetecting: boolean;
  barSec: number | null;
  onEditing: (v: boolean) => void;
  onPlayFrom: (index: number) => void;
  onChange: (sections: SectionRecord[]) => void;
  onAddAtCursor: () => void;
  onRedetect: () => void;
}

const strip = ({ startSec, kind, label, source }: TimedSection): SectionRecord => ({ startSec, kind, label, source });

export function SectionsPanel(props: Props) {
  const { sections, current, editing } = props;
  const update = (i: number, patch: Partial<SectionRecord>) =>
    props.onChange(sections.map((s, j) => (j === i ? { ...strip(s), ...patch, source: "user" } : strip(s))));
  const remove = (i: number) => props.onChange(sections.filter((_, j) => j !== i).map(strip));
  const nudge = (i: number, dir: -1 | 1) => {
    const s = sections[i];
    if (!s) return;
    const step = props.barSec ?? 1;
    const min = (sections[i - 1]?.startSec ?? -0.5) + 0.5;
    const max = (sections[i + 1]?.startSec ?? s.endSec) - 0.5;
    update(i, { startSec: Math.min(max, Math.max(min, s.startSec + dir * step)) });
  };

  const small = "rounded-md border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-xs text-ink-200 hover:bg-ink-700 disabled:opacity-40";

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={`${small} flex items-center gap-1 ${editing ? "border-info-500 text-info-400" : ""}`}
          onClick={() => props.onEditing(!editing)}
          aria-pressed={editing}
        >
          <Pencil size={12} /> {editing ? "Terminar edición" : "Editar secciones"}
        </button>
        {editing && (
          <button type="button" className={`${small} flex items-center gap-1`} onClick={props.onAddAtCursor}>
            <Plus size={12} /> Añadir en el cursor
          </button>
        )}
        <button
          type="button"
          className={`${small} ml-auto flex items-center gap-1`}
          onClick={() => {
            const manual = sections.some((s) => s.source === "user");
            if (!manual || window.confirm("Se reemplazarán las secciones (incluidos tus cambios) por las detectadas. ¿Continuar?"))
              props.onRedetect();
          }}
          disabled={props.analysing}
          title="Analiza la canción otra vez con el BPM actual"
        >
          <Sparkles size={12} /> {props.redetecting || props.analysing ? "Analizando…" : "Detectar de nuevo"}
        </button>
      </div>

      {sections.length === 0 ? (
        <p className="text-sm text-ink-400">
          {props.analysing ? "Detectando las partes de la canción…" : "No hay secciones. Usa «Editar secciones» para añadirlas."}
        </p>
      ) : (
        <ol className="grid gap-1.5">
          {sections.map((s, i) => (
            <li
              key={`${i}-${s.startSec}`}
              className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 ${
                i === current ? "border-white/40 bg-ink-800" : "border-ink-800 bg-ink-900"
              }`}
            >
              <span className="w-5 text-right font-mono text-xs text-ink-400">{i + 1 <= 9 ? i + 1 : ""}</span>
              <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: SECTION_COLORS[s.kind] }} />
              {editing ? (
                <>
                  <input
                    aria-label={`Nombre de la sección ${i + 1}`}
                    value={s.label}
                    maxLength={60}
                    onChange={(e) => update(i, { label: e.target.value || kindLabel(s.kind) })}
                    onKeyDown={(e) => e.stopPropagation()}
                    className="min-w-0 flex-1 rounded border border-ink-700 bg-ink-950 px-2 py-0.5 text-sm"
                  />
                  <select
                    aria-label={`Tipo de la sección ${i + 1}`}
                    value={s.kind}
                    onChange={(e) => {
                      const kind = e.target.value as SectionKind;
                      update(i, { kind, label: kindLabel(kind) });
                    }}
                    className="rounded border border-ink-700 bg-ink-950 px-1 py-0.5 text-xs"
                  >
                    {SECTION_KINDS.map((k) => (
                      <option key={k.kind} value={k.kind}>
                        {k.label}
                      </option>
                    ))}
                  </select>
                  <button type="button" className="text-ink-400 hover:text-ink-100 disabled:opacity-30" disabled={i === 0} onClick={() => nudge(i, -1)} aria-label="Mover al compás anterior">
                    <ChevronLeft size={16} />
                  </button>
                  <span className="w-14 text-center font-mono text-xs text-ink-300">{formatTime(s.startSec)}</span>
                  <button type="button" className="text-ink-400 hover:text-ink-100 disabled:opacity-30" disabled={i === 0} onClick={() => nudge(i, 1)} aria-label="Mover al compás siguiente">
                    <ChevronRight size={16} />
                  </button>
                  <button type="button" className="text-ink-400 hover:text-stop-500" onClick={() => remove(i)} aria-label={`Borrar ${s.label}`}>
                    <Trash2 size={14} />
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm text-ink-100 hover:text-white"
                    onClick={() => props.onPlayFrom(i)}
                    title="Tocar desde aquí"
                  >
                    <span className="truncate">{s.label}</span>
                    {s.source === "auto" && <span className="text-[10px] uppercase text-ink-400">auto</span>}
                  </button>
                  <span className="font-mono text-xs text-ink-400">{formatTime(s.startSec)}</span>
                  <button
                    type="button"
                    className="flex h-7 w-7 items-center justify-center rounded-md text-go-400 hover:bg-ink-700"
                    onClick={() => props.onPlayFrom(i)}
                    aria-label={`Tocar desde ${s.label}`}
                  >
                    <Play size={14} />
                  </button>
                </>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
