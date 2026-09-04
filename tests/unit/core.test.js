// Pure-logic unit tests (run with `bun test`, no browser needed).
// These lock in the geometry and data-plane invariants that mobile and
// desktop rendering both depend on.

import { describe, expect, test } from "bun:test";
import { autoRects } from "../../js/stage.js";
import { clamp, coverCrop, fmtBytes, randomRoomCode, safeName } from "../../js/util.js";
import { ROOM_CODE_ALPHABET, SYNC } from "../../js/config.js";
import { uploadBlob } from "../../js/sync.js";

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
