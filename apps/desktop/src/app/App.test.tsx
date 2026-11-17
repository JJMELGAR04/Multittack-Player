import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppRoutes } from "./App";
import { MODULES } from "./modules";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe("navigation", () => {
  it("lists all eight main modules in the sidebar", () => {
    renderAt("/");
    const nav = screen.getByRole("navigation", { name: "Navegación principal" });
    for (const m of MODULES) {
      expect(nav.textContent).toContain(m.label);
    }
    expect(MODULES).toHaveLength(8);
  });

  it("renders the dashboard at the root path", () => {
    renderAt("/");
    expect(screen.getByRole("heading", { level: 1, name: "Dashboard" })).toBeTruthy();
  });

  it("warns when running outside Tauri instead of faking data", () => {
    renderAt("/");
    expect(screen.getByText(/fuera de la aplicación de escritorio/)).toBeTruthy();
  });

  it("renders the Multitrack Studio (phase 2) and warns when there is no engine", () => {
    renderAt("/studio");
    expect(screen.getByRole("heading", { level: 1, name: "Multitrack Studio" })).toBeTruthy();
    expect(screen.getByText(/no hay motor de audio disponible/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Abrir pistas/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it.each(MODULES.filter((m) => m.path !== "/" && m.id !== "studio"))("renders planned module $label", (m) => {
    renderAt(m.path);
    expect(screen.getByRole("heading", { level: 1, name: m.label })).toBeTruthy();
    expect(screen.getByText(`Planificado para la Fase ${m.phase}`)).toBeTruthy();
  });

  it("redirects unknown routes to the dashboard", () => {
    renderAt("/does-not-exist");
    expect(screen.getByRole("heading", { level: 1, name: "Dashboard" })).toBeTruthy();
  });
});
