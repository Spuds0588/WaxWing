// Generates public/favicon.png (64x64) and public/apple-touch-icon.png
// (180x180) from the recolored waxwing source path. Run: bun run favicon:gen
import { chromium } from "playwright";
import { writeFileSync, readFileSync } from "node:fs";

// Recolored source illustration (cream plumage), with a soft warm glow so the
// bird stays legible at tiny sizes on dark taskbars.
const PATH = readFileSync(new URL("../public/waxwing-mark.svg", import.meta.url), "utf8");
const m = PATH.match(/d="([^"]+)"/);
const D = m[1];

const tile = (px) => `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${px}px; height: ${px}px; overflow: hidden; }
  body {
    background:
      radial-gradient(${Math.round(px * 0.95)}px ${Math.round(px * 0.8)}px at 50% 42%,
        rgba(255, 198, 61, 0.16), rgba(255, 198, 61, 0) 62%),
      radial-gradient(${px}px ${px}px at 50% 50%, #14120c, #0c0b08 78%);
  }
  svg { position: absolute; inset: ${Math.round(px * 0.16)}px; }
</style></head><body>
  <svg viewBox="819.6 792.2 51.4 41.5" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">
    <path fill="#efe8da" d="${D}"/>
  </svg>
</body></html>`;

const browser = await chromium.launch();
try {
  for (const [px, file] of [
    [64, "favicon.png"],
    [180, "apple-touch-icon.png"],
  ]) {
    const page = await browser.newPage({ viewport: { width: px, height: px }, deviceScaleFactor: 1 });
    await page.setContent(tile(px), { waitUntil: "load" });
    const png = await page.screenshot({ type: "png" });
    writeFileSync(new URL(`../public/${file}`, import.meta.url), png);
    console.log(`wrote public/${file}`, png.length, "bytes");
    await page.close();
  }
} finally {
  await browser.close();
}
