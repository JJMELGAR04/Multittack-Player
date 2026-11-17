import type { OutputMode } from "@/lib/ipc/types";

/** Friendly names of the driver types JUCE reports. */
export function driverLabel(typeName: string): string {
  switch (typeName) {
    case "Windows Audio":
      return "Windows · compartido";
    case "Windows Audio (Exclusive Mode)":
      return "Windows · exclusivo (menos retraso)";
    case "Windows Audio (Low Latency Mode)":
      return "Windows · baja latencia";
    case "ASIO":
      return "ASIO · interfaces profesionales";
    case "CoreAudio":
      return "Core Audio";
    default:
      return typeName;
  }
}

/** Short explanation shown under the driver selector. */
export function driverHint(typeName: string): string {
  switch (typeName) {
    case "Windows Audio":
      return "Funciona siempre y permite que otras apps suenen a la vez, con algo más de retraso.";
    case "Windows Audio (Exclusive Mode)":
      return "LIVEPLAYER usa la tarjeta en solitario: menos retraso, y otras apps no sonarán por ella.";
    case "Windows Audio (Low Latency Mode)":
      return "Compartido con búfer reducido (si la tarjeta lo permite).";
    case "ASIO":
      return "El controlador de tu interfaz de audio: el menor retraso y todas sus salidas. Recomendado en vivo.";
    default:
      return "";
  }
}

/** Driver types in the order we recommend them for live use. */
export function sortDriverTypes<T extends { name: string }>(types: T[]): T[] {
  const rank = (n: string) =>
    n === "ASIO" ? 0 : n === "Windows Audio (Exclusive Mode)" ? 1 : n === "Windows Audio" ? 2 : 3;
  return [...types].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

/** "Salida 3 · Line 3" (1-based number + the driver's own name when it adds something). */
export function outputLabel(index: number, names: string[] | undefined): string {
  const n = `Salida ${index + 1}`;
  const name = names?.[index]?.trim();
  if (!name || name === `Output channel ${index + 1}` || name === String(index + 1)) return n;
  return `${n} · ${name}`;
}

/** Latency in ms of a buffer at a sample rate. */
export function bufferMs(bufferSize: number, sampleRate: number): number {
  return sampleRate > 0 ? (1000 * bufferSize) / sampleRate : 0;
}

export function formatRate(rate: number): string {
  return rate % 1000 === 0 ? `${rate / 1000} kHz` : `${(rate / 1000).toFixed(1).replace(".", ",")} kHz`;
}

/** Mirrors the engine rules: is this routing possible on a device with `n` outputs? */
export function routingFits(mode: OutputMode, main: number, monitor: number, n: number): boolean {
  if (n <= 0 || main < 0 || monitor < 0) return false;
  if (mode === "stereo") return n === 1 ? main === 0 : main + 1 < n;
  if (mode === "split") return main < n && monitor < n && main !== monitor;
  return main + 1 < n && monitor + 1 < n && (main + 1 < monitor || monitor + 1 < main);
}

/** Choices offered for each bus: single outputs (split) or pairs (stereo / 4 ch). */
export function outputChoices(mode: OutputMode, n: number): { value: number; pair: boolean }[] {
  const out: { value: number; pair: boolean }[] = [];
  const pair = mode !== "split";
  for (let i = 0; i < n; i++) if (!pair || i + 1 < n) out.push({ value: i, pair });
  return out;
}

export function choiceLabel(value: number, pair: boolean, names: string[] | undefined): string {
  if (!pair) return outputLabel(value, names);
  return `Salidas ${value + 1}-${value + 2}`;
}

/** What the CPU number means for a live show. */
export function loadVerdict(load: number): { label: string; tone: "ok" | "warn" | "bad" } {
  if (load < 0.5) return { label: "holgado", tone: "ok" };
  if (load < 0.8) return { label: "justo", tone: "warn" };
  return { label: "al límite: sube el búfer", tone: "bad" };
}
