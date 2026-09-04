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
  const dims = await page.evaluate(() => ({
    x: document.documentElement.scrollWidth - window.innerWidth,
    y: document.documentElement.scrollHeight - window.innerHeight,
  }));
  expect(dims.x, `horizontal overflow by ${dims.x}px`).toBeLessThanOrEqual(1);
  expect(dims.y, `vertical overflow by ${dims.y}px`).toBeLessThanOrEqual(1);
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

test("host shell on a phone still fits (sidebar hidden)", async ({ page }) => {
  await page.goto("/"); // no ?room => host
  await expect(page.locator("#welcomeModal")).toBeVisible();
  await expectNoOverflow(page);

  // Sidebar is desktop-only and must not participate in mobile layout.
  const sidebarVisible = await page.locator("#sidebar").isVisible();
  expect(sidebarVisible).toBe(false);
});
