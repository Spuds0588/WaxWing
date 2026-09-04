// WaxWing — two-browser smoke test (run locally: bun run smoke:2tab)
//
// Opens TWO real browser contexts against the built app — a desktop host and
// a phone-sized guest — with Playwright's fake camera/microphone, then walks
// the real user flow end to end:
//
//   host:  landing -> studio preflight -> room code + waiting
//   guest: invite link -> join -> proxy AV + data channel reach the host
//   host:  composited stage stream reaches the guest ("On air", frames decode)
//   host:  Record -> guests auto-record -> Stop -> guest master streams back
//          over the data channel and lands in the host's recording folder
//
// Signaling uses a LOCAL PeerJS server (ws://127.0.0.1) so the test also runs
// on networks that block external WebSockets; media + files still travel
// directly peer-to-peer between the two tabs over WebRTC.
//
// File System Access can't show a native folder dialog headless, so the app's
// showDirectoryPicker is swapped for an in-memory stand-in that behaves
// identically (granted permission, real WritableStream per file). Everything
// else — WebRTC, MediaRecorder, chunked P2P sync — is the real production code.
//
// Requires: chromium + system libs (bunx playwright install chromium &&
// bunx playwright install-deps chromium).

import { chromium } from "playwright";
import { spawn, spawnSync } from "node:child_process";

const WEB_PORT = 5197;
const SIG_PORT = 5198;
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

// In-memory stand-in for the OS directory picker: same shape fs.js expects
// (queryPermission/requestPermission/getFileHandle), real WritableStream per
// file, so the app runs its normal "direct to disk" sink path and every byte
// still flows through the P2P sync.
const DIR_STUB = `() => {
  const store = new Map();
  return {
    name: "WaxWing-Smoke",
    queryPermission: async () => "granted",
    requestPermission: async () => "granted",
    getFileHandle: async (fileName) => {
      if (!store.has(fileName)) store.set(fileName, []);
      const parts = store.get(fileName);
      return {
        async createWritable() {
          // fs.js calls write()/close() directly on the handle's stream,
          // like the real FileSystemWritableFileStream — delegate to a
          // persistent writer so back-to-back writes stay ordered.
          const stream = new WritableStream({ write(chunk) { parts.push(chunk); } });
          const writer = stream.getWriter();
          return { write: (c) => writer.write(c), close: () => writer.close() };
        },
        async getFile() { return new File(parts, fileName, { type: "video/webm" }); },
      };
    },
  };
}`;

// Point the app at the local signaling server (read by js/network.js).
const SIG_OVERRIDE = `window.__WW_PEER__ = { host: "127.0.0.1", port: ${SIG_PORT}, path: "/", secure: false, key: "peerjs" };`;  // Live DOM read of a tab at failure time (locator-based so a dead or busy
  // frame reports precisely instead of silently returning {}).
  async function stateDump(tag, page) {
    const rd = async (loc) => {
      try {
        const t = await loc.textContent({ timeout: 2000 });
        return (t || "").trim().slice(0, 120) || "(empty)";
      } catch (e) {
        return `ERR ${String(e.message).slice(0, 90)}`;
      }
    };
    const url = await page.url().catch((e) => `ERR ${String(e.message).slice(0, 90)}`);
    const pill = await rd(page.locator("#connPill"));
    const count = await rd(page.locator("#guestCountBadge"));
    const rows = await page.locator("#guestList .guest-row").count().catch(() => -1);
    const fatal = await page
      .locator("#fatalPanel")
      .isVisible({ timeout: 1500 })
      .then(async (v) => (v ? await rd(page.locator("#fatalMessage")) : "(hidden)"))
      .catch(() => "ERR");
    console.log(`[${tag}] url=${url} | pill=${pill} | guests=${count} rows=${rows} | fatal=${fatal}`);
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
    const extra = page.evaluate(() => {
      const pick = (sel) => document.querySelector(sel)?.textContent?.trim().slice(0, 140) || null;
      return {
        pill: pick("#connPill"),
        fatalTitle: pick("#fatalTitle"),
        fatalMsg: pick("#fatalMessage"),
        toast: pick(".toast, #toasts, [class*='toast']") || pick(".notify"),
      };
    }).catch(() => ({}));
    return [...lines, `[${tag}] pill/fatal: ${JSON.stringify(extra)}`];
  };
};

// ---- the smoke ------------------------------------------------------------

let dumpHost = () => [];
let dumpGuest = () => [];
let host = null;
let guest = null;
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
    // Failure is richest at the moment it happens: dump both tabs now.
    console.log("--- host state ---");
    for (const l of dumpHost().slice(0, 40)) console.log(l);
    await stateDump("host", host).catch(() => {});
    console.log("--- guest state ---");
    for (const l of dumpGuest().slice(0, 40)) console.log(l);
    await stateDump("guest", guest).catch(() => {});
    console.log("--- signaling server ---");
    console.log(sigLogs.join("").slice(-1500) || "(none)");
  }
};

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
      "--use-fake-ui-for-media-stream", // auto-grant camera/mic prompts
      "--use-fake-device-for-media-stream", // virtual camera + mic
      "--autoplay-policy=no-user-gesture-required", // guest stage audio unmuted
      "--disable-dev-shm-usage", // small /dev/shm in containers crashes video decode
    ],
  });

  const hostCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const guestCtx = await browser.newContext({
    viewport: { width: 412, height: 915 },
    isMobile: true,
    hasTouch: true,
    userAgent: PIXEL_UA,
  });
  for (const ctx of [hostCtx, guestCtx]) {
    await ctx.addInitScript(SIG_OVERRIDE);
    await ctx.addInitScript(`window.showDirectoryPicker = ${DIR_STUB};`);
    // The fake camera advertises 4K; decoding that twice (host + guest) is
    // brutal headless. Clamp capture to 720p for the smoke.
    await ctx.addInitScript(`(() => {
      const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      const cap = (v) => {
        if (!v || typeof v !== "object") return v;
        const limit = (c, ideal, max) => ({
          ...c,
          width: { ...(c.width || {}), ideal: Math.min(c.width?.ideal || ideal, ideal), max: Math.min(c.width?.max || max, max) },
          height: { ...(c.height || {}), ideal: Math.min(c.height?.ideal || max, ideal), max: Math.min(c.height?.max || max, max) },
        });
        return limit(v, 1280, 1280);
      };
      navigator.mediaDevices.getUserMedia = (c) =>
        orig({ audio: c.audio, video: cap(c.video) });
    })();`);
  }
  host = await hostCtx.newPage();
  guest = await guestCtx.newPage();
  for (const [tag, p] of [["host", host], ["guest", guest]]) {
    p.on("crash", () => console.log(`[${tag}] PAGE CRASHED @ ${ts()}`));
    p.on("close", () => console.log(`[${tag}] page closed @ ${ts()}`));
  }
  dumpHost = pageLog(host, "host");
  dumpGuest = pageLog(guest, "guest");
  console.log(`t0 @ ${ts()}: both pages up`);

  // 1) host: selling home -> studio preflight
  await step("Host: landing page loads and funnels into the studio", async () => {
    await host.goto(WEB_BASE, { waitUntil: "networkidle" });
    await waitFor(host, () => host.locator("#landing .land-hero").isVisible(), { label: "landing hero" });
    await host.locator("#landing .land-hero [data-start]").click();
    await waitFor(host, () => host.locator("#welcomeModal").isVisible(), { label: "preflight modal" });
  });

  // 2) host: enter with a name + fake devices
  await step("Host: enters the studio and gets a room code", async () => {
    await host.fill("#nameInput", "Host QA");
    await host.click("#btnEnter");
    await waitFor(host, () => host.locator("#welcomeModal").isHidden(), { label: "modal to close" });
    // The room code is minted once host setup finishes (after the modal closes).
    const code = await waitFor(host, () =>
      host.locator("#roomChipCode").textContent().then((t) => {
        const c = (t || "").trim();
        return /^[A-Z2-9]{6}$/.test(c) ? c : null;
      }), { label: "room code" });
    globalThis.roomCode = code;
    await waitFor(host, () => host.locator("#stageEmpty").isVisible(), { label: "stage empty state" });
  });

  // 3) guest (phone): open the invite link and join
  await step("Guest (Android phone): joins via the invite link", async () => {
    await guest.goto(`${WEB_BASE}?room=${globalThis.roomCode}`, { waitUntil: "networkidle" });
    await waitFor(guest, () => guest.locator("#welcomeModal").isVisible(), { label: "guest preflight" });
    const body = await guest.locator("body").getAttribute("class");
    if (!body.includes("guest-mode")) throw new Error("guest page not in guest-mode");
    await guest.fill("#nameInput", "Guest QA");
    await guest.click("#btnEnter");
    await waitFor(guest, () => guest.locator("#welcomeModal").isHidden(), { label: "guest modal to close" });
  });

  // 4) host: sees the guest land (data + media channels up)
  await step("Host: guest appears on stage + sidebar", async () => {
    await waitFor(host, () => host.locator("#guestCountBadge").textContent().then((t) => t.includes("1/3")), { timeout: 60_000, label: "guest count 1/3" });
    await waitFor(host, () => host.locator("#guestList .guest-name").textContent().then((t) => t?.includes("Guest QA")), { label: "guest row" });
    await waitFor(host, () => host.locator("#stageEmpty").isHidden(), { label: "stage empty to hide" });
  });

  // 5) guest: receives the composited stage broadcast
  await step("Guest: stage stream is live ('On air') and video decodes", async () => {
    await waitFor(guest, () => guest.locator("#connPill").textContent().then((t) => t?.includes("On air")), { timeout: 60_000, label: "On air" });
    await waitFor(guest, () =>
      guest.evaluate(() => {
        const v = document.querySelector(".stage-video-fill");
        return v && v.videoWidth > 0 && !v.paused;
      }), { timeout: 60_000, label: "decoded stage frames" });
  });

  // 6) host: Record -> everyone records locally
  await step("Host: Record starts host + guest local masters", async () => {
    await host.click("#btnRecord");
    await waitFor(host, () => host.locator("#recChip").isVisible(), { label: "host REC chip" });
    await waitFor(guest, () => guest.locator("#recChip").isVisible(), { timeout: 30_000, label: "guest REC chip (auto-start)" });
    await sleep(5000); // let a few seconds of media accumulate
  });

  // 7) host: Stop -> guest master streams back and lands in the folder
  await step("Host: Stop syncs the guest's recording back over the data channel", async () => {
    await host.click("#btnRecord");
    await waitFor(host, () => host.locator("#syncModal").isVisible(), { timeout: 30_000, label: "host sync modal" });
    await waitFor(host, () =>
      host.evaluate(() => {
        const rows = [...document.querySelectorAll("#syncList .sync-row")];
        const close = document.querySelector("#btnSyncClose");
        return rows.length > 0 && rows.every((r) => r.classList.contains("done")) && !close.disabled;
      }), { timeout: 120_000, label: "host sync rows done" });
    await waitFor(guest, () =>
      guest.evaluate(() => {
        const s = document.querySelector("#syncList .sync-status");
        return s && /Sent/.test(s.textContent);
      }), { timeout: 120_000, label: "guest upload confirmed" });
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
  console.error(dumpHost().slice(0, 12).join("\n"));
  console.error(dumpGuest().slice(0, 12).join("\n"));
  console.error("signaling server logs:", sigLogs.join("").slice(0, 800) || "(none)");
  process.exit(1);
}
