import { describe, expect, it } from "vitest";
import { bufferMs, choiceLabel, driverLabel, formatRate, loadVerdict, outputChoices, outputLabel, routingFits, sortDriverTypes } from "./model";

describe("audio settings model", () => {
  it("names drivers and recommends ASIO first", () => {
    expect(driverLabel("Windows Audio (Exclusive Mode)")).toMatch(/exclusivo/);
    expect(driverLabel("Algo raro")).toBe("Algo raro");
    const sorted = sortDriverTypes([
      { name: "Windows Audio" },
      { name: "Windows Audio (Low Latency Mode)" },
      { name: "ASIO" },
      { name: "Windows Audio (Exclusive Mode)" },
    ]).map((t) => t.name);
    expect(sorted).toEqual(["ASIO", "Windows Audio (Exclusive Mode)", "Windows Audio", "Windows Audio (Low Latency Mode)"]);
  });

  it("labels outputs, rates and latency", () => {
    expect(outputLabel(0, ["Output channel 1"])).toBe("Salida 1");
    expect(outputLabel(2, ["a", "b", "Line Out 3"])).toBe("Salida 3 · Line Out 3");
    expect(outputLabel(5, undefined)).toBe("Salida 6");
    expect(formatRate(48000)).toBe("48 kHz");
    expect(formatRate(44100)).toBe("44,1 kHz");
    expect(bufferMs(480, 48000)).toBe(10);
    expect(choiceLabel(2, true, undefined)).toBe("Salidas 3-4");
  });

  it("validates routing like the engine", () => {
    // 2-output interface: band on one, click on the other (either way).
    expect(routingFits("split", 0, 1, 2)).toBe(true);
    expect(routingFits("split", 1, 0, 2)).toBe(true);
    expect(routingFits("split", 1, 1, 2)).toBe(false);
    expect(routingFits("split", 0, 2, 2)).toBe(false);
    expect(routingFits("stereo", 0, 0, 2)).toBe(true);
    expect(routingFits("stereo", 1, 0, 2)).toBe(false);
    expect(routingFits("quad", 0, 2, 4)).toBe(true);
    expect(routingFits("quad", 0, 1, 4)).toBe(false); // overlapping pairs
    expect(routingFits("quad", 0, 2, 2)).toBe(false);
    expect(outputChoices("split", 2).map((c) => c.value)).toEqual([0, 1]);
    expect(outputChoices("stereo", 4).map((c) => c.value)).toEqual([0, 1, 2]);
  });

  it("explains the CPU load", () => {
    expect(loadVerdict(0.1).tone).toBe("ok");
    expect(loadVerdict(0.6).tone).toBe("warn");
    expect(loadVerdict(0.95).tone).toBe("bad");
  });
});
