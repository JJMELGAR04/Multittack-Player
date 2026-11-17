import { useEffect, useMemo, useRef, useState } from "react";
import { FileArchive, HelpCircle, Headphones, Play, Square, X } from "lucide-react";
import type { ImportCommit, ImportDraft, TimeSignature, TrackRole } from "@/lib/ipc/types";
import { ALL_KEY_OPTIONS, BUS_LABEL, busForRole, roleLabel, TIME_SIGNATURES, TRACK_ROLES, uniqueName } from "./model";

interface Row {
  filePath: string;
  fileName: string;
  name: string;
  role: TrackRole;
  recognized: boolean;
  /** The user picked the role (or the name told us). */
  confirmed: boolean;
  nameEdited: boolean;
}

interface Props {
  draft: ImportDraft;
  peaks: Uint8Array[] | null;
  previewReady: boolean;
  previewProgress: number;
  soloTrack: number | null;
  onSolo: (index: number | null) => void;
  onCommit: (commit: ImportCommit) => void | Promise<void>;
  onCancel: () => void;
}

function MiniWave({ peaks }: { peaks: Uint8Array | undefined }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const w = 160, h = 28, dpr = window.devicePixelRatio || 1;
    c.width = w * dpr;
    c.height = h * dpr;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!peaks || peaks.length === 0) return;
    ctx.fillStyle = "#7d8592";
    const per = peaks.length / w;
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let i = Math.floor(x * per); i < Math.floor((x + 1) * per); i++) v = Math.max(v, peaks[i] ?? 0);
      const bar = Math.max(1, (v / 255) * (h / 2 - 1));
      ctx.fillRect(x, h / 2 - bar, 1, bar * 2);
    }
  }, [peaks]);
  return <canvas ref={ref} style={{ width: 160, height: 28 }} className="shrink-0 rounded bg-ink-950" aria-hidden />;
}

export function ImportDialog({ draft, peaks, previewReady, previewProgress, soloTrack, onSolo, onCommit, onCancel }: Props) {
  const [title, setTitle] = useState(draft.suggestedTitle);
  const [bpmText, setBpmText] = useState(draft.suggestedBpm ? String(draft.suggestedBpm) : "");
  const [meter, setMeter] = useState<TimeSignature>(draft.suggestedTimeSignature);
  const [songKey, setSongKey] = useState("");
  // A second click while saving must not save the song twice.
  const [saving, setSaving] = useState(false);
  const [rows, setRows] = useState<Row[]>(() =>
    draft.files.map((f) => ({
      filePath: f.filePath,
      fileName: f.fileName,
      name: f.suggestedName,
      role: f.suggestedRole,
      recognized: f.recognized,
      confirmed: f.recognized,
      nameEdited: false,
    })),
  );

  const bpm = bpmText.trim() === "" ? null : Number(bpmText.replace(",", "."));
  const bpmValid = bpm === null || (Number.isFinite(bpm) && bpm >= 20 && bpm <= 400);
  const pending = rows.filter((r) => !r.confirmed).length;
  const hasClick = rows.some((r) => r.role === "click");
  const canSave = title.trim().length > 0 && bpmValid && rows.length > 0;

  const setRole = (i: number, role: TrackRole) =>
    setRows((rs) =>
      rs.map((r, j) => {
        if (j !== i) return r;
        // A file with a meaningless name takes the instrument's name ("llmmD" -> "Batería").
        const rename = !r.recognized && !r.nameEdited;
        const taken = rs.filter((_, k) => k !== i).map((x) => x.name);
        return { ...r, role, confirmed: true, name: rename ? uniqueName(roleLabel(role), taken) : r.name };
      }),
    );

  const commit = async () => {
    if (!canSave || saving) return;
    if (pending > 0 && !window.confirm(`Hay ${pending} pista(s) sin identificar: se guardarán como «Otro» (salen por el PA). ¿Continuar?`))
      return;
    setSaving(true);
    try {
      await onCommit({
      title: title.trim(),
      songKey: songKey || null,
      bpm,
      timeSignature: meter,
      sourceArchive: draft.sourceKind === "zip" ? draft.sourcePath : null,
      tracks: rows.map((r) => ({ filePath: r.filePath, name: r.name.trim() || r.fileName, role: r.role })),
      });
    } finally {
      setSaving(false);
    }
  };

  const sourceName = useMemo(() => draft.sourcePath?.split(/[\\/]/).pop() ?? `${draft.files.length} archivos`, [draft]);
  const field = "rounded-md border border-ink-700 bg-ink-950 px-2.5 py-1.5 text-sm text-ink-100 focus:border-info-500 focus:outline-none";

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-6" role="dialog" aria-modal aria-label="Importar canción">
      <div className="flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-ink-700 bg-ink-900 shadow-2xl">
        <header className="flex items-center gap-3 border-b border-ink-800 px-6 py-4">
          <FileArchive className="text-info-400" size={22} />
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-bold">Nueva canción</h2>
            <p className="truncate text-xs text-ink-400">
              {draft.sourceKind === "zip" ? "Desde el zip" : "Desde"} {sourceName} · {rows.length} pistas
            </p>
          </div>
          <button type="button" onClick={onCancel} aria-label="Cancelar importación" className="text-ink-400 hover:text-ink-100">
            <X size={20} />
          </button>
        </header>

        <div className="grid gap-4 border-b border-ink-800 px-6 py-4 md:grid-cols-[minmax(0,1fr)_110px_110px_minmax(0,230px)]">
          <label className="grid gap-1 text-xs text-ink-300">
            Título
            <input aria-label="Título" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} className={field} onKeyDown={(e) => e.stopPropagation()} />
          </label>
          <label className="grid gap-1 text-xs text-ink-300">
            BPM
            <input
              aria-label="BPM"
              inputMode="decimal"
              placeholder="Detectar"
              value={bpmText}
              onChange={(e) => setBpmText(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              className={`${field} ${bpmValid ? "" : "border-stop-500"}`}
            />
          </label>
          <label className="grid gap-1 text-xs text-ink-300">
            Tono original
            <select aria-label="Tono original" value={songKey} onChange={(e) => setSongKey(e.target.value)} className={field} title="El tono en que está grabada la canción: así la app te dice a qué tono la cambias">
              <option value="">No sé</option>
              {ALL_KEY_OPTIONS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-xs text-ink-300">
            Compás
            <select aria-label="Compás" value={meter} onChange={(e) => setMeter(e.target.value as TimeSignature)} className={field}>
              {TIME_SIGNATURES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <p className="text-xs text-ink-400 md:col-span-3">
            {bpm === null
              ? hasClick
                ? "Si dejas el BPM vacío, se detecta solo a partir de la pista de click."
                : "Si dejas el BPM vacío, se detecta solo a partir de la música."
              : "Se usará este BPM y se buscará solo dónde empieza cada compás."}
          </p>
        </div>

        <div className="flex items-center gap-2 px-6 pt-3 text-xs text-ink-300">
          <Headphones size={14} />
          {previewReady
            ? "Pulsa ▶ para escuchar cada archivo solo y decir qué es."
            : `Preparando las pistas para escucharlas… ${Math.round(previewProgress * 100)} %`}
          {pending > 0 && (
            <span className="ml-auto flex items-center gap-1 font-semibold text-live-400">
              <HelpCircle size={14} /> {pending} sin identificar
            </span>
          )}
        </div>

        <ol className="min-h-0 flex-1 overflow-y-auto px-6 py-3">
          {rows.map((r, i) => (
            <li
              key={r.filePath}
              data-import-row={r.fileName}
              className={`mb-1.5 flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2 ${
                r.confirmed ? "border-ink-800 bg-ink-900" : "border-live-500/60 bg-live-500/10"
              }`}
            >
              <button
                type="button"
                disabled={!previewReady}
                onClick={() => onSolo(i)}
                aria-label={soloTrack === i ? `Detener ${r.fileName}` : `Escuchar ${r.fileName}`}
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border disabled:opacity-40 ${
                  soloTrack === i ? "border-live-500 bg-live-500/20 text-live-400" : "border-ink-700 bg-ink-850 text-go-400 hover:bg-ink-700"
                }`}
              >
                {soloTrack === i ? <Square size={14} /> : <Play size={16} />}
              </button>
              <MiniWave peaks={peaks?.[i]} />
              <div className="min-w-40 flex-1">
                <input
                  aria-label={`Nombre de ${r.fileName}`}
                  value={r.name}
                  maxLength={80}
                  onChange={(e) => {
                    const name = e.target.value;
                    setRows((rs) => rs.map((x, j) => (j === i ? { ...x, name, nameEdited: true } : x)));
                  }}
                  onKeyDown={(e) => e.stopPropagation()}
                  className={`${field} w-full`}
                />
                <p className="mt-0.5 truncate text-[11px] text-ink-400" title={r.filePath}>
                  {r.fileName}
                  {!r.confirmed && " · no reconocí este archivo: escúchalo y elige qué es"}
                </p>
              </div>
              <label className="flex items-center gap-2 text-xs text-ink-300">
                ¿Qué es?
                <select
                  aria-label={`Qué es ${r.fileName}`}
                  value={r.confirmed ? r.role : ""}
                  onChange={(e) => setRole(i, e.target.value as TrackRole)}
                  className={field}
                >
                  {!r.confirmed && <option value="">Elige…</option>}
                  {TRACK_ROLES.map((t) => (
                    <option key={t.role} value={t.role}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </label>
              <span
                className={`w-36 shrink-0 rounded-full px-2 py-1 text-center text-[11px] font-semibold ${
                  busForRole(r.role) === "monitor" ? "bg-info-500/15 text-info-400" : "bg-go-500/10 text-go-400"
                }`}
                title="Por dónde sale esta pista en vivo"
              >
                {BUS_LABEL[busForRole(r.role)]}
              </span>
            </li>
          ))}
        </ol>

        <footer className="flex items-center gap-3 border-t border-ink-800 px-6 py-4">
          <p className="flex-1 text-xs text-ink-400">El click y las cues salen solo por los in-ears de la banda; el resto, por el PA.</p>
          <button type="button" onClick={onCancel} className="rounded-lg border border-ink-700 px-4 py-2 text-sm text-ink-200 hover:bg-ink-800">
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => void commit()}
            disabled={!canSave || saving}
            className="rounded-lg border border-go-500 bg-go-500/20 px-5 py-2 text-sm font-semibold text-go-400 hover:bg-go-500/30 disabled:opacity-40"
          >
            {saving ? "Guardando…" : "Guardar canción"}
          </button>
        </footer>
      </div>
    </div>
  );
}
