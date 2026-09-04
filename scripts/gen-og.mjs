// Generates public/og.png (1200x630 social card) using the locally installed
// Playwright chromium. Run: bun run og:gen  (or node scripts/gen-og.mjs)
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const BIRD = `
  <path d="M88,84 C82,96 66,104 48,102 C36,100 26,95 22,91 C32,98 50,100 64,99 C76,98 86,92 88,84 Z" fill="#ffc63d"/>
  <path d="M17,86 L26,88 L25,96 L16,94 Z" fill="#ffc63d"/>
  <path d="M96,52 C94,46 86,42 78,42 C70,42 64,46 62,52 C64,58 72,61 80,60 C88,59 94,56 96,52 Z" fill="#33363f"/>
  <circle cx="79" cy="51" r="1.8" fill="#f4efe3"/>
  <path d="M92,60 C84,64 72,64 66,60" stroke="#efe8da" stroke-width="1.8" stroke-linecap="round"/>
  <path d="M97,53 L114,58 L99,62 Z" fill="#33363f"/>
  <path d="M64,54 C58,66 50,76 39,82" stroke="#9aa3b5" stroke-width="3" stroke-linecap="round"/>
  <path d="M70,60 C64,72 56,81 45,86" stroke="#9aa3b5" stroke-width="3" stroke-linecap="round"/>
  <circle cx="38" cy="80" r="2.6" fill="#e8503a"/>
  <circle cx="31" cy="84" r="2.6" fill="#e8503a"/>
  <circle cx="24" cy="87" r="2.6" fill="#e8503a"/>
  <path d="M96,46 C90,37 79,27 66,21 C58,29 54,34 52,40 C47,51 42,60 37,68 C30,79 21,86 13,88 C12,90 12,93 15,95 C28,99 40,100 48,102 C62,106 74,106 84,101 C90,97 94,89 96,81 C98,71 99,60 98,54 C97,48 97,46 96,46 Z" stroke="#efe8da" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M70,104 L69,111" stroke="#efe8da" stroke-width="2" stroke-linecap="round"/>
  <path d="M79,104 L80,111" stroke="#efe8da" stroke-width="2" stroke-linecap="round"/>
  <path d="M12,112 L150,112" stroke="#554d3f" stroke-width="2.5" stroke-linecap="round"/>`;

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
    gap: 56px;
  }
  .card-left { flex: 0 0 300px; display: flex; justify-content: center; }
  .logo { width: 250px; filter: drop-shadow(0 8px 28px rgba(255,198,61,.22)); }
  .word { font-size: 52px; font-weight: 800; letter-spacing: .01em; }
  .tag { display: inline-block; margin-top: 10px; font-size: 17px; font-weight: 600; letter-spacing: .28em;
    text-transform: uppercase; color: #b3a88f; border: 1px solid #2b261c; padding: 6px 12px; border-radius: 999px; }
  .bullet { margin-top: 18px; font-size: 19px; color: #b3a88f; }
  .bullet b { color: #ffc63d; font-weight: 700; }
  .dot { color: #e8503a; }
</style></head><body>
  <div class="card-left"><svg class="logo" viewBox="0 0 160 132" xmlns="http://www.w3.org/2000/svg" fill="none">${BIRD}</svg></div>
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
