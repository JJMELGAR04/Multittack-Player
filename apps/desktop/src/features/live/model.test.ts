import { describe, expect, it } from "vitest";
import type { SectionRecord } from "@/lib/ipc/types";
import {
  actionFor,
  DEFAULT_SHORTCUTS,
  formatDuration,
  historyOf,
  jumpTime,
  keyLabel,
  keyName,
  moveBoundary,
  nextBarAt,
  pushHistory,
  redo,
  removePart,
  rename,
  setKind,
  splitAt,
  undo,
  withDefaults,
} from "./model";

const part = (startSec: number, kind: SectionRecord["kind"], label: string): SectionRecord => ({ startSec, kind, label, source: "auto" });
const song: SectionRecord[] = [part(0, "intro", "Intro"), part(10, "verse", "Estrofa"), part(30, "chorus", "Coro")];

describe("musical jumps", () => {
  it("finds the next bar line far enough ahead", () => {
    // 96 BPM 4/4 -> bars of 2.5 s, first bar line at 0.5 s.
    expect(nextBarAt(3.0, 0.3, 96, 0.5, 4)).toBeCloseTo(5.5, 9);
    expect(nextBarAt(5.3, 0.3, 96, 0.5, 4)).toBeCloseTo(8.0, 9); // 5.5 is too close
    expect(nextBarAt(4.0, 0.3, 120, 0, 3)).toBeCloseTo(4.5, 9); // 3/4 at 120 = 1.5 s bars
    expect(nextBarAt(4.0, 0.3, null, 0, 4)).toBeCloseTo(4.3, 9);
  });

  it("chooses when to jump", () => {
    expect(jumpTime("now", 3, 0.3, 96, 0.5, 4, 10, 100)).toBeNull();
    expect(jumpTime("bar", 3, 0.3, 96, 0.5, 4, 10, 100)).toBeCloseTo(5.5, 9);
    expect(jumpTime("section", 3, 0.3, 96, 0.5, 4, 10, 100)).toBe(10);
    // The part ends too soon: next bar instead.
    expect(jumpTime("section", 9.9, 0.3, 96, 0.5, 4, 10, 100)).toBeCloseTo(10.5, 9);
    // No bar line left before the end: immediate.
    expect(jumpTime("bar", 99, 0.3, 96, 0.5, 4, null, 100)).toBeNull();
  });
});

describe("song editor", () => {
  it("moves a boundary between its neighbours", () => {
    expect(moveBoundary(song, 1, 12, 60)[1]!.startSec).toBe(12);
    expect(moveBoundary(song, 1, -5, 60)[1]!.startSec).toBe(0.5); // not before the previous part
    expect(moveBoundary(song, 2, 100, 60)[2]!.startSec).toBe(59.5); // not after the end
    expect(moveBoundary(song, 0, 5, 60)[0]!.startSec).toBe(0); // the first part always starts at 0
    expect(moveBoundary(song, 1, 12, 60)[1]!.source).toBe("user");
  });

  it("splits, removes, renames and retypes parts", () => {
    const split = splitAt(song, 40, "bridge", 60);
    expect(split.map((s) => s.label)).toEqual(["Intro", "Estrofa", "Coro", "Puente"]);
    expect(splitAt(song, 10.2, "bridge", 60)).toBe(song); // too close to a boundary
    const two = splitAt([], 20, "verse", 60);
    expect(two.map((s) => [s.startSec, s.kind])).toEqual([[0, "intro"], [20, "verse"]]);

    expect(removePart(song, 1).map((s) => s.label)).toEqual(["Intro", "Coro"]);
    const first = removePart(song, 0);
    expect(first[0]!.startSec).toBe(0);
    expect(first[0]!.kind).toBe("verse");
    expect(removePart([song[0]!], 0)).toHaveLength(1); // at least one part

    const twoChoruses = setKind(song, 1, "chorus");
    expect(twoChoruses.map((s) => s.label)).toEqual(["Intro", "Coro 1", "Coro 2"]);
    expect(rename(song, 2, "  Coro final ")[2]!.label).toBe("Coro final");
    expect(rename(song, 2, "   ")).toBe(song);
  });

  it("undoes and redoes", () => {
    let h = historyOf(1);
    h = pushHistory(h, 2);
    h = pushHistory(h, 3);
    h = pushHistory(h, 3); // same state: no new step
    expect(h.past).toEqual([1, 2]);
    h = undo(undo(h));
    expect(h.present).toBe(1);
    h = redo(h);
    expect(h.present).toBe(2);
    h = pushHistory(h, 9);
    expect(h.future).toEqual([]);
  });
});

describe("setlists and shortcuts", () => {
  it("formats durations", () => {
    expect(formatDuration(45)).toBe("45 s");
    expect(formatDuration(23 * 60 + 10)).toBe("23 min");
    expect(formatDuration(3900)).toBe("1 h 05 min");
  });

  it("names keys and finds actions", () => {
    expect(keyName({ key: " ", code: "Space" })).toBe("Space");
    expect(keyName({ key: "l" })).toBe("L");
    expect(keyName({ key: " ", code: "Space", shiftKey: true })).toBe("Shift+Space");
    expect(keyName({ key: "Shift", shiftKey: true })).toBe("");
    expect(actionFor(DEFAULT_SHORTCUTS, "ArrowRight")).toBe("nextPart");
    expect(actionFor(DEFAULT_SHORTCUTS, "Q")).toBeNull();
    expect(keyLabel("Shift+Space")).toBe("Mayús + Espacio");
    expect(withDefaults({ loopPart: "B" }).loopPart).toBe("B");
    expect(withDefaults(null).playPause).toBe("Space");
  });
});
