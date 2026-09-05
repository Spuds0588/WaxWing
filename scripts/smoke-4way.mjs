// WaxWing — four-person smoke test (run locally: bun run smoke:4way)
//
// The PRD's max call: ONE desktop host + THREE guests (phones + laptop),
// each a real Chromium tab with Playwright's fake camera/microphone, walking
// the genuine product flow over real WebRTC:
//
//   host:  landing -> studio preflight -> room code
//   guests: invite link -> join (x3, one at a time) -> host sees each land
//   stage: full house — host's stage shows 4 live tiles (self + 3), every
//          guest is "On air" and decoding the 1080p composited broadcast
//   record: Record -> host + all 3 guests record local masters in sync
//   stop:   Stop -> all 3 guest masters stream back over their data channels
//          and land in the host's recording folder (host's own row: saved)
//
// Signaling uses a LOCAL PeerJS server (ws://127.0.0.1); media + files still
// travel peer-to-peer. showDirectoryPicker is swapped for an in-memory twin;
// every byte of the recorder + sync path is the real production code.
//
// Requires: chromium + system libs (see scripts/smoke-2tab.mjs header).

import { chromium } from "playwright";
import { spawn, spawnSync } from "node:child_process";

const WEB_PORT = 5201;
const SIG_PORT = 5202;
const WEB_BASE = `http://127.0.0.1:${WEB_PORT}/`;
const PIXEL_UA =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

// ---- tiny helpers ---------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(page, fn, { timeout = 40_000, label = "condition", every = 400 } = {}) {
  const deadline = Date.now() + timeout;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      lastErr = err;
    }
    await sleep(every);
  }
  throw new Error(`Timed out after ${timeout}ms waiting for ${label}${lastErr ? ` (${lastErr.message})` : ""}`);
}

async function waitPort(url, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {}
    await sleep(250);
  }
  return false;
}

// In-memory stand-in for the OS directory picker — same shape fs.js expects.
// Exposes window.__WW_FILES__ (fileName -> bytes written) so the smoke can
// prove real media landed in the folder, not just that the UI turned green.
const DIR_STUB = `() => {
  const store = new Map();
  const sizes = {};
  window.__WW_FILES__ = sizes;
  return {
    name: "WaxWing-Smoke",
    queryPermission: async () => "granted",
    requestPermission: async () => "granted",
    getFileHandle: async (fileName) => {
      if (!store.has(fileName)) store.set(fileName, []);
      const parts = store.get(fileName);
      return {
        async createWritable() {
          let size = 0;
          const stream = new WritableStream({ write(chunk) { parts.push(chunk); size += (chunk && chunk.byteLength) || chunk?.size || 0; } });
          const writer = stream.getWriter();
          return {
            write: (c) => writer.write(c),
            close: async () => { await writer.close(); sizes[fileName] = (sizes[fileName] || 0) + size; },
          };
        },
        async getFile() { return new File(parts, fileName, { type: "video/webm" }); },
      };
    },
  };
}`;

// Point the app at the local signaling server (read by js/network.js).
const SIG_OVERRIDE = `window.__WW_PEER__ = { host: "127.0.0.1", port: ${SIG_PORT}, path: "/", secure: false, key: "peerjs" };`;

// Fake-camera capture clamp: four live tabs encode a lot — keep masters small.
const CAM_CLAMP = `(() => {
  const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  const cap = (v) => {
    if (!v || typeof v !== "object") return v;
    const limit = (c, ideal, max) => ({
      ...c,
      width: { ...(c.width || {}), ideal: Math.min(c.width?.ideal || ideal, ideal), max: Math.min(c.width?.max || max, max) },
      height: { ...(c.height || {}), ideal: Math.min(c.height?.ideal || max, ideal), max: Math.min(c.height?.max || max, max) },
    });
    return limit(v, 960, 960);
  };
  navigator.mediaDevices.getUserMedia = (c) =>
    orig({ audio: c.audio, video: cap(c.video) });
})();`;

// Live DOM read of a tab at failure time (locator-based).
async function stateDump(tag, page) {
  const rd = async (loc) => {
    try {
      const t = await loc.textContent({ timeout: 1500 });
      return (t || "").trim().slice(0, 120) || "(empty)";
    } catch (e) {
      return `ERR ${String(e.message).slice(0, 80)}`;
    }
  };
  const url = await page.url().catch((e) => `ERR ${String(e.message).slice(0, 80)}`);
  const pill = await rd(page.locator("#connPill"));
  const count = await rd(page.locator("#guestCountBadge"));
  const rows = await page.locator("#guestList .guest-row").count().catch(() => -1);
  const tiles = await page.locator("#stage .tile").count().catch(() => -1);
  const rec = await rd(page.locator("#recRowSelf .rec-state"));
  const fatal = await page
    .locator("#fatalPanel")
    .isVisible({ timeout: 1200 })
    .then(async (v) => (v ? await rd(page.locator("#fatalMessage")) : "(hidden)"))
    .catch(() => "ERR");
  console.log(`[${tag}] url=${url} | pill=${pill} | guests=${count} rows=${rows} tiles=${tiles} | selfRec=${rec} | fatal=${fatal}`);
}

const pageLog = (page, tag) => {
  const lines = [];
  page.on("console", (m) => {
    if (m.type() === "error") {
      const t = m.text();
      if (t.length < 900) lines.push(`[${tag}] console.error: ${t}`);
    }
  });
  page.on("pageerror", (e) => lines.push(`[${tag}] pageerror: ${e}`));
  return () => {
    const extra = page
      .evaluate(() => {
        const pick = (sel) => document.querySelector(sel)?.textContent?.trim().slice(0, 140) || null;
        return { pill: pick("#connPill"), fatalTitle: pick("#fatalTitle"), fatalMsg: pick("#fatalMessage") };
      })
      .catch(() => ({}));
    return [...lines, `[${tag}] pill/fatal: ${JSON.stringify(extra)}`];
  };
};

// ---- the smoke ------------------------------------------------------------

const pages = {}; // host, gA, gB, gC
const dumps = {};
const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;

const results = [];
const step = async (name, fn) => {
  const at = Date.now();
  try {
    await fn();
    results.push({ ok: true, name, ms: Date.now() - at });
    console.log(`  \u2713 ${name} (${((Date.now() - at) / 1000).toFixed(1)}s)`);
  } catch (err) {
    results.push({ ok: false, name, ms: Date.now() - at, err });
    console.log(`  \u2717 ${name} \u2014 ${err?.message || err}`);
    for (const [tag, p] of Object.entries(pages)) {
      console.log(`--- ${tag} state ---`);
      for (const l of (dumps[tag] || (() => [])).call().slice(0, 30)) console.log(l);
      await stateDump(tag, p).catch(() => {});
    }
    console.log("--- signaling server ---");
    console.log(sigLogs.join("").slice(-1500) || "(none)");
  }
};

const GUESTS = [
  { key: "gA", name: "Ann", kind: "phone portrait" },
  { key: "gB", name: "Bo", kind: "laptop" },
  { key: "gC", name: "Cat", kind: "phone landscape" },
];

console.log("Building static bundle\u2026");
const build = spawnSync("bunx", ["vite", "build"], { stdio: "ignore" });
if (build.status !== 0) {
  console.error("vite build failed");
  process.exit(2);
}

// Local PeerJS signaling server (WS to 127.0.0.1 — no external network needed).
const sigLogs = [];
const sig = spawn("./node_modules/.bin/peerjs", ["--port", String(SIG_PORT)], { stdio: ["ignore", "pipe", "pipe"] });
sig.stdout.on("data", (d) => sigLogs.push(d.toString()));
sig.stderr.on("data", (d) => sigLogs.push(d.toString()));

const web = spawn("bunx", ["vite", "preview", "--port", String(WEB_PORT), "--strictPort"], { stdio: "ignore" });

try {
  if (!(await waitPort(`http://127.0.0.1:${SIG_PORT}/`))) throw new Error("local signaling server did not start");
  if (!(await waitPort(WEB_BASE))) throw new Error("vite preview did not start");

  const browser = await chromium.launch({
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      "--disable-dev-shm-usage",
    ],
  });

  const hostCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const guestCtxs = [
    { key: "gA", ctx: await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, userAgent: PIXEL_UA }) },
    { key: "gB", ctx: await browser.newContext({ viewport: { width: 1280, height: 800 } }) },
    { key: "gC", ctx: await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, userAgent: PIXEL_UA }) },
  ];
  for (const ctx of [hostCtx, ...guestCtxs.map((g) => g.ctx)]) {
    await ctx.addInitScript(SIG_OVERRIDE);
    await ctx.addInitScript(`window.showDirectoryPicker = ${DIR_STUB};`);
    await ctx.addInitScript(CAM_CLAMP);
  }

  pages.host = await hostCtx.newPage();
  for (const { key, ctx } of guestCtxs) pages[key] = await ctx.newPage();
  for (const [tag, p] of Object.entries(pages)) {
    p.on("crash", () => console.log(`[${tag}] PAGE CRASHED @ ${ts()}`));
    p.on("close", () => console.log(`[${tag}] page closed @ ${ts()}`));
    dumps[tag] = pageLog(p, tag);
  }
  console.log(`t0 @ ${ts()}: 4 pages up (host + ${GUESTS.map((g) => g.name).join(", ")})`);

  // 1) host: selling home -> studio preflight -> room code
  await step("Host: landing page loads and funnels into the studio", async () => {
    const host = pages.host;
    await host.goto(WEB_BASE, { waitUntil: "networkidle" });
    await waitFor(host, () => host.locator("#landing .land-hero").isVisible(), { label: "landing hero" });
    await host.locator("#landing .land-hero [data-start]").click();
    await waitFor(host, () => host.locator("#welcomeModal").isVisible(), { label: "preflight modal" });
  });

  await step("Host: enters the studio, gets the room code", async () => {
    const host = pages.host;
    await host.fill("#nameInput", "Host D");
    await host.click("#btnEnter");
    await waitFor(host, () => host.locator("#welcomeModal").isHidden(), { label: "modal to close" });
    const code = await waitFor(
      host,
      () =>
        host.locator("#roomChipCode").textContent().then((t) => {
          const c = (t || "").trim();
          return /^[A-Z2-9]{6}$/.test(c) ? c : null;
        }),
      { label: "room code" },
    );
    globalThis.roomCode = code;
    await waitFor(host, () => host.locator("#stageEmpty").isVisible(), { label: "stage empty state" });
  });

  // 2) each guest joins via the invite link (serial; host count climbs 1->3)
  for (let i = 0; i < GUESTS.length; i++) {
    const { key, name, kind } = GUESTS[i];
    await step(`Guest ${name} (${kind}) joins via the invite link`, async () => {
      const g = pages[key];
      await g.goto(`${WEB_BASE}?room=${globalThis.roomCode}`, { waitUntil: "networkidle" });
      await waitFor(g, () => g.locator("#welcomeModal").isVisible(), { label: "guest preflight" });
      const body = await g.locator("body").getAttribute("class");
      if (!body.includes("guest-mode")) throw new Error("guest page not in guest-mode");
      await g.fill("#nameInput", name);
      await g.click("#btnEnter");
      await waitFor(g, () => g.locator("#welcomeModal").isHidden(), { label: "guest modal to close" });
      await waitFor(
        pages.host,
        () => pages.host.locator("#guestCountBadge").textContent().then((t) => t?.includes(`${i + 1}/3`)),
        { timeout: 90_000, label: `host badge ${i + 1}/3` },
      );
      await waitFor(
        pages.host,
        () => pages.host.locator("#guestList").textContent().then((t) => t?.includes(name)),
        { label: `host row for ${name}` },
      );
    });
  }

  // 3) full house on the host's stage: self + 3 guests, 4 live tiles
  await step("Host stage: 4 live tiles (self + 3 guests) in a 2x2 arrangement", async () => {
    const host = pages.host;
    await waitFor(host, () => host.locator("#stageEmpty").isHidden(), { label: "stage empty to hide" });
    await waitFor(
      host,
      () =>
        host.evaluate(() => {
          const tiles = [...document.querySelectorAll("#stage .tile")];
          if (tiles.length !== 4) return false;
          const names = tiles.map((t) => t.querySelector(".tile-name")?.textContent?.trim()).filter(Boolean).sort();
          const want = ["Ann", "Bo", "Cat", "Host D"].sort();
          return JSON.stringify(names) === JSON.stringify(want);
        }),
      { timeout: 60_000, label: "4 tiles named Host D / Ann / Bo / Cat" },
    );
    // Give the composer a moment to ingest everyone, then require frames.
    await sleep(2500);
    await waitFor(
      host,
      () =>
        host.evaluate(() => {
          const videos = [...document.querySelectorAll("#stage .tile video")];
          return videos.length === 4 && videos.every((v) => v.videoWidth > 0 && !v.paused);
        }),
      { timeout: 60_000, label: "all 4 stage tiles decode live video" },
    );
  });

  // 4) every guest is receiving the composited 4-up broadcast
  await step("Guests Ann/Bo/Cat: all 'On air', decoding the composited stage", async () => {
    for (const { key, name } of GUESTS) {
      const g = pages[key];
      await waitFor(g, () => g.locator("#connPill").textContent().then((t) => t?.includes("On air")), {
        timeout: 90_000,
        label: `${name} On air`,
      });
      await waitFor(
        g,
        () =>
          g.evaluate(() => {
            const v = document.querySelector(".stage-video-fill");
            return v && v.videoWidth > 0 && !v.paused;
          }),
        { timeout: 90_000, label: `${name} decodes stage frames` },
      );
    }
  });

  // 5) Record: one click starts FOUR local masters (host + all guests)
  await step("Host: Record starts host + 3 guest local masters", async () => {
    await pages.host.click("#btnRecord");
    await waitFor(pages.host, () => pages.host.locator("#recChip").isVisible(), { label: "host REC chip" });
    for (const { key, name } of GUESTS) {
      await waitFor(pages[key], () => pages[key].locator("#recChip").isVisible(), {
        timeout: 40_000,
        label: `${name} REC chip (auto-start)`,
      });
    }
    await sleep(4000); // let media accumulate in all four recorders
  });

  // 6) Stop: the host's run ends, every guest's master syncs back
  await step("Host: Stop syncs all 3 guest masters back over the data channels", async () => {
    const host = pages.host;
    await host.click("#btnRecord");
    await waitFor(host, () => host.locator("#syncModal").isVisible(), { timeout: 40_000, label: "host sync modal" });
    // Host's own master finished writing to the folder first.
    await waitFor(
      host,
      () => host.locator("#recRowSelf .rec-state").textContent().then((t) => t?.includes("Saved locally")),
      { timeout: 40_000, label: "host master saved locally" },
    );
    // Three guest rows appear and all finish; Close re-enables.
    await waitFor(
      host,
      () =>
        host.evaluate(() => {
          const rows = [...document.querySelectorAll("#syncList .sync-row")];
          const close = document.querySelector("#btnSyncClose");
          if (rows.length !== 3) return false;
          const names = rows.map((r) => r.querySelector(".sync-name")?.textContent?.trim() || "");
          const want = ["Ann", "Bo", "Cat"];
          return want.every((n) => names.includes(n)) && rows.every((r) => r.classList.contains("done")) && !close.disabled;
        }),
      { timeout: 180_000, label: "host sync rows (Ann/Bo/Cat) all done" },
    );
    // Each guest confirms its upload completed.
    for (const { key, name } of GUESTS) {
      await waitFor(
        pages[key],
        () =>
          pages[key].evaluate(() => {
            const s = document.querySelector("#syncList .sync-status");
            return s && /Sent/.test(s.textContent);
          }),
        { timeout: 180_000, label: `${name} upload confirmed` },
      );
    }
    // The host's folder must now hold FOUR real masters: its own + Ann/Bo/Cat.
    // Non-trivial byte counts prove the recorders produced media and the P2P
    // sync moved it — not empty webm headers or UI-only "done" states.
    await waitFor(
      host,
      () =>
        host.evaluate(() => {
          const files = window.__WW_FILES__ || {};
          const entries = Object.entries(files);
          return entries.length >= 4 && entries.every(([, bytes]) => bytes > 50_000) ? files : null;
        }),
      { timeout: 60_000, label: "4 masters (host + 3 guests) with real bytes in the folder" },
    ).then((files) => console.log(`    folder contents: ${JSON.stringify(files)}`));
  });

  await browser.close();
} catch (err) {
  console.error(`Fatal: ${err?.message || err}`);
  process.exitCode = 1;
} finally {
  try { sig.kill(); } catch {}
  try { web.kill(); } catch {}
}

const fails = results.filter((r) => !r.ok);
console.log(`\nSmoke summary: ${results.length - fails.length}/${results.length} passed`);
if (fails.length) {
  for (const f of fails) console.log(`  \u2717 ${f.name} \u2014 ${f.err?.message}`);
  process.exit(1);
}
