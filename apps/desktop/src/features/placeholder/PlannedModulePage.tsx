import type { AppModule } from "@/app/modules";

/** Shown for modules that are scheduled for a later development phase. */
export function PlannedModulePage({ module }: { module: AppModule }) {
  const Icon = module.icon;
  return (
    <div className="flex h-full items-center justify-center px-8">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-ink-700 bg-ink-900 text-ink-300">
          <Icon size={30} />
        </div>
        <h1 className="text-2xl font-bold">{module.label}</h1>
        <p className="mt-2 text-sm text-ink-300">{module.description}</p>
        <p className="mt-6 inline-block rounded-full border border-info-500/40 bg-info-500/10 px-4 py-1.5 text-xs font-semibold text-info-400">
          Planificado para la Fase {module.phase}
        </p>
      </div>
    </div>
  );
}
