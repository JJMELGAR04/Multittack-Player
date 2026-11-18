import { useState } from "react";
import { Info } from "lucide-react";
import { backend, isNativeAvailable } from "@/lib/ipc/client";
import type { AppLicenses } from "@/lib/ipc/types";

/** Version, source code and the licenses the installed app carries. */
export function AboutSection() {
  const native = isNativeAvailable();
  const [licenses, setLicenses] = useState<AppLicenses | null>(null);
  const [shown, setShown] = useState<"thirdParty" | "license" | null>(null);

  const show = async (which: "thirdParty" | "license") => {
    if (shown === which) return setShown(null);
    if (!licenses) setLicenses(await backend.appLicenses());
    setShown(which);
  };

  return (
    <section className="mt-5 rounded-xl border border-ink-800 bg-ink-900/60 p-4" data-about>
      <h2 className="mb-1 flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-ink-200">
        <Info size={16} className="text-info-400" /> Acerca de
      </h2>
      <p className="mb-1 text-sm text-ink-100">
        LIVEPLAYER <span className="font-mono" data-about-version>v{__APP_VERSION__}</span>
      </p>
      <p className="mb-3 text-xs text-ink-400">
        Software libre y gratuito bajo la licencia GNU AGPL-3.0. Se puede copiar y compartir. Código fuente:{" "}
        <span className="select-all font-mono text-ink-200">https://github.com/JJMELGAR04/Multittack-Player</span>
      </p>
      <div className="flex flex-wrap gap-3">
        <button type="button" disabled={!native} onClick={() => void show("thirdParty")} className="rounded-md border border-ink-700 px-3 py-1.5 text-xs text-ink-100 hover:border-ink-500 disabled:opacity-40" data-about-third-party>
          {shown === "thirdParty" ? "Ocultar" : "Componentes y licencias"}
        </button>
        <button type="button" disabled={!native} onClick={() => void show("license")} className="rounded-md border border-ink-700 px-3 py-1.5 text-xs text-ink-100 hover:border-ink-500 disabled:opacity-40" data-about-license>
          {shown === "license" ? "Ocultar" : "Licencia de LIVEPLAYER (AGPL-3.0)"}
        </button>
      </div>
      {shown && licenses && (
        <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border border-ink-800 bg-ink-950 p-3 font-mono text-[11px] leading-relaxed text-ink-200" data-about-text>
          {shown === "license" ? licenses.license : licenses.thirdParty}
        </pre>
      )}
    </section>
  );
}
