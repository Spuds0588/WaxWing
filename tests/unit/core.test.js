// Pure-logic unit tests (run with `bun test`, no browser needed).
// These lock in the geometry and data-plane invariants that mobile and
// desktop rendering both depend on.

import { describe, expect, test } from "bun:test";
import { autoRects, mixedRects } from "../../js/stage.js";
import { clamp, coverCrop, fmtBytes, randomRoomCode, safeName } from "../../js/util.js";
import { ROOM_CODE_ALPHABET, SYNC } from "../../js/config.js";
import { uploadBlob } from "../../js/sync.js";
import { mixAssignments } from "../../js/audio-bus.js";

const EPS = 1e-9;

describe("autoRects (stage layouts)", () => {
  for (const count of [1, 2, 3, 4, 5]) {
    test(`produces ${count} in-bounds, non-overlapping tiles`, () => {
      const rects = autoRects(count);
      expect(rects).toHaveLength(count);
      for (const r of rects) {
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.w).toBeGreaterThan(0);
        expect(r.h).toBeGreaterThan(0);
        expect(r.x + r.w).toBeLessThanOrEqual(1 + EPS);
        expect(r.y + r.h).toBeLessThanOrEqual(1 + EPS);
      }
      // Pairwise non-overlap.
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i];
          const b = rects[j];
          const overlapX = a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS;
          const overlapY = a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS;
          expect(overlapX && overlapY).toBe(false);
        }
      }
    });
  }

  test("side-by-side (2) splits horizontally", () => {
    const [a, b] = autoRects(2);
    expect(a.y).toBeCloseTo(b.y);
    expect(a.w).toBeCloseTo(b.w);
    expect(b.x).toBeGreaterThan(a.x);
  });

  test("grid (4) uses two even rows and columns", () => {
    const [a, , , d] = autoRects(4);
    expect(a.w).toBeCloseTo(d.w);
    expect(a.h).toBeCloseTo(d.h);
    expect(d.x + d.w).toBeLessThanOrEqual(1 + EPS);
    expect(d.y + d.h).toBeLessThanOrEqual(1 + EPS);
  });
});

describe("mixedRects (presentation layout: screens on top, cameras below)", () => {
  for (const s of [1, 2, 3, 4]) {
    for (const c of [1, 2, 3, 4]) {
      test(`${s} screen(s) + ${c} camera(s): in-bounds, non-overlapping, screens above cameras`, () => {
        const { screens, cams } = mixedRects(s, c);
        expect(screens).toHaveLength(s);
        expect(cams).toHaveLength(c);
        const all = [...screens, ...cams];
        for (const r of all) {
          expect(r.w).toBeGreaterThan(0);
          expect(r.h).toBeGreaterThan(0);
          expect(r.x + r.w).toBeLessThanOrEqual(1 + EPS);
          expect(r.y + r.h).toBeLessThanOrEqual(1 + EPS);
        }
        for (let i = 0; i < all.length; i++) {
          for (let j = i + 1; j < all.length; j++) {
            const a = all[i];
            const b = all[j];
            const overlapX = a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS;
            const overlapY = a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS;
            expect(overlapX && overlapY).toBe(false);
          }
        }
        // Every camera sits in the strip below the screen band.
        const minCamTop = Math.min(...cams.map((r) => r.y));
        const maxScreenBottom = Math.max(...screens.map((r) => r.y + r.h));
        expect(minCamTop).toBeGreaterThanOrEqual(maxScreenBottom + EPS);
        // Cameras share one row.
        const tops = new Set(cams.map((r) => r.y.toFixed(4)));
        expect(tops.size).toBe(1);
      });
    }
  }

  test("screens with no cameras fill the whole stage like autoRects", () => {
    const { screens, cams } = mixedRects(3, 0);
    expect(cams).toEqual([]);
    expect(screens).toEqual(autoRects(3));
  });
});

describe("coverCrop", () => {
  test("matches aspect: no crop, centered", () => {
    const c = coverCrop(1920, 1080, 1280, 720);
    expect(c.dw).toBe(1920);
    expect(c.dh).toBe(1080);
    expect(c.dx).toBe(0);
    expect(c.dy).toBe(0);
  });

  test("covers wide outer with tall inner (4:3 into 16:9)", () => {
    const c = coverCrop(1920, 1080, 640, 480);
    expect(c.dw).toBeGreaterThanOrEqual(1920 - EPS);
    expect(c.dh).toBeGreaterThanOrEqual(1080 - EPS);
    expect(c.dx).toBe(0); // width-limited
    expect(c.dy).toBeLessThan(0); // cropped top/bottom, centered
  });

  test("keeps the source aspect ratio (no distortion)", () => {
    // Square source into a 2:1 tile: the drawn region stays 1:1 and is
    // cropped vertically (covers everything, never squishes).
    const c = coverCrop(200, 100, 100, 100);
    expect(c.dw / c.dh).toBeCloseTo(1);
    expect(c.dh).toBeGreaterThanOrEqual(100 - EPS);
    expect(c.dw).toBeGreaterThanOrEqual(200 - EPS);
  });
});

describe("room codes", () => {
  test("default length 6 and only un-ambiguous alphabet chars", () => {
    for (let i = 0; i < 200; i++) {
      const code = randomRoomCode();
      expect(code).toHaveLength(6);
      for (const ch of code) expect(ROOM_CODE_ALPHABET).toContain(ch);
    }
  });
  test("respects custom length", () => {
    expect(randomRoomCode(4)).toHaveLength(4);
  });
});

describe("uploadBlob chunking", () => {
  test("sends every byte in <=16KB ordered chunks with final progress", async () => {
    const size = 200_000; // not a multiple of the chunk size on purpose
    const payload = new Uint8Array(size).fill(0xab);
    const blob = new Blob([payload]);
    const sent = [];
    const progress = [];

    await uploadBlob({
      send: (bytes) => sent.push(new Uint8Array(bytes)),
      buffered: () => 0,
      waitLow: async () => {},
      blob,
      onProgress: (p) => progress.push(p),
    });

    const total = sent.reduce((sum, c) => sum + c.length, 0);
    expect(total).toBe(size);
    for (const c of sent) {
      expect(c.length).toBeLessThanOrEqual(SYNC.chunkSize);
    }
    // Chunks reassemble to the original bytes.
    const reassembled = new Uint8Array(size);
    let offset = 0;
    for (const c of sent) {
      reassembled.set(c, offset);
      offset += c.length;
    }
    expect(Buffer.from(reassembled).equals(Buffer.from(payload))).toBe(true);
    // Progress ends exactly at the file size.
    expect(progress.at(-1)).toEqual({ sent: size, size });
  });

  test("paces itself when the data-channel buffer fills", async () => {
    // Force the bufferedAmount over the high-water mark: the loop must
    // pause via waitLow instead of flooding the channel.
    const blob = new Blob([new Uint8Array(64 * 1024)]);
    let waits = 0;
    await uploadBlob({
      send: () => {},
      buffered: () => SYNC.highWaterMark + 1,
      waitLow: async () => {
        waits++;
      },
      blob,
    });
    expect(waits).toBeGreaterThan(0);
  });
});

describe("mixAssignments (nobody hears themselves)", () => {
  const keys = ["self", "g1", "g2"];

  test("the host's speakers carry only remote voices", () => {
    const plan = mixAssignments(keys, ["g1", "g2"]);
    expect(plan.monitor).not.toContain("self");
    expect([...plan.monitor].sort()).toEqual(["g1", "g2"]);
  });

  test("the master bus (stage recording source) carries every voice once", () => {
    const plan = mixAssignments(keys, ["g1", "g2"]);
    expect([...plan.master].sort()).toEqual(["g1", "g2", "self"]);
    expect(new Set(plan.master).size).toBe(plan.master.length);
  });

  test("each guest's stage bus excludes that guest but includes everyone else", () => {
    const plan = mixAssignments(keys, ["g1", "g2"]);
    for (const g of ["g1", "g2"]) {
      expect(plan.guests[g]).not.toContain(g); // no self-echo on the stage
      expect(plan.guests[g]).toContain("self");
      const others = keys.filter((k) => k !== g);
      expect([...plan.guests[g]].sort()).toEqual([...others].sort());
    }
  });

  test("voice-only guest sets still exclude that guest from their own mix", () => {
    const plan = mixAssignments(["self", "mic1"], ["mic1"]);
    expect(plan.guests.mic1).toEqual(["self"]);
    expect(plan.monitor).toEqual(["mic1"]);
  });

  test("a lone host hears nothing on the monitor bus", () => {
    const plan = mixAssignments(["self"], []);
    expect(plan.monitor).toEqual([]);
    expect(plan.master).toEqual(["self"]);
  });

  test("a shared screen's audio follows its owner through every bus", () => {
    const keys = ["self", "g1", "screen:self", "screen:g1"];
    const screenOf = { "screen:self": "self", "screen:g1": "g1" };
    const plan = mixAssignments(keys, ["g1"], screenOf);
    // Master (Director's Cut / monitoring source of truth): every voice AND
    // every shared screen's audio, exactly once.
    expect([...plan.master].sort()).toEqual(["g1", "screen:g1", "screen:self", "self"]);
    expect(new Set(plan.master).size).toBe(plan.master.length);
    // Speakers: remote voices + remote screen audio — never the host's own
    // mic and never the host's own screen (that would loop the tab back
    // into its own capture).
    expect([...plan.monitor].sort()).toEqual(["g1", "screen:g1"]);
    // Guest g1's stage bus: everyone except g1's mic AND g1's screen audio
    // (both would echo back at g1 through the stage call).
    expect([...plan.guests.g1].sort()).toEqual(["screen:self", "self"]);
  });

  test("a listener sharing a screen: only the screen audio mixes", () => {
    const keys = ["self", "screen:g2"];
    const screenOf = { "screen:g2": "g2" };
    const plan = mixAssignments(keys, ["g2"], screenOf);
    expect(plan.guests.g2).toEqual(["self"]); // g2 hears the host, not their own tab
    expect(plan.monitor).toEqual(["screen:g2"]); // the host hears g2's tab
    expect([...plan.master].sort()).toEqual(["screen:g2", "self"]);
  });
});

describe("formatters & sanitizers", () => {
  test("fmtBytes scales units", () => {
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(1536)).toBe("1.5 KB");
  });
  test("safeName strips filesystem-hostile characters", () => {
    expect(safeName('Bob "quoted" / name')).toBe("Bob_quoted_name");
    expect(safeName("../../etc/passwd")).toBe("_.._etc_passwd");
    expect(safeName(".hidden")).toBe("hidden");
    expect(safeName("..")).toBe("participant");
    expect(safeName("")).toBe("participant");
  });
  test("clamp", () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-2, 0, 1)).toBe(0);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });
});
