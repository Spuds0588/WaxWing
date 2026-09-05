// WaxWing — studio theme (host side).
//
// The theme is what the host's stage, the broadcast composer, and the
// Director's Cut look like: a background (solid / gradient / uploaded
// image), an uploaded logo or the built-in waxwing watermark, an accent
// color for stage elements, per-element visibility toggles, and stage
// templates (auto / grid / spotlight / custom arrangement).
//
// Guests never need the theme object itself — they receive the already
// composited video, and the host's own stage is the live preview. The
// theme is persisted per-browser in localStorage (images are downscaled
// to data URLs on upload so they stay comfortably inside the quota).

import { el } from "./util.js";

// The waxwing mark (adapted from an SVG Repo line-art illustration — see
// README "License & icon attribution"), as a path string so the canvas
// composer can stamp it into the broadcast in the current accent color.
export const WW_MARK_PATH =
  "M866.931,820.786l-3.305-1.889-6.469-3.695A44.1,44.1,0,0,0,844.9,802.859l1.135-6.81a.75.75,0,1,0-1.48-.247l-1.216,7.3h0l-.964,5.786h0l-.237,1.418-1.486,8.922a1.371,1.371,0,0,1-.578.02,1.343,1.343,0,0,1-.676-.379l.4-2.379a.752.752,0,0,0,.084-.5l3.322-19.936a.75.75,0,1,0-1.479-.247l-.784,4.7c-2.989-2.612-5.77-4.259-8.269-4.872a7.31,7.31,0,0,0-6,.841,6.284,6.284,0,0,0-1.806,1.818l-1.355,1.355a.751.751,0,0,0,.034,1.093,8.4,8.4,0,0,0,2.94,1.5,11.133,11.133,0,0,1,2.533,3.9c.207.494.42.974.635,1.426,2.057,4.343,4.577,6.831,8.533,8.442a2.81,2.81,0,0,0-.367,3.245l-.308,1.849a.685.685,0,0,0-.2.084,2.874,2.874,0,0,0-.769,3.993,2.822,2.822,0,0,0,.241.291l-.726,4.352a.75.75,0,0,0,1.48.246l.624-3.742c.073.021.143.051.218.065a2.948,2.948,0,0,0,.551.053,2.815,2.815,0,0,0,.534-.057l-.572,3.435a.75.75,0,0,0,.616.863.766.766,0,0,0,.125.01.748.748,0,0,0,.738-.626l1.1-6.59,4.247-2.831a.75.75,0,0,0,.255-.96l-.486-.971,2.468.617a.75.75,0,0,0,.893-.965l-.061-.182a7.263,7.263,0,0,0,2.96-.792l4.067,3.389,3.181,2.651a.752.752,0,0,0,.363.164,12.817,12.817,0,0,0,2,.162,8.981,8.981,0,0,0,5.7-1.754.751.751,0,0,0-.121-1.217Zm-12.679-7.05-.367-.183-9.935-4.968.684-4.108A41.763,41.763,0,0,1,854.252,813.736Zm-14.393-8.806c-.048-.085-.1-.167-.142-.255-.074-.146-.141-.3-.207-.456-.034-.081-.073-.158-.1-.241a6.665,6.665,0,0,1-.394-1.591c0-.014,0-.029,0-.042h1.624l-.5,3.034c-.016-.025-.033-.047-.049-.072C840,805.187,839.931,805.058,839.859,804.93Zm-9.05-8.065-.007.005a7.432,7.432,0,0,1-1.135.707l-.025.011c-.176.087-.349.165-.518.231l-.04.014c-.164.063-.325.119-.481.165l-.023.005c-.161.047-.318.086-.469.117l-.013,0q-.231.047-.444.072h-.017c-.139.017-.272.027-.4.033h-.053c-.109,0-.215.005-.314,0h-.012A5.177,5.177,0,0,1,830.809,796.865Zm-5.205,2.808,1.421.71-.35.351a7.8,7.8,0,0,1-1.47-.662Zm2.348,1.905.87-.87a.741.741,0,0,0,.079-.962.664.664,0,0,0-.082-.077.74.74,0,0,0-.144-.136c.076-.018.154-.042.232-.064l.133-.036q.323-.094.66-.228l.076-.029a.7.7,0,0,0-.067.293.708.708,0,0,0,1.417,0,.7.7,0,0,0-.545-.676c.23-.125.464-.269.7-.426l.168-.116c.246-.173.493-.357.741-.57l.023-.02c.169-.145.338-.3.508-.462a18.686,18.686,0,0,1,6.313,3.646h-.82l-.062,0-.1.01-.065.008-.155.02-.111.018-.207.033-.157.03c-.081.015-.162.031-.252.05l-.193.044c-.094.021-.19.045-.291.071l-.226.06c-.105.029-.213.062-.324.1-.082.025-.161.05-.246.078-.119.039-.242.083-.366.129-.083.03-.163.058-.248.091-.138.054-.279.115-.421.176-.075.033-.149.063-.226.1q-.3.137-.6.3l-.068.034q-.334.183-.671.4c-.064.042-.127.09-.192.134-.158.107-.315.216-.471.335-.081.063-.16.132-.24.2-.137.112-.272.225-.405.348-.085.078-.167.162-.25.245-.124.123-.246.25-.365.383-.083.093-.163.191-.244.289-.113.138-.222.281-.329.43-.077.107-.152.216-.226.328-.044.068-.092.128-.135.2A13.261,13.261,0,0,0,827.952,801.578Zm3.2,5.651c.023-.053.047-.1.071-.156a7.452,7.452,0,0,1,.515-.95c.02-.031.038-.067.058-.1a7.359,7.359,0,0,1,.677-.853c.056-.062.114-.123.171-.182a7.817,7.817,0,0,1,.749-.685l.06-.043a8.38,8.38,0,0,1,.757-.52c.061-.037.122-.076.184-.112.262-.152.524-.291.781-.41.048-.022.094-.04.141-.061.228-.1.452-.191.667-.269l.15-.055c.236-.081.462-.15.672-.208l.146-.038c.178-.046.346-.085.495-.116l.058-.013c0,.031.01.059.014.089.01.091.028.178.041.267.032.211.069.418.115.619.023.1.05.2.077.3q.075.274.165.536c.032.092.063.184.1.274.072.185.149.362.23.535.031.066.059.135.091.2.116.232.238.455.367.666.023.038.048.072.072.109.108.172.218.338.332.5.048.066.1.128.144.192.093.122.185.24.279.352.051.063.1.123.154.182.035.04.07.085.1.124l-.15.9-1.046,6.275C835.153,813.14,833,811,831.156,807.229Zm8.537,17.474a1.372,1.372,0,0,1-1.032.211,1.338,1.338,0,0,1-.251-.1l.72-4.318a2.725,2.725,0,0,0,1.215.276c.018,0,.035,0,.054,0l-.653,3.914C839.729,824.69,839.71,824.691,839.693,824.7Zm4.639-4.94-2.526,1.684.2-1.233a.738.738,0,0,0,.157-.941l.222-1.333,1.178.294Zm3.1-5.65a.75.75,0,1,0-1.423.475l.683,2.049c-.4-.046-.811-.1-1.246-.188-.979-.19-1.871-.382-2.706-.584l.955-5.732,8.885,4.443c-.01.017-.022.032-.031.049a3.719,3.719,0,0,1-.409.579c-.044.052-.089.1-.136.151a3.608,3.608,0,0,1-.584.507l-.007.006h0a5.707,5.707,0,0,1-3.113.85Zm5.879,2.022c.058-.069.122-.132.176-.2a5.391,5.391,0,0,0,.405-.633c.009-.017.021-.032.03-.049h0l2.364,1.181,4.923,2.813-.2.028c-.271.038-.545.071-.821.1-.106.01-.211.021-.317.029-.333.027-.666.048-.994.061l-.068,0c-.368.013-.728.018-1.079.019l-.229,0c-.262,0-.516-.005-.76-.012l-.162-.005L853,816.488C853.113,816.378,853.208,816.254,853.307,816.135Zm6.484,6.009-1.4-1.17c.136,0,.279-.013.418-.018.166-.006.329-.012.5-.022.325-.017.65-.044.979-.074.138-.013.274-.022.413-.038.459-.052.914-.117,1.358-.2.081-.016.155-.038.234-.055.3-.062.595-.125.876-.205l1.934,1.105A9.138,9.138,0,0,1,859.791,822.144Z";

export const STORAGE_KEY = "ww.theme";

// Warm-dark, waxwing-flavored presets. The first one is the current
// out-of-the-box stage look, so a fresh browser gets exactly what it got
// before theming existed.
export const BG_PRESETS = [
  { key: "charcoal", label: "Charcoal", kind: "radial", from: "#241706", to: "#080705", angle: 160 },
  { key: "dusk", label: "Dusk", kind: "gradient", from: "#1c1308", to: "#0a0805", angle: 160 },
  { key: "ember", label: "Ember", kind: "gradient", from: "#2a1008", to: "#0b0705", angle: 150 },
  { key: "midnight", label: "Midnight", kind: "gradient", from: "#111a2e", to: "#080b12", angle: 165 },
  { key: "moss", label: "Moss", kind: "gradient", from: "#131c0e", to: "#070b07", angle: 170 },
];

export const ACCENT_PRESETS = ["#ffc63d", "#ffb454", "#e8503a", "#efe8da", "#b7c08a", "#9fb4c7"];

export const DEFAULT_THEME = {
  v: 1,
  template: "auto", // auto | grid | spotlight | custom
  custom: null, // saved arrangement: [ {x,y,w,h}, ... ] in join order (normalized)
  background: { kind: "radial", from: "#241706", to: "#080705", angle: 160, color: "#080705", image: null, imageLabel: "" },
  accent: "#ffc63d",
  logo: { dataUrl: null, label: "", enabled: true, pos: "br", size: 0.13 },
  showWatermark: true,
  showNames: true,
  showChips: true,
  frame: true,
};

// ---- small color helpers (pure) ------------------------------------------

export function hexToRgb(hex) {
  let h = String(hex || "").replace("#", "").trim();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return { r: 255, g: 198, b: 61 };
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

// A readable ink color for text sitting on an accent chip.
export function inkFor(hex) {
  const { r, g, b } = hexToRgb(hex);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.5 ? "#261f04" : "#f4efe3";
}

// The CSS background string for a theme background (pure — unit tested).
export function bgCss(bg) {
  if (!bg) return "#080705";
  if (bg.kind === "radial") return `radial-gradient(120% 90% at 50% 0%, ${bg.from}, ${bg.to})`;
  if (bg.kind === "gradient") return `linear-gradient(${bg.angle || 160}deg, ${bg.from}, ${bg.to})`;
  if (bg.kind === "image" && bg.image) return `url("${bg.image}") center / cover no-repeat, ${bg.color || "#080705"}`;
  return bg.color || "#080705";
}

// ---- persistence -----------------------------------------------------------

export function loadTheme() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_THEME);
    const parsed = JSON.parse(raw);
    if (parsed.v !== DEFAULT_THEME.v) return structuredClone(DEFAULT_THEME);
    return {
      ...structuredClone(DEFAULT_THEME),
      ...parsed,
      background: { ...DEFAULT_THEME.background, ...(parsed.background || {}) },
      logo: { ...DEFAULT_THEME.logo, ...(parsed.logo || {}) },
    };
  } catch {
    return structuredClone(DEFAULT_THEME);
  }
}

export function saveTheme(theme) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(theme));
  } catch {
    /* private mode / quota — the session theme still applies live */
  }
}

// ---- image upload ----------------------------------------------------------

// Reads an image file into a (downscaled) data URL. SVGs pass through
// untouched; raster images are resized on a canvas so a 12MP background
// photo doesn't blow the localStorage quota. Resolution goes down, look
// stays identical on a 1920px stage.
export function fileToDataUrl(file, { maxDim = 1600, preferPng = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error("No file selected."));
    if (file.type === "image/svg+xml") {
      const r = new FileReader();
      r.onload = () => resolve({ dataUrl: r.result, label: file.name });
      r.onerror = () => reject(new Error("Couldn't read that SVG."));
      r.readAsDataURL(file);
      return;
    }
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      try {
        const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        const mime = preferPng ? "image/png" : "image/jpeg";
        resolve({ dataUrl: canvas.toDataURL(mime, preferPng ? undefined : 0.85), label: file.name });
      } catch (err) {
        reject(new Error("Couldn't process that image."));
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That file isn't a usable image."));
    };
    img.src = url;
  });
}

// ---- DOM application (the host's live stage) -------------------------------

// Applies the theme to the stage DOM: background layer behind the tiles, a
// watermark/logo overlay, accent CSS variables, and data-* toggles that CSS
// reads to hide name tags / role chips / the frame. Region-capture of the
// stage for the Director's Cut picks all of this up automatically; the
// canvas composer (Stage.draw) re-derives the same look for guests and for
// the canvas fallback.
export function applyStageTheme(theme, stageEl) {
  if (!stageEl) return;
  const t = theme || DEFAULT_THEME;
  stageEl.classList.add("stage-themed");
  stageEl.dataset.template = t.template || "auto";
  stageEl.dataset.names = t.showNames === false ? "off" : "on";
  stageEl.dataset.chips = t.showChips === false ? "off" : "on";
  stageEl.dataset.frame = t.frame === false ? "off" : "on";
  stageEl.dataset.watermark = t.showWatermark === false ? "off" : "on";

  const accent = t.accent || DEFAULT_THEME.accent;
  const { r, g, b } = hexToRgb(accent);
  stageEl.style.setProperty("--stage-accent", accent);
  stageEl.style.setProperty("--stage-accent-ink", inkFor(accent));
  stageEl.style.setProperty("--stage-accent-soft", `rgba(${r}, ${g}, ${b}, 0.14)`);
  stageEl.style.setProperty("--stage-accent-line", `rgba(${r}, ${g}, ${b}, 0.42)`);

  // Background layer: always the first child so tiles paint above it.
  let bg = stageEl.querySelector(":scope > .stage-theme-bg");
  if (!bg) {
    bg = el("div", { class: "stage-theme-bg", "aria-hidden": "true" });
    stageEl.prepend(bg);
  }
  bg.style.background = bgCss(t.background);

  // Watermark / logo overlay: kept as the last child so it floats above
  // every tile (z-index also guarantees it).
  let wm = stageEl.querySelector(":scope > .stage-watermark");
  if (!wm) {
    wm = el("div", { class: "stage-watermark", "aria-hidden": "true" });
    stageEl.append(wm);
  } else {
    wm.innerHTML = "";
  }
  const logo = t.logo || {};
  const useLogo = logo.enabled && logo.dataUrl;
  if (useLogo) {
    wm.append(el("img", { src: logo.dataUrl, alt: "" }));
  } else if (t.showWatermark !== false) {
    const SVG_NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.classList.add("wm-mark");
    const use = document.createElementNS(SVG_NS, "use");
    use.setAttribute("href", "#ww-mark");
    svg.append(use);
    wm.append(svg);
  }
  wm.dataset.pos = logo.pos || "br";
  wm.style.width = `${(logo.size || 0.13) * 100}%`;
  wm.classList.toggle("hidden", !useLogo && t.showWatermark === false);
}