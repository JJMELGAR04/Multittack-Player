import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ImportDraft } from "@/lib/ipc/types";
import { ImportDialog } from "./ImportDialog";
import { beatsPerBar, busForRole, uniqueName } from "./model";

afterEach(cleanup);

const draft: ImportDraft = {
  sourceKind: "zip",
  sourcePath: "C:\\Musica\\Ancient.zip",
  extractedDir: "C:\\lib\\Ancient",
  suggestedTitle: "Ancient",
  suggestedBpm: null,
  suggestedTimeSignature: "4/4",
  existingSongId: null,
  files: [
    { filePath: "C:\\lib\\Ancient\\Click.mp3", fileName: "Click.mp3", suggestedName: "Click", suggestedRole: "click", recognized: true, sizeBytes: 1 },
    { filePath: "C:\\lib\\Ancient\\llmmD.mp3", fileName: "llmmD.mp3", suggestedName: "llmmD", suggestedRole: "other", recognized: false, sizeBytes: 1 },
    { filePath: "C:\\lib\\Ancient\\Bass.mp3", fileName: "Bass.mp3", suggestedName: "Bass", suggestedRole: "bass", recognized: true, sizeBytes: 1 },
  ],
};

function renderDialog(onCommit = vi.fn()) {
  render(
    <ImportDialog
      draft={draft}
      peaks={null}
      previewReady
      previewProgress={1}
      soloTrack={null}
      onSolo={vi.fn()}
      onCommit={onCommit}
      onCancel={vi.fn()}
    />,
  );
  return onCommit;
}

describe("import dialog", () => {
  it("asks about the unrecognised file and takes the instrument's name", () => {
    const onCommit = renderDialog();
    expect(screen.getByText(/1 sin identificar/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Qué es llmmD.mp3"), { target: { value: "drums" } });
    expect((screen.getByLabelText("Nombre de llmmD.mp3") as HTMLInputElement).value).toBe("Batería");
    expect(screen.queryByText(/sin identificar/)).toBeNull();

    fireEvent.change(screen.getByLabelText("BPM"), { target: { value: "96" } });
    fireEvent.change(screen.getByLabelText("Compás"), { target: { value: "6/8" } });
    fireEvent.change(screen.getByLabelText("Tono original"), { target: { value: "D" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar canción" }));
    // While saving, the button is locked (a second click cannot import it twice).
    expect((screen.getByRole("button", { name: "Guardando…" }) as HTMLButtonElement).disabled).toBe(true);

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith({
      title: "Ancient",
      songKey: "D",
      bpm: 96,
      timeSignature: "6/8",
      sourceArchive: "C:\\Musica\\Ancient.zip",
      tracks: [
        { filePath: "C:\\lib\\Ancient\\Click.mp3", name: "Click", role: "click" },
        { filePath: "C:\\lib\\Ancient\\llmmD.mp3", name: "Batería", role: "drums" },
        { filePath: "C:\\lib\\Ancient\\Bass.mp3", name: "Bass", role: "bass" },
      ],
    });
  });

  it("shows where each track goes: click to the band, instruments to the PA", () => {
    renderDialog();
    const rows = document.querySelectorAll("[data-import-row]");
    expect(rows[0]!.textContent).toContain("Solo banda");
    expect(rows[2]!.textContent).toContain("PA");
  });

  it("rejects an invalid BPM", () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText("BPM"), { target: { value: "5" } });
    expect((screen.getByRole("button", { name: "Guardar canción" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("track helpers", () => {
  it("routes click and cues to the band only", () => {
    expect(busForRole("click")).toBe("monitor");
    expect(busForRole("cues")).toBe("monitor");
    expect(busForRole("drums")).toBe("main");
    expect(busForRole("backing_track")).toBe("main");
  });

  it("numbers repeated names and maps meters to beats per bar", () => {
    expect(uniqueName("Guitarra eléctrica", ["Guitarra eléctrica"])).toBe("Guitarra eléctrica 2");
    expect(uniqueName("Bajo", [])).toBe("Bajo");
    expect(beatsPerBar("4/4")).toBe(4);
    expect(beatsPerBar("6/8")).toBe(2);
    expect(beatsPerBar("3/4")).toBe(3);
  });
});
