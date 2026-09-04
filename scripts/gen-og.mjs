// Generates public/og.png (1200x630 social card) using the locally installed
// Playwright chromium. Run: bun run og:gen  (or node scripts/gen-og.mjs)
import { chromium } from "playwright";
import { writeFileSync, readFileSync } from "node:fs";

// The brand mark: the source waxwing illustration recolored to cream plumage,
// rendered at the left of the card with a warm glow.
const PATH = readFileSync(new URL("../public/waxwing-mark.svg", import.meta.url), "utf8");
const D = PATH.match(/d="([^"]+)"/)[1];

const BIRD = `
  <svg viewBox="819.6 792.2 51.4 41.5" x="26" y="118" width="278" height="224"
       xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">
    <path fill="#efe8da" d="${D}"/>
  </svg>`;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1200px; height: 630px; overflow: hidden; }
  body {
    background:
      radial-gradient(900px 400px at 82% -10%, rgba(255,198,61,.10), transparent 60%),
      radial-gradient(700px 380px at 4% 110%, rgba(232,80,58,.08), transparent 60%),
      #0c0b08;
    color: #f4efe3;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    display: flex;
    align-items: center;
    padding: 64px 72px;
    gap: 8px;
  }
  .card-left { flex: 0 0 330px; display: flex; justify-content: center; }
  .card-left svg { filter: drop-shadow(0 10px 34px rgba(255,198,61,.20)); }
  .word { font-size: 52px; font-weight: 800; letter-spacing: .01em; }
  .tag { display: inline-block; margin-top: 10px; font-size: 17px; font-weight: 600; letter-spacing: .28em;
    text-transform: uppercase; color: #b3a88f; border: 1px solid #2b261c; padding: 6px 12px; border-radius: 999px; }
  .bullet { margin-top: 18px; font-size: 19px; color: #b3a88f; }
  .bullet b { color: #ffc63d; font-weight: 700; }
  .dot { color: #e8503a; }
</style></head><body>
  <div class="card-left"><svg viewBox="0 0 330 460" xmlns="http://www.w3.org/2000/svg">${BIRD}</svg></div>
  <div>
    <div class="word">WaxWing</div>
    <span class="tag">Local Stream Studio</span>
    <div class="bullet"><b>Zero-backend</b> podcast &amp; live studio · runs in your browser</div>
    <div class="bullet"><b>Magic links</b> for guests — no accounts, no servers <span class="dot">●</span></div>
    <div class="bullet">Direct a 16:9 stage &amp; record <b>4K masters to your own disk</b></div>
  </div>
</body></html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "load" });
  const png = await page.screenshot({ type: "png" });
  writeFileSync(new URL("../public/og.png", import.meta.url), png);
  console.log("wrote public/og.png", png.length, "bytes");
} finally {
  await browser.close();
}
