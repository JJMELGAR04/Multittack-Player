import { useCallback, useEffect, useState } from "react";
import { backend, isNativeAvailable } from "@/lib/ipc/client";
import type { OutputInfo } from "@/lib/ipc/types";

/**
 * Polls the output device status. Polling also lets the engine notice a lost
 * or reconnected interface, so at least one poller runs while the app is open.
 */
export function useAudioStatus(intervalMs: number): { info: OutputInfo | null; refresh: () => void; setInfo: (i: OutputInfo) => void } {
  const native = isNativeAvailable();
  const [info, setInfo] = useState<OutputInfo | null>(null);
  const refresh = useCallback(() => {
    if (native) backend.outputInfo().then(setInfo, () => {});
  }, [native]);
  useEffect(() => {
    if (!native) return;
    refresh();
    const id = window.setInterval(refresh, intervalMs);
    return () => window.clearInterval(id);
  }, [native, intervalMs, refresh]);
  return { info, refresh, setInfo };
}
