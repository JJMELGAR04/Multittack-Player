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
    // No import here any more: a search box over the library (importing lives in Songs).
    expect(screen.queryByRole("button", { name: /Abrir pistas/ })).toBeNull();
    for (const box of screen.getAllByRole("textbox", { name: "Buscar canción para abrir" })) expect((box as HTMLInputElement).disabled).toBe(true);
  });

  it("renders the song library (phase 3) without faking data outside Tauri", () => {
    renderAt("/songs");
    expect(screen.getByRole("heading", { level: 1, name: "Songs" })).toBeTruthy();
    expect(screen.getByText(/la biblioteca no está disponible/)).toBeTruthy();
  });

  it("renders Audio Settings (phase 4) without faking devices outside Tauri", () => {
    renderAt("/audio-settings");
    expect(screen.getByRole("heading", { level: 1, name: "Audio Settings" })).toBeTruthy();
    expect(screen.getByText(/no hay acceso a los dispositivos de audio/)).toBeTruthy();
  });

  it.each([
    ["/setlists", "Setlists", /los setlists no están disponibles/],
    ["/live", "Live Mode", /Live Mode no está disponible/],
    ["/song-editor", "Song Editor", /el editor no está disponible/],
    ["/settings", "General Settings", /los ajustes no están disponibles/],
  ] as const)("renders %s (phase 5) without faking data outside Tauri", (path, title, warning) => {
    renderAt(path);
    expect(screen.getByRole("heading", { level: 1, name: title })).toBeTruthy();
    expect(screen.getByText(warning)).toBeTruthy();
  });

  it("every module of the navigation has a real page now", () => {
    for (const m of MODULES) expect(m.phase).toBeLessThanOrEqual(5);
  });

  it("redirects unknown routes to the dashboard", () => {
    renderAt("/does-not-exist");
    expect(screen.getByRole("heading", { level: 1, name: "Dashboard" })).toBeTruthy();
  });
});
