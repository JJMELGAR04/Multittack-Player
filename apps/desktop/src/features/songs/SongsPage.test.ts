import { describe, expect, it } from "vitest";
import type { LibrarySong } from "@/lib/ipc/types";
import { filterSongs, sortSongs } from "./SongsPage";

const song = (id: number, title: string, extra: Partial<LibrarySong> = {}): LibrarySong => ({
  id,
  title,
  artist: "",
  songKey: "",
  transpose: 0,
  originalBpm: null,
  targetBpm: null,
  timeSignature: "4/4",
  durationSec: null,
  trackCount: 5,
  sectionCount: 0,
  sourceArchive: null,
  createdAt: "2026-11-01T10:00:00.000Z",
  lastOpenedAt: "2026-11-01T10:00:00.000Z",
  ...extra,
});

const list = [
  song(1, "Way Maker", { originalBpm: 68, durationSec: 300, lastOpenedAt: "2026-11-10T10:00:00.000Z" }),
  song(2, "Canción de Gracia", { originalBpm: 96, targetBpm: 90, durationSec: 250, createdAt: "2026-11-15T10:00:00.000Z" }),
  song(3, "ancient", { originalBpm: 72, durationSec: 200 }),
];

describe("song library", () => {
  it("searches ignoring accents and case", () => {
    expect(filterSongs(list, "cancion").map((s) => s.id)).toEqual([2]);
    expect(filterSongs(list, "ANCIE").map((s) => s.id)).toEqual([3]);
    expect(filterSongs(list, "  ")).toHaveLength(3);
  });

  it("sorts by title, recent, added, BPM (playing tempo) and duration", () => {
    expect(sortSongs(list, "title").map((s) => s.title)).toEqual(["ancient", "Canción de Gracia", "Way Maker"]);
    expect(sortSongs(list, "recent")[0]!.id).toBe(1);
    expect(sortSongs(list, "added")[0]!.id).toBe(2);
    expect(sortSongs(list, "bpm").map((s) => s.id)).toEqual([1, 3, 2]); // 68, 72, 90 (target)
    expect(sortSongs(list, "duration").map((s) => s.id)).toEqual([3, 2, 1]);
  });
});
