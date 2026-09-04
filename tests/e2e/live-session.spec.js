// Live-session mobile E2E.
//
// Runs at every phone viewport in playwright.config.js (Android-portrait,
// iOS-portrait, phone-landscape). Unlike the shell-only specs, this one
// actually runs the product: two real browser contexts — a host and a
// guest — join a studio over WebRTC (signaling via the LOCAL PeerJS server
// that playwright.config.js starts, so no external network is needed), the
// stage goes live, and a record/stop round trips the guest's master back to
// the host. Every screen in that flow is asserted to fit the phone with no
// overflow — the exact "layout breaking on mobile during a session" class of
// bug this suite exists to catch.
//
// Fake camera/mic are provided per-file via launchOptions; the folder
// picker is swapped for an in-memory stand-in (headless can't show native
// dialogs). WebRTC itself is real.

import { expect, test } from "@playwright/test";

const SIG_PORT = 5198;
const SIG = { host: "127.0.0.1", port: SIG_PORT, path: "/", secure: false, key: "peerjs" };

test.use({
  launchOptions: {
    args: [
      "--use-fake-ui-for-media-stream", // auto-grant camera/mic prompts
      "--use-fake-device-for-media-stream", // virtual camera + mic
      "--autoplay-policy=no-user-gesture-required", // guest stage audio unmuted
      "--disable-dev-shm-usage", // small /dev/shm in containers crashes decode
    ],
  },
});

// In-memory stand-in for the OS directory picker — same shape fs.js expects.
const DIR_STUB = `() => {
  const store = new Map();
  return {
    name: "WaxWing-E2E",
    queryPermission: async () => "granted",
    requestPermission: async () => "granted",
    getFileHandle: async (fileName) => {
      if (!store.has(fileName)) store.set(fileName, []);
      const parts = store.get(fileName);
      return {
        async createWritable() {
          const stream = new WritableStream({ write(chunk) { parts.push(chunk); } });
          const writer = stream.getWriter();
          return { write: (c) => writer.write(c), close: () => writer.close() };
        },
        async getFile() { return new File(parts, fileName, { type: "video/webm" }); },
      };
    },
  };
}`;

// Clamp the fake 4K camera to 720p — decoding two 4K feeds headless is brutal.
const CLAMP_GUM = `(() => {
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
  navigator.mediaDevices.getUserMedia = (c) => orig({ audio: c.audio, video: cap(c.video) });
})();`;

async function expectNoOverflow(page) {
  const dims = await page.evaluate(() => {
    const land = document.getElementById("landing");
    const landX = land ? land.scrollWidth - land.clientWidth : 0;
    return {
      x: document.documentElement.scrollWidth - window.innerWidth,
      y: document.documentElement.scrollHeight - window.innerHeight,
      landX,
    };
  });
  expect(dims.x, `horizontal overflow by ${dims.x}px`).toBeLessThanOrEqual(1);
  expect(dims.y, `vertical overflow by ${dims.y}px`).toBeLessThanOrEqual(1);
  expect(dims.landX, `landing scroller overflow by ${dims.landX}px`).toBeLessThanOrEqual(1);
}

async function expectWithinViewport(page, locator) {
  const box = await locator.boundingBox();
  const { width, height } = page.viewportSize();
  expect(box, "element must be laid out").toBeTruthy();
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.y).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(height + 1);
}

test("host + guest session screens fit the phone end to end", async ({ browser }) => {
  test.setTimeout(120_000);
  const { viewport, userAgent, isMobile, hasTouch, deviceScaleFactor } =
    test.info().project.use;

  const hostCtx = await browser.newContext({
    viewport, userAgent, isMobile, hasTouch, deviceScaleFactor,
  });
  const guestCtx = await browser.newContext({
    viewport, userAgent, isMobile, hasTouch, deviceScaleFactor,
  });
  for (const ctx of [hostCtx, guestCtx]) {
    await ctx.addInitScript((sig) => {
      window.__WW_PEER__ = sig;
    }, SIG);
    await ctx.addInitScript(`window.showDirectoryPicker = ${DIR_STUB};`);
    await ctx.addInitScript(CLAMP_GUM);
  }

  try {
    const host = await hostCtx.newPage();
    const guest = await guestCtx.newPage();
    const errors = [];
    for (const p of [host, guest]) {
      p.on("pageerror", (e) => errors.push(String(e)));
      p.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text());
      });
    }

    // 1) Host: selling home -> studio -> session shell fits the phone.
    await host.goto("/");
    await host.locator("#landing .land-hero [data-start]").click();
    await host.fill("#nameInput", "Phone Host");
    await host.click("#btnEnter");
    await expect(host.locator("#welcomeModal")).toBeHidden();
    await expect(host.locator("#connPill")).toBeVisible();
    await expect(host.locator("#roomChipCode")).toHaveText(/^[A-Z2-9]{6}$/);
    await expect(host.locator("#stage")).toBeVisible();
    await expect(host.locator("#btnRecord")).toBeVisible();
    await expectNoOverflow(host);
    await expectWithinViewport(host, host.locator("#stage"));
    const room = (await host.locator("#roomChipCode").textContent()).trim();

    // 2) Guest: opens the invite link on a phone and joins.
    await guest.goto(`/?room=${room}`);
    await guest.fill("#nameInput", "Phone Guest");
    await guest.click("#btnEnter");
    await expect(guest.locator("#welcomeModal")).toBeHidden();
    await expect(guest.locator("#connPill")).toContainText("On air", { timeout: 20_000 });
    await expect(guest.locator(".stage-video-fill")).toBeVisible();
    await expect(guest.locator("#guestSelf")).toBeVisible();
    await expect(guest.locator("#btnFullscreen")).toBeVisible();
    await expectNoOverflow(guest);
    await expectWithinViewport(guest, guest.locator("#stage"));

    // 3) The host's session chrome stays intact once a guest is on stage.
    await expect(host.locator("#guestCountBadge")).toContainText("1/3");
    await expect(host.locator("#stageEmpty")).toBeHidden();
    await expectNoOverflow(host);

    // 4) Record a few seconds, stop, and let the guest's master sync back.
    await host.click("#btnRecord");
    await expect(host.locator("#recChip")).toBeVisible();
    await expect(guest.locator("#recChip")).toBeVisible({ timeout: 15_000 });
    await host.waitForTimeout(3000);
    await host.click("#btnRecord");

    // The sync modal (host side) is a phone-width modal — it must fit.
    await expect(host.locator("#syncModal")).toBeVisible({ timeout: 20_000 });
    await expectNoOverflow(host);
    await expectWithinViewport(host, host.locator("#syncModal .modal"));
    // Round-trip completes: rows flip to done and Close unlocks.
    await expect(host.locator("#btnSyncClose")).toBeEnabled({ timeout: 90_000 });
    await expect(host.locator("#syncList .sync-row.done").first()).toBeVisible();
    await expectNoOverflow(host);
    // The guest's "sending" modal fits too.
    await expect(guest.locator("#syncModal")).toBeVisible();
    await expectNoOverflow(guest);
    await expectWithinViewport(guest, guest.locator("#syncModal .modal"));

    expect(errors, `JS errors during session: ${errors.slice(0, 5).join(" | ")}`).toEqual([]);
  } finally {
    await hostCtx.close().catch(() => {});
    await guestCtx.close().catch(() => {});
  }
});