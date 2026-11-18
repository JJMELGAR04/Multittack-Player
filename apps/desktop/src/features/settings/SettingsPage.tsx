import { useEffect, useState } from "react";
import { Archive, Download, Keyboard, RotateCcw, Settings, Upload } from "lucide-react";
import { backend, isNativeAvailable } from "@/lib/ipc/client";
import type { BackupReport } from "@/lib/ipc/types";
import { actionFor, DEFAULT_SHORTCUTS, keyLabel, keyName, SHORTCUT_ACTIONS, type ShortcutAction } from "@/features/live/model";
import { useShortcutSettings } from "@/features/live/songView";
import { PerformanceSection } from "./PerformanceSection";
import { AboutSection } from "./AboutSection";

/** Keys that cannot be assigned (they would break typing or the app). */
const RESERVED = new Set(["Tab", "Enter", "Delete", "Backspace", "Ctrl+Z", "Ctrl+Y", "Ctrl+Shift+Z", "F5", "Ctrl+R"]);

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function SettingsPage() {
  const native = isNativeAvailable();
  const { shortcuts, save } = useShortcutSettings();
  const [capturing, setCapturing] = useState<ShortcutAction | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState<"export" | "import" | null>(null);

  // Waiting for the new key of one action.
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape" && !e.shiftKey && !e.ctrlKey) {
        setCapturing(null);
        return;
      }
      const name = keyName(e);
      if (!name) return; // only a modifier so far
      if (RESERVED.has(name)) {
        setMessage({ tone: "error", text: `«${keyLabel(name)}» está reservada. Elige otra tecla.` });
        return;
      }
      const other = actionFor(shortcuts, name);
      const next = { ...shortcuts, [capturing]: name };
      // Taking a key from another action swaps them (never two actions on one key).
      if (other && other !== capturing) next[other] = shortcuts[capturing];
      void save(next);
      setMessage(other && other !== capturing ? { tone: "ok", text: `Intercambiada con «${SHORTCUT_ACTIONS.find((a) => a.action === other)?.label}».` } : null);
      setCapturing(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing, shortcuts, save]);

  const report = (r: BackupReport, verb: string) =>
    setMessage({
      tone: "ok",
      text: `${verb}: ${r.songs} canciones y ${r.setlists} setlists.${r.skippedSongs ? ` ${r.skippedSongs} canciones ya estaban en tu biblioteca (no se duplicaron).` : ""}${
        r.missingFiles.length ? ` Faltaban ${r.missingFiles.length} archivos de audio en el disco.` : ""
      }`,
    });

  const exportBackup = async () => {
    const { save: saveDialog } = await import("@tauri-apps/plugin-dialog");
    const path = await saveDialog({ title: "Guardar copia de seguridad", defaultPath: `LIVEPLAYER-copia-${today()}.zip`, filters: [{ name: "Copia de LIVEPLAYER", extensions: ["zip"] }] });
    if (!path) return;
    setBusy("export");
    setMessage(null);
    try {
      report(await backend.backupExport(path), "Copia guardada");
    } catch (e) {
      setMessage({ tone: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const importBackup = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({ title: "Restaurar copia de seguridad", multiple: false, filters: [{ name: "Copia de LIVEPLAYER", extensions: ["zip"] }] });
    if (!path || Array.isArray(path)) return;
    setBusy("import");
    setMessage(null);
    try {
      report(await backend.backupImport(path), "Copia restaurada");
    } catch (e) {
      setMessage({ tone: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-4xl px-8 py-6">
      <header className="mb-5 flex items-center gap-3">
        <Settings className="text-info-400" size={26} />
        <div>
          <h1 className="text-2xl font-bold">General Settings</h1>
          <p className="text-sm text-ink-300">Atajos de teclado, rendimiento, copias de seguridad de tu biblioteca y licencias.</p>
        </div>
      </header>

      {!native && (
        <p className="mb-4 rounded-lg border border-live-500/40 bg-live-500/10 px-4 py-3 text-sm text-live-400">
          La interfaz se está ejecutando fuera de la aplicación de escritorio: los ajustes no están disponibles.
        </p>
      )}
      {message && (
        <p role="status" className={`mb-4 rounded-lg border px-4 py-3 text-sm ${message.tone === "ok" ? "border-go-500/40 bg-go-500/10 text-go-400" : "border-stop-500/50 bg-stop-500/10 text-stop-500"}`} data-settings-message>
          {message.text}
        </p>
      )}

      <section className="mb-5 rounded-xl border border-ink-800 bg-ink-900/60 p-4">
        <h2 className="mb-1 flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-ink-200">
          <Keyboard size={16} className="text-info-400" /> Atajos de teclado
        </h2>
        <p className="mb-3 text-xs text-ink-400">Pulsa «Cambiar» y después la tecla que quieras. No funcionan mientras escribes en un campo de texto.</p>
        <table className="w-full text-sm">
          <tbody>
            {SHORTCUT_ACTIONS.map((a) => (
              <tr key={a.action} className="border-t border-ink-800">
                <td className="py-2 pr-3 text-ink-100">{a.label}</td>
                <td className="py-2 pr-3 text-xs text-ink-400">{a.where}</td>
                <td className="py-2 pr-3">
                  <kbd className="rounded border border-ink-600 bg-ink-950 px-2 py-0.5 font-mono text-xs text-ink-100" data-shortcut={a.action}>
                    {capturing === a.action ? "pulsa una tecla…" : keyLabel(shortcuts[a.action])}
                  </kbd>
                </td>
                <td className="py-2 text-right">
                  <button
                    type="button"
                    disabled={!native}
                    aria-label={`Cambiar atajo: ${a.label}`}
                    onClick={() => setCapturing(capturing === a.action ? null : a.action)}
                    className="rounded-md border border-ink-700 px-2 py-1 text-xs text-ink-200 hover:border-ink-500 disabled:opacity-40"
                  >
                    {capturing === a.action ? "Cancelar" : "Cambiar"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" disabled={!native} onClick={() => void save({ ...DEFAULT_SHORTCUTS })} className="mt-3 flex items-center gap-1 text-xs text-info-400 hover:text-ink-100 disabled:opacity-40">
          <RotateCcw size={12} /> Volver a los atajos de fábrica
        </button>
      </section>

      <PerformanceSection onMessage={setMessage} />

      <section className="rounded-xl border border-ink-800 bg-ink-900/60 p-4">
        <h2 className="mb-1 flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-ink-200">
          <Archive size={16} className="text-info-400" /> Copia de seguridad
        </h2>
        <p className="mb-3 text-xs text-ink-400">
          Un solo archivo .zip con todas tus canciones (audio, mezcla, partes, tempo y datos) y tus setlists. Sirve para llevar la biblioteca a otro
          equipo o guardarla por si acaso. Restaurar <b>agrega</b> lo que falta: nunca borra nada y no duplica canciones ni setlists que ya tienes.
        </p>
        <div className="flex flex-wrap gap-3">
          <button type="button" disabled={!native || busy !== null} onClick={() => void exportBackup()} className="flex items-center gap-2 rounded-lg bg-info-500 px-4 py-2 text-sm font-semibold text-white hover:bg-info-400 disabled:opacity-40">
            <Download size={15} /> {busy === "export" ? "Guardando…" : "Guardar copia…"}
          </button>
          <button type="button" disabled={!native || busy !== null} onClick={() => void importBackup()} className="flex items-center gap-2 rounded-lg border border-ink-700 px-4 py-2 text-sm text-ink-100 hover:border-ink-500 disabled:opacity-40">
            <Upload size={15} /> {busy === "import" ? "Restaurando…" : "Restaurar copia…"}
          </button>
        </div>
      </section>

      <AboutSection />
    </div>
  );
}
