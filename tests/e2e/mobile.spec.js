// Guest-shell mobile E2E.
//
// Every project in playwright.config.js is a phone-sized viewport, so each
// test here runs on Android-portrait, iOS-portrait and phone-landscape.
// Headless Chromium has no camera, which is perfect: it lets us exercise
// the exact "user taps Join with no camera granted" path and assert the
// error state stays tidy on a phone screen.

import { expect, test } from "@playwright/test";

const ROOM = "MOBILE1";

async function expectNoOverflow(page) {
  const dims = await page.evaluate(() => {
    // The selling home page scrolls inside #landing (fixed, overflow-y auto),
    // so its own scrollWidth is the real check — a grid blowout there used to
    // push the hero 4px past the viewport while <html> reported no overflow.
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

test("guest preflight modal fits the viewport", async ({ page }) => {
  await page.goto(`/?room=${ROOM}`);
  await expect(page.locator("#welcomeModal")).toBeVisible();
  await expectNoOverflow(page);

  const modal = await page.locator("#welcomeModal .modal").boundingBox();
  const { width, height } = page.viewportSize();
  expect(modal.x).toBeGreaterThanOrEqual(0);
  expect(modal.y).toBeGreaterThanOrEqual(0);
  expect(modal.x + modal.width).toBeLessThanOrEqual(width + 1);
  // Tall modals are allowed to scroll internally, never past the screen.
  expect(modal.height).toBeLessThanOrEqual(height + 1);

  // The guest shell marks itself as guest-mode and the viewport meta is set
  // for mobile (no user-scalable=no either — keep zoom accessible).
  await expect(page.locator("body")).toHaveClass(/guest-mode/);
  const viewportMeta = await page
    .locator('meta[name="viewport"]')
    .getAttribute("content");
  expect(viewportMeta).toContain("width=device-width");
  expect(viewportMeta).not.toContain("user-scalable=no");
});

test("mobile guest controls exist and are reachable", async ({ page }) => {
  await page.goto(`/?room=${ROOM}`);
  const fsBtn = page.locator("#btnFullscreen");
  await expect(fsBtn).toBeHidden(); // revealed only after entering the studio
  await expect(fsBtn).toHaveAttribute("aria-label", "Full screen");
  // Rotate nudge exists but stays hidden until the stage is live.
  await expect(page.locator("#orientHint")).toBeHidden();
  // Text inputs are 16px+ on small screens so iOS doesn't zoom on focus.
  const inputSize = await page.locator("#nameInput").evaluate(
    (el) => getComputedStyle(el).fontSize,
  );
  expect(parseFloat(inputSize)).toBeGreaterThanOrEqual(16);
});

test("join attempt without camera permission fails gracefully on mobile", async ({ page }) => {
  await page.goto(`/?room=${ROOM}`);
  await page.fill("#nameInput", "Mobile QA");
  await page.click("#btnEnter");

  // Headless Chromium can't grant camera access: the app must stay in the
  // welcome modal with a readable error and a still-usable form.
  await expect(page.locator("#welcomeError")).toBeVisible();
  await expect(page.locator("#welcomeModal")).toBeVisible();
  await expectNoOverflow(page);
  await expect(page.locator("#btnEnter")).toBeEnabled();

  // The invite room stays visible in the copy for the role blurb/flow.
  await expect(page.locator("#welcomeModal")).toContainText(ROOM);
});

// Regression guard for the sprite bug: a <use> referencing the sprite symbol
// can resolve (getBBox works) while still painting NOTHING — which is what
// happened when the usage <svg> and the <symbol> both carried a viewBox
// (Chromium skips painting the <use>). This test rasterizes the actual
// rendered logo and requires visible pixels, so an empty <use> fails it.
async function lightPixels(page, locator, min = 20) {
  const box = await locator.boundingBox();
  expect(box, "logo must be laid out").toBeTruthy();
  const shot = await page.screenshot({ clip: box });
  const light = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let light = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 16) {
        const lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        if (lum > 120) light++;
      }
    }
    return light;
  }, shot.toString("base64"));
  expect(light, `brand mark painted only ${light} visible pixels`).toBeGreaterThan(min);
}

test("the waxwing brand mark actually renders on the page", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".land-brand .brand-logo")).toBeVisible();
  await lightPixels(page, page.locator(".land-brand .brand-logo"));

  // Inside the preflight modal (the guest-join surface) too.
  await page.locator("#landing .land-hero [data-start]").click();
  await expect(page.locator("#welcomeModal .brand-lg .brand-logo")).toBeVisible();
  await lightPixels(page, page.locator("#welcomeModal .brand-lg .brand-logo"));
});

test("hero demo storyboard keeps cycling past the join beat", async ({ page }) => {
  await page.goto("/");
  const hs = page.locator(".hero-stage");
  await expect(hs).toHaveAttribute("data-scene", "link");
  // The loop must actually advance — a regression once froze it on join.
  await expect(hs).toHaveAttribute("data-scene", "join", { timeout: 9000 });
  await expect(hs).toHaveAttribute("data-scene", "share", { timeout: 9000 });
});

test("host funnels from the selling home page into a fitting studio shell", async ({ page }) => {
  await page.goto("/"); // no ?room => host

  // The home page sells first — and fits the phone with no overflow.
  await expect(page.locator("body")).toHaveClass(/mode-home/);
  await expect(page.locator("#landing")).toBeVisible();
  await expect(page.locator("#welcomeModal")).toBeHidden();
  await expect(page.locator(".land-hero")).toContainText("Your browser is the studio");
  await expectNoOverflow(page);

  // The hero demo storyboard ships the whole journey: magic link bar,
  // screen tiles, layout bar, and the master-collection panel all exist,
  // and the loop starts on the "link" beat.
  const hs = page.locator(".hero-stage");
  await expect(hs).toHaveAttribute("data-scene", "link");
  await expect(page.locator(".hero-stage .hs-linkbar")).toBeVisible();
  await expect(page.locator(".hero-stage .hs-screen-a")).toBeAttached();
  await expect(page.locator(".hero-stage .hs-layoutbar")).toBeAttached();
  await expect(page.locator(".hero-stage .hs-files .hs-fchip")).toHaveCount(4);

  // The primary CTA hands you your first recording-link flow.
  await page.locator("#landing .land-hero [data-start]").click();
  await expect(page.locator("body")).toHaveClass(/mode-app/);
  await expect(page.locator("#landing")).toBeHidden();
  await expect(page.locator("#welcomeModal")).toBeVisible();
  await expectNoOverflow(page);

  // The preflight modal still fits the viewport after the mode switch.
  const modal = await page.locator("#welcomeModal .modal").boundingBox();
  const { width, height } = page.viewportSize();
  expect(modal.x).toBeGreaterThanOrEqual(0);
  expect(modal.y).toBeGreaterThanOrEqual(0);
  expect(modal.x + modal.width).toBeLessThanOrEqual(width + 1);
  expect(modal.height).toBeLessThanOrEqual(height + 1);

  // Sidebar is desktop-only and must not participate in mobile layout.
  const sidebarVisible = await page.locator("#sidebar").isVisible();
  expect(sidebarVisible).toBe(false);
});
