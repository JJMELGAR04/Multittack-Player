import type { ReactNode } from "react";

export type StatusTone = "ok" | "warn" | "error" | "pending";

const TONE_CLASSES: Record<StatusTone, string> = {
  ok: "bg-go-500 shadow-go-500/60",
  warn: "bg-live-500 shadow-live-500/60",
  error: "bg-stop-500 shadow-stop-500/60",
  pending: "bg-ink-600 shadow-transparent animate-pulse",
};

export function StatusDot({ tone }: { tone: StatusTone }) {
  return (
    <span
      aria-hidden
      className={`inline-block h-2.5 w-2.5 rounded-full shadow-[0_0_8px] ${TONE_CLASSES[tone]}`}
    />
  );
}

interface PanelProps {
  title: string;
  icon?: ReactNode;
  tone?: StatusTone;
  statusLabel?: string;
  action?: ReactNode;
  children: ReactNode;
}

export function Panel({ title, icon, tone, statusLabel, action, children }: PanelProps) {
  return (
    <section className="rounded-xl border border-ink-800 bg-ink-900">
      <header className="flex items-center gap-3 border-b border-ink-800 px-5 py-3.5">
        {icon && <span className="text-ink-300">{icon}</span>}
        <h2 className="flex-1 text-sm font-semibold uppercase tracking-wider text-ink-100">
          {title}
        </h2>
        {tone && (
          <span className="flex items-center gap-2 text-xs text-ink-300">
            <StatusDot tone={tone} />
            {statusLabel}
          </span>
        )}
        {action}
      </header>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

export function KeyValue({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 text-sm">
      <dt className="text-ink-400">{label}</dt>
      <dd className="truncate text-right font-mono text-ink-100">{value}</dd>
    </div>
  );
}
