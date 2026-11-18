import { useCallback, useEffect, useState } from "react";
import { DatabaseBackup, FileText, Gauge, Trash2 } from "lucide-react";
import { backend, isNativeAvailable } from "@/lib/ipc/client";
import type { PerformanceInfo } from "@/lib/ipc/types";

const CACHE_SIZES = [1024, 2048, 4096, 8192, 16384, 32768];

function gb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1).replace(".", ",")} GB` : `${Math.round(mb)} MB`;
}

/** Economy mode, decoded-audio cache, automatic library copies and the error log. */
export function PerformanceSection({ onMessage }: { onMessage: (m: { tone: "ok" | "error"; text: string }) => void }) {
  const native = isNativeAvailable();
  const [info, setInfo] = useState<PerformanceInfo | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const reload = useCallback(() => {
    if (native) backend.performanceInfo().then(setInfo, () => {});
  }, [native]);
  useEffect(reload, [reload]);
  const fail = (e: unknown) => onMessage({ tone: "error", text: e instanceof Error ? e.message : String(e) });

  return (
    <>
      <section className="mb-5 rounded-xl border border-ink-800 bg-ink-900/60 p-4">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-ink-200">
          <Gauge size={16} className="text-info-400" /> Rendimiento
        </h2>
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            aria-label="Modo económico"
            disabled={!info}
            checked={info?.economy ?? false}
            onChange={(e) =>
              backend.setEconomy(e.target.checked).then(() => {
                reload();
                onMessage({ tone: "ok", text: e.target.checked ? "Modo económico activado." : "Modo económico desactivado: máxima calidad." });
              }, fail)
            }
            className="mt-1 h-4 w-4 accent-info-500"
          />
          <span>
            <b className="text-ink-100">Modo económico</b>
            <span className="block text-xs text-ink-400">
              Para computadoras sencillas: el cambio de tempo y de tono gastan bastante menos CPU, con una calidad muy cercana. Sin cambios de tempo
              ni de tono la canción suena exactamente igual en los dos modos. Úsalo si ves cortes o la carga del audio pasa del 70 %.
            </span>
          </span>
        </label>

        <div className="mt-4 grid gap-2 text-sm">
          <span className="text-ink-100">
            <b>Canciones preparadas</b>{" "}
            <span className="text-xs text-ink-400">
              (la primera vez que abres una canción se guarda ya preparada: las siguientes veces abre en una fracción del tiempo)
            </span>
          </span>
          <div className="flex flex-wrap items-center gap-3 text-xs text-ink-300" data-cache-info>
            <span>
              Ocupa <b className="text-ink-100">{info ? gb(info.cacheUsedMb) : "—"}</b> ({info?.cacheFiles ?? 0} pistas) de
            </span>
            <select
              aria-label="Límite de la caché"
              disabled={!info}
              value={info?.cacheLimitMb ?? 4096}
              onChange={(e) => backend.setCacheLimit(Number(e.target.value)).then(reload, fail)}
              className="rounded-md border border-ink-700 bg-ink-950 px-2 py-1 text-xs text-ink-100"
            >
              {CACHE_SIZES.map((mb) => (
                <option key={mb} value={mb}>
                  {gb(mb)}
                </option>
              ))}
            </select>
            <span>como máximo (se borran primero las que hace más tiempo que no abres).</span>
            <button
              type="button"
              disabled={!info || info.cacheFiles === 0}
              onClick={() =>
                backend.clearCache().then((n) => {
                  reload();
                  onMessage({ tone: "ok", text: `Caché vaciada (${n} archivos). Las canciones se prepararán de nuevo al abrirlas.` });
                }, fail)
              }
              className="flex items-center gap-1 rounded-md border border-ink-700 px-2 py-1 text-xs text-ink-200 hover:border-ink-500 disabled:opacity-40"
            >
              <Trash2 size={12} /> Vaciar
            </button>
          </div>
        </div>
      </section>

      <section className="mb-5 rounded-xl border border-ink-800 bg-ink-900/60 p-4">
        <h2 className="mb-2 flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-ink-200">
          <DatabaseBackup size={16} className="text-info-400" /> Copias automáticas y registro
        </h2>
        <p className="text-xs text-ink-400">
          Cada día que abres LIVEPLAYER se guarda una copia de tu biblioteca (canciones, mezclas, partes y setlists; se guardan las 7 más recientes). Si
          el archivo de la biblioteca se dañara, la app lo aparta y restaura la última copia sola.
        </p>
        <p className="mt-2 text-xs text-ink-300" data-backups>
          {info?.backups.length ? (
            <>
              Última copia: <b className="text-ink-100">{info.backups[0]}</b> · {info.backups.length} guardadas en{" "}
              <span className="font-mono text-[11px]">{info.backupsDir}</span>
            </>
          ) : (
            "Todavía no hay copias."
          )}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-300">
          <FileText size={13} className="text-ink-400" /> Registro de errores: <span className="font-mono text-[11px]">{info?.logPath || "—"}</span>
          <button
            type="button"
            disabled={!native}
            onClick={() => (log === null ? backend.logRecent(80).then(setLog, fail) : setLog(null))}
            className="rounded-md border border-ink-700 px-2 py-1 text-xs text-ink-200 hover:border-ink-500 disabled:opacity-40"
          >
            {log === null ? "Ver lo último" : "Ocultar"}
          </button>
        </div>
        {log !== null && (
          <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-ink-950 p-3 font-mono text-[11px] text-ink-300" data-log>
            {log || "El registro está vacío."}
          </pre>
        )}
      </section>
    </>
  );
}
