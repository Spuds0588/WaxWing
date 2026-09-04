// Mobile-focused E2E suite. Chromium renders all three profiles so the
// suite runs anywhere; the iOS UA/scale profiles still exercise the mobile
// viewport + touch behavior that Safari users see (WebRTC itself can't be
// exercised headlessly — that needs real devices + permissions).

import { defineConfig } from "@playwright/test";

const IOS_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1";
const PIXEL_UA =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:5199",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "android-portrait",
      use: {
        browserName: "chromium",
        viewport: { width: 412, height: 915 },
        userAgent: PIXEL_UA,
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2.6,
      },
    },
    {
      name: "ios-portrait",
      use: {
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
        userAgent: IOS_UA,
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 3,
      },
    },
    {
      name: "phone-landscape",
      use: {
        browserName: "chromium",
        viewport: { width: 844, height: 390 },
        userAgent: IOS_UA,
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 3,
      },
    },
  ],
  webServer: [
    {
      command: "bunx vite preview --port 5199 --strictPort",
      url: "http://127.0.0.1:5199",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      // Local PeerJS signaling (ws://127.0.0.1) so the live-session spec can
      // actually connect two tabs without depending on the public cloud or
      // outbound WebSockets. Media + files still travel directly P2P.
      command: "bunx peerjs --port 5198",
      url: "http://127.0.0.1:5198",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
