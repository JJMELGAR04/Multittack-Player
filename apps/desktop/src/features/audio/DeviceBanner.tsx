import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, X } from "lucide-react";
import { useAudioStatus } from "./useAudioStatus";

/**
 * App-wide warning when the audio interface is lost, reconnected or missing.
 * Lives in the shell so it shows on every page (also during a show).
 */
export function DeviceBanner() {
  const { info } = useAudioStatus(2000);
  const seen = useRef<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!info) return;
    const events = info.deviceEvents ?? 0;
    if (seen.current === null) {
      seen.current = events;
      return;
    }
    if (events > seen.current) {
      seen.current = events;
      setMessage(info.lastDeviceEvent || "Cambió la salida de audio.");
    }
  }, [info]);

  const missing = info?.preferred && info.usingPreferred === false;
  const noOutput = info && !info.open;
  const text = noOutput
    ? "No hay ninguna salida de audio abierta."
    : message ?? (missing ? `«${info!.preferred!.deviceName}» no está conectado: sonando por «${info!.deviceName}». Se reconectará solo al conectarlo.` : null);
  if (!text) return null;

  return (
    <div role="status" className="flex items-center gap-3 border-b border-live-500/40 bg-live-500/15 px-4 py-1.5 text-sm text-live-400" data-device-banner>
      <AlertTriangle size={16} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">{text}</span>
      <Link to="/audio-settings" className="shrink-0 text-xs font-semibold underline hover:text-ink-100">
        Audio Settings
      </Link>
      {message && (
        <button type="button" aria-label="Cerrar aviso" onClick={() => setMessage(null)} className="shrink-0 rounded p-0.5 hover:bg-live-500/20">
          <X size={14} />
        </button>
      )}
    </div>
  );
}
