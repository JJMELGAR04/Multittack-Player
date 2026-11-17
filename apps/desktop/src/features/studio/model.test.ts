import { describe, expect, it } from "vitest";
import type { SectionRecord } from "@/lib/ipc/types";
import {
  moveItem,
  barBeat,
  effectiveGains,
  meterFraction,
  textOn,
  dbToGain,
  formatBpm,
  formatDb,
  formatPercent,
  formatTime,
  gainToDb,
  renumber,
  sectionAt,
  snapToBar,
  tapTempo,
  tempoQuality,
  withEnds,
} from "./model";

const sec = (startSec: number, kind: SectionRecord["kind"], label: string): SectionRecord => ({
  startSec,
  kind,
  label,
  source: "auto",
});

describe("formatting", () => {
  it("formats song time", () => {
    expect(formatTime(0)).toBe("0:00.0");
    expect(formatTime(65.34)).toBe("1:05.3");
    expect(formatTime(600, 0)).toBe("10:00");
    expect(formatTime(-3)).toBe("0:00.0");
  });

  it("formats BPM and percentages", () => {
    expect(formatBpm(72)).toBe("72");
    expect(formatBpm(71.96)).toBe("72");
    expect(formatBpm(96.25)).toBe("96.3");
    expect(formatPercent(1)).toBe("0 %");
    expect(formatPercent(68 / 72)).toBe("−5.6 %");
    expect(formatPercent(1.1)).toBe("+10 %");
  });
});

describe("volume", () => {
  it("converts dB and gain both ways", () => {
    expect(dbToGain(0)).toBe(1);
    expect(dbToGain(-60)).toBe(0);
    expect(dbToGain(6)).toBeCloseTo(1.995, 3);
    expect(gainToDb(1)).toBe(0);
    expect(gainToDb(0)).toBe(-60);
    expect(gainToDb(dbToGain(-12))).toBeCloseTo(-12, 6);
    expect(formatDb(-60)).toBe("−∞ dB");
    expect(formatDb(-3.04)).toBe("−3.0 dB");
    expect(formatDb(2)).toBe("+2.0 dB");
  });
});

describe("tempo", () => {
  it("classifies time-stretch transparency", () => {
    expect(tempoQuality(1)).toBe("original");
    expect(tempoQuality(68 / 72)).toBe("excellent");
    expect(tempoQuality(1.15)).toBe("veryGood");
    expect(tempoQuality(0.78)).toBe("good");
    expect(tempoQuality(1.4)).toBe("audible");
  });

  it("computes tap tempo from steady taps and ignores old taps", () => {
    const taps = [0, 500, 1000, 1500, 2000]; // 120 BPM
    expect(tapTempo(taps)).toBe(120);
    expect(tapTempo([0, 500])).toBeNull();
    // A long pause starts a new measurement.
    expect(tapTempo([0, 500, 1000, 9000, 9600, 10200])).toBe(100);
  });
});

describe("track order", () => {
  it("moves an item up or down", () => {
    expect(moveItem(["click", "cues", "drums", "bass"], 3, 2)).toEqual(["click", "cues", "bass", "drums"]);
    expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveItem(["a", "b"], 5, 0)).toEqual(["a", "b"]);
  });
});

describe("mixer and meters", () => {
  it("applies mute and solo like a console", () => {
    expect(effectiveGains([0, 0, -6], [false, true, false], [false, false, false])).toEqual([1, 0, dbToGain(-6)]);
    // Solo: only soloed tracks sound, even if muted ones exist.
    expect(effectiveGains([0, 0, 0], [false, true, false], [false, true, false])).toEqual([0, 1, 0]);
    expect(effectiveGains([-60, 0], [false, false], [false, false])).toEqual([0, 1]);
  });

  it("maps peaks to the meter scale and finds bar/beat", () => {
    expect(meterFraction(0)).toBe(0);
    expect(meterFraction(1)).toBeCloseTo(60 / 66, 6);
    expect(meterFraction(10)).toBe(1);
    expect(barBeat(0, 96, 0, 4)).toEqual({ bar: 1, beat: 1 });
    expect(barBeat(2.5 * 3 + 0.625 * 2 + 0.01, 96, 0, 4)).toEqual({ bar: 4, beat: 3 });
    expect(barBeat(10, null, 0, 4)).toBeNull();
    expect(textOn("#e8c21b")).toBe("#0a0b0d");
    expect(textOn("#1d4ed8")).toBe("#ffffff");
  });
});

describe("sections", () => {
  const list = [sec(30, "chorus", "Coro 1"), sec(0, "intro", "Intro"), sec(10, "verse", "Estrofa 1")];

  it("sorts and computes ends", () => {
    const timed = withEnds(list, 50);
    expect(timed.map((s) => s.label)).toEqual(["Intro", "Estrofa 1", "Coro 1"]);
    expect(timed.map((s) => s.endSec)).toEqual([10, 30, 50]);
    expect(sectionAt(timed, 0)).toBe(0);
    expect(sectionAt(timed, 29.9)).toBe(1);
    expect(sectionAt(timed, 45)).toBe(2);
  });

  it("renumbers default labels but keeps custom names", () => {
    const out = renumber([
      sec(50, "chorus", "Coro"),
      sec(30, "chorus", "Coro 1"),
      sec(10, "verse", "Estrofa 1"),
      sec(70, "verse", "Verso final"),
    ]);
    // The custom-named verse still counts as a verse, so the other one is "Estrofa 1".
    expect(out.map((s) => s.label)).toEqual(["Estrofa 1", "Coro 1", "Coro 2", "Verso final"]);
  });

  it("snaps to the bar grid when the tempo is known", () => {
    // 96 BPM -> 2.5 s bars, grid starting at 0.5 s
    expect(snapToBar(10.9, 96, 0.5)).toBeCloseTo(10.5, 9);
    expect(snapToBar(12.0, 96, 0.5)).toBeCloseTo(13.0, 9);
    expect(snapToBar(12.0, null, 0)).toBe(12.0);
    expect(snapToBar(-1, 96, 0)).toBe(0);
  });
});
