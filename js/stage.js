// The Stage (PRD Phase 3 + the compositing half of the "browser SFU").
//
// The host arranges participant feeds on a 16:9 stage: tiles auto-arrange
// (solo / side-by-side / spotlight+stack / 2×2 grid) and can be dragged or
// resized free-form by the host. Every tile is mirrored onto a 1920×1080
// canvas — that canvas is what guests receive (with baked-in name tags) and
// what the Director's Cut records when Region Capture isn't available.

import { STAGE } from "./config.js";
import { el, clamp, coverCrop, containCrop } from "./util.js";
import { WW_MARK_PATH, hexToRgb } from "./theme.js";

const pad = STAGE.padding;
const INSET = pad; // outer margin of the whole arrangement

// rgba() version of a hex color (for canvas strokes/fills at alpha).
function hexSoft(hex, a) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export function autoRects(count) {
  const g = pad; // gap between tiles
  const make = (x, y, w, h) => ({ x, y, w, h });
  if (count === 1) return [make(INSET, INSET, 1 - 2 * INSET, 1 - 2 * INSET)];
  if (count === 2) {
    const w = (1 - 2 * INSET - g) / 2;
    return [
      make(INSET, INSET, w, 1 - 2 * INSET),
      make(INSET + w + g, INSET, w, 1 - 2 * INSET),
    ];
  }
  if (count === 3) {
    const w = (1 - 2 * INSET - g) / 2;
    const h = (1 - 2 * INSET - g) / 2;
    return [
      make(INSET, INSET, w, 1 - 2 * INSET),
      make(INSET + w + g, INSET, w, h),
      make(INSET + w + g, INSET + h + g, w, h),
    ];
  }
  // 4 (or more): grid
  const cols = 2;
  const rows = Math.ceil(count / cols);
  const innerW = 1 - 2 * INSET - (cols - 1) * g;
  const innerH = 1 - 2 * INSET - (rows - 1) * g;
  const cw = innerW / cols;
  const ch = innerH / rows;
  const out = [];
  for (let i = 0; i < count; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    out.push(make(INSET + c * (cw + g), INSET + r * (ch + g), cw, ch));
  }
  return out;
}

// Presentation layout once someone is sharing a screen: every shared screen
// gets the top band of the stage (a 2-column grid at most), and the camera
// tiles drop into a single-row strip beneath — the "this is what we're
// watching" arrangement. With no cameras the screens take the whole stage.
// Returns { screens: [...rects], cams: [...rects] } in join order.
export function gridRects(count) {
  const g = pad;
  const make = (x, y, w, h) => ({ x, y, w, h });
  if (count <= 1) return autoRects(count);
  const cols = Math.min(2, count);
  const rows = Math.ceil(count / cols);
  const innerW = 1 - 2 * INSET - (cols - 1) * g;
  const innerH = 1 - 2 * INSET - (rows - 1) * g;
  const cw = innerW / cols;
  const ch = innerH / rows;
  const out = [];
  for (let i = 0; i < count; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    out.push(make(INSET + c * (cw + g), INSET + r * (ch + g), cw, ch));
  }
  return out;
}

// Spotlight template: one "featured" tile owns the left two-thirds of the
// stage, everyone else stacks in a column on the right — the classic
// podcast/panel look. Focus defaults to the first participant (the host).
export function spotlightRects(count, focus = 0) {
  const g = pad;
  const make = (x, y, w, h) => ({ x, y, w, h });
  if (count <= 1) return autoRects(count);
  const focusW = (1 - 2 * INSET) * 0.62;
  const focusR = make(INSET, INSET, focusW, 1 - 2 * INSET);
  const sideX = INSET + focusW + g;
  const sideW = 1 - 2 * INSET - focusW - g;
  const sideN = count - 1;
  const sideH = (1 - 2 * INSET - (sideN - 1) * g) / sideN;
  const out = [];
  for (let i = 0; i < count; i++) {
    if (i === focus) {
      out.push(focusR);
      continue;
    }
    const idx = i < focus ? i : i - 1;
    out.push(make(sideX, INSET + idx * (sideH + g), sideW, sideH));
  }
  return out;
}
export function mixedRects(screenCount, camCount) {
  const g = pad;
  const make = (x, y, w, h) => ({ x, y, w, h });
  if (camCount === 0) return { screens: autoRects(screenCount), cams: [] };
  const band = 0.6; // top share of the stage for screens (cameras below)
  const innerW = 1 - 2 * INSET;
  const sCols = Math.min(2, screenCount);
  const sRows = Math.ceil(screenCount / sCols);
  const sw = (innerW - (sCols - 1) * g) / sCols;
  const sh = (band - INSET - (sRows - 1) * g) / sRows;
  const screens = [];
  for (let i = 0; i < screenCount; i++) {
    const c = i % sCols;
    const r = Math.floor(i / sCols);
    screens.push(make(INSET + c * (sw + g), INSET + r * (sh + g), sw, sh));
  }
  const cy = band + g;
  const ch = 1 - cy - INSET;
  const cw = (innerW - (camCount - 1) * g) / camCount;
  const cams = [];
  for (let i = 0; i < camCount; i++) {
    cams.push(make(INSET + i * (cw + g), cy, cw, ch));
  }
  return { screens, cams };
}

// Full stage layout for a set of participants that may mix shared screens
// and cameras. Screens are the "what we're watching" content, so they always
// get the prominent cells (top band for auto, first grid cells, first
// spotlight slot) while cameras fill in around them — the head-to-head
// Twitch look for multiple simultaneous shares.
//
// Returns { rects, presentation, focus } where `rects` maps every key to its
// normalized rect, `presentation` is the keys ordered screens-first, and
// `focus` is the effective spotlight target (or null). Pure — unit tested.
export function layoutRects(keys, isScreen, template = "auto", templateRects = null, focusKey = null) {
  const g = pad;
  const make = (x, y, w, h) => ({ x, y, w, h });
  const screens = keys.filter((k) => isScreen(k));
  const cams = keys.filter((k) => !isScreen(k));
  const pres = [...screens, ...cams];
  const n = pres.length;

  let base = [];
  let focus = null;
  if (template === "grid") {
    base = gridRects(n);
  } else if (template === "spotlight") {
    // Default the spotlight to the first shared screen (the presenter's
    // view wins); the host can click any tile to retarget it.
    focus = focusKey && pres.includes(focusKey) ? focusKey : screens[0] || pres[0] || null;
    base = spotlightRects(n, focus ? pres.indexOf(focus) : 0);
  } else if (template === "custom" && templateRects?.length) {
    // Positional saved arrangement over the presentation order; extra
    // joiners fall back to their auto slot so a new share still lands
    // somewhere visible instead of stacking on top of a tile.
    const auto = autoRects(n);
    base = pres.map((_, i) => templateRects[i] || auto[i]);
  } else if (screens.length) {
    const mixed = mixedRects(screens.length, cams.length);
    base = [...mixed.screens, ...mixed.cams];
  } else {
    base = autoRects(n);
  }

  const rects = new Map();
  pres.forEach((key, i) => {
    if (base[i]) rects.set(key, base[i]);
  });
  // Any key layoutRects didn't place (shouldn't happen) still gets a tile.
  for (const key of keys) if (!rects.has(key)) rects.set(key, make(INSET, INSET, 0.5, 0.5));
  return { rects, presentation: pres, focus };
}

export class Stage {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.container  .stage (aspect-ratio 16/9)
   * @param {HTMLCanvasElement} opts.canvas  composer canvas (host only)
   */
  constructor({ container, canvas }) {
    this.container = container;
    this.canvas = canvas;
    this.ctx = canvas?.getContext("2d");
    this.entries = new Map(); // key -> { key, label, isSelf, tileEl, videoEl }
    this.order = []; // join order of keys
    this.custom = new Map(); // key -> { x, y, w, h } normalized (drag tweaks)
    this.template = "auto"; // auto | grid | spotlight | custom
    this.templateRects = null; // saved arrangement (positional, presentation order)
    this.focusKey = null; // spotlight target (null = first screen / first tile)
    this.theme = null; // theme object consumed by draw()
    this._bgImg = null; // cached background image for the canvas
    this._logoImg = null; // cached logo image for the canvas
    this.interactive = true; // host drag/resize enabled
    this._raf = null;
    this._required = false; // composer consumers: guests / fallback recording
    this.canvasTrack = null;
  }

  // ---- participant lifecycle -------------------------------------------

  addParticipant({ key, label, isSelf = false, hasVideo = true, hasAudio = true, isScreen = false }) {
    if (this.entries.has(key)) {
      this.entries.get(key).label = label;
      this.entries.get(key).isScreen = isScreen;
      this.syncDom();
      return this.entries.get(key);
    }
    const tile = el("div", { class: isScreen ? "tile tile-screen" : "tile", dataset: { key } });
    const video = el("video", {
      autoplay: "",
      muted: "",
      playsinline: "",
      "webkit-playsinline": "", // legacy iOS
      "x5-playsinline": "", // Android WebView
    });
    const tag = el("div", { class: "tile-tag" }, el("span", { class: "tile-name", text: label }));
    if (isScreen) {
      // A shared tab/window/screen is its own tile: name + a SCREEN chip.
      // The owner's HOST/GUEST chip stays on their camera tile.
      tag.append(el("span", { class: "tile-role chip-screen", text: "SCREEN" }));
    } else if (isSelf) {
      tag.append(el("span", { class: "tile-role chip-host", text: "HOST" }));
    } else {
      tag.append(el("span", { class: "tile-role chip-guest", text: "GUEST" }));
    }
    const handle = el("div", { class: "tile-handle", title: "Drag to move" });
    const grip = el("div", { class: "tile-grip", title: "Drag to resize" });
    tile.append(video, tag, handle, grip);
    // Spotlight: clicking a tile (not dragging it) retargets the featured
    // tile — "whoever I click becomes the big one", like a director cutting
    // to a presenter. Works for screens and cameras alike.
    tile.addEventListener("click", (e) => {
      if (!this.interactive || this.template !== "spotlight") return;
      if (e.target.closest(".tile-handle") || e.target.closest(".tile-grip")) return;
      if (tile.dataset.dragged) {
        delete tile.dataset.dragged; // click tail of a drag, not a tap
        return;
      }
      this.setFocus(key);
    });
    // Listeners / no-camera joins: no video element content to show — render
    // a name-tile placeholder instead of a black box labeled "connecting…".
    if (!hasVideo) {
      tile.classList.add("tile-novideo");
      const initials = String(label || "?").trim().slice(0, 2).toUpperCase() || "?";
      const sub = !hasAudio ? (hasVideo ? "Camera only" : "No camera or mic") : "Voice only";
      const ph = el(
        "div",
        { class: "tile-ph" },
        el("span", { class: "tile-ph-avatar", text: initials }),
        el("span", { class: "tile-ph-sub", text: sub }),
      );
      tile.append(ph);
      video.style.display = "none";
    }
    tile.addEventListener("dblclick", () => {
      if (!this.interactive) return;
      this.custom.delete(key);
      this.syncDom();
    });
    this.container.append(tile);
    this.entries.set(key, { key, label, isSelf, hasVideo, hasAudio, isScreen, tileEl: tile, videoEl: video, tagEl: tag });
    this.order.push(key);
    if (this.interactive) this.wireTileInteractions(tile, key);
    this.syncDom();
    return this.entries.get(key);
  }

  removeParticipant(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.tileEl.remove();
    entry.videoEl.srcObject = null;
    this.entries.delete(key);
    this.custom.delete(key);
    this.order = this.order.filter((k) => k !== key);
    this.syncDom();
  }

  setStream(key, stream) {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.videoEl.srcObject = stream;
    entry.stream = stream;
  }

  setLabel(key, label) {
    const entry = this.entries.get(key);
    if (entry) {
      entry.label = label;
      entry.tileEl.querySelector(".tile-name").textContent = label;
    }
  }

  participantKeys() {
    return [...this.order];
  }

  // ---- layout ----------------------------------------------------------

  getRects() {
    const isScreenKey = (k) => this.entries.get(k)?.isScreen === true;
    const { rects } = layoutRects(this.order, isScreenKey, this.template, this.templateRects, this.focusKey);
    return this.order.map((key) => {
      const base = rects.get(key) || { x: INSET, y: INSET, w: 1 - 2 * INSET, h: 1 - 2 * INSET };
      const custom = this.custom.get(key);
      return {
        key,
        x: custom ? custom.x : base.x,
        y: custom ? custom.y : base.y,
        w: custom ? custom.w : base.w,
        h: custom ? custom.h : base.h,
        label: this.entries.get(key)?.label || "",
        isSelf: this.entries.get(key)?.isSelf || false,
        isScreen: this.entries.get(key)?.isScreen || false,
      };
    });
  }

  // The tile the spotlight layout features (host clicks any tile to retarget
  // it). Defaults to the first shared screen, then the first participant.
  getFocusKey() {
    const isScreenKey = (k) => this.entries.get(k)?.isScreen === true;
    const screens = this.order.filter(isScreenKey);
    return this.focusKey || screens[0] || this.order[0] || null;
  }

  setFocus(key) {
    if (!this.entries.has(key)) return;
    this.focusKey = key;
    this.syncDom();
  }

  // Switches the stage template (auto / grid / spotlight / custom) and drops
  // any drag tweaks from the previous layout. The rects parameter carries the
  // saved arrangement for the custom template.
  applyTemplate(name, rects = null) {
    this.template = name || "auto";
    this.templateRects = rects;
    this.custom.clear();
    this.syncDom();
  }

  resetLayout() {
    this.custom.clear();
    this.syncDom();
  }

  syncDom() {
    for (const r of this.getRects()) {
      const entry = this.entries.get(r.key);
      if (!entry) continue;
      entry.tileEl.style.left = `${r.x * 100}%`;
      entry.tileEl.style.top = `${r.y * 100}%`;
      entry.tileEl.style.width = `${r.w * 100}%`;
      entry.tileEl.style.height = `${r.h * 100}%`;
    }
  }

  // ---- host drag / resize ----------------------------------------------

  wireTileInteractions(tile, key) {
    let mode = null;
    let start = null;
    let rect = null;
    const apply = (e) => {
      const box = this.container.getBoundingClientRect();
      const dx = (e.clientX - start.x) / box.width;
      const dy = (e.clientY - start.y) / box.height;
      let r = { ...rect };
      if (mode === "drag") {
        r = { ...rect, x: clamp(rect.x + dx, -0.15, 1 - rect.w + 0.15), y: clamp(rect.y + dy, -0.15, 1 - rect.h + 0.15) };
      } else if (mode === "resize") {
        r = { ...rect, w: clamp(rect.w + dx, 0.1, 1), h: clamp(rect.h + dy, 0.1, 1) };
      }
      tile.dataset.dragged = "1";
      this.custom.set(key, r);
      this.syncDom();
    };
    tile.addEventListener("pointerdown", (e) => {
      if (!this.interactive) return;
      const handle = e.target.closest(".tile-handle");
      const grip = e.target.closest(".tile-grip");
      if (!handle && !grip) return;
      mode = grip ? "resize" : "drag";
      start = { x: e.clientX, y: e.clientY };
      rect = this.custom.get(key) || this.getRects().find((r) => r.key === key);
      tile.setPointerCapture(e.pointerId);
      tile.classList.add("tile-active");
      e.preventDefault();
    });
    tile.addEventListener("pointermove", (e) => {
      if (mode) apply(e);
    });
    const finish = (e) => {
      if (!mode) return;
      mode = null;
      tile.classList.remove("tile-active");
      try {
        tile.releasePointerCapture(e.pointerId);
      } catch {}
    };
    tile.addEventListener("pointerup", finish);
    tile.addEventListener("pointercancel", finish);
  }

  // ---- composer (canvas -> guests / Director's-Cut fallback) ------------

  initCanvas() {
    if (!this.canvas) return null;
    this.canvas.width = STAGE.width;
    this.canvas.height = STAGE.height;
    if (!this.canvasTrack) {
      const stream = this.canvas.captureStream(STAGE.fps);
      this.canvasTrack = stream.getVideoTracks()[0];
    }
    return this.canvasTrack;
  }

  requireComposer(flag) {
    this._required = flag;
    this.setComposerRunning(this._required);
  }

  setComposerRunning(flag) {
    if (flag && !this._raf) {
      const loop = () => {
        this.draw();
        this._raf = requestAnimationFrame(loop);
      };
      this._raf = requestAnimationFrame(loop);
    } else if (!flag && this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = null;
      this.drawIdle();
    }
  }

  drawIdle() {
    if (!this.ctx) return;
    this.ctx.fillStyle = this.theme?.background?.color || "#05060a";
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  // The composer draws whatever the host's theme says: background, accent
  // colors, element toggles, and the logo/watermark — so guests and the
  // canvas-fallback Director's Cut see exactly the themed stage.
  setTheme(theme) {
    this.theme = theme || null;
    const bg = this.theme?.background;
    if (bg?.kind === "image" && bg.image) {
      const img = new Image();
      img.src = bg.image;
      img.onload = () => {
        this._bgImg = img;
        if (this._raf) this.draw();
      };
    } else {
      this._bgImg = null;
    }
    const logo = this.theme?.logo;
    if (logo?.enabled && logo.dataUrl) {
      const img = new Image();
      img.src = logo.dataUrl;
      img.onload = () => {
        this._logoImg = img;
        if (this._raf) this.draw();
      };
    } else {
      this._logoImg = null;
    }
    if (this._raf) this.draw();
  }

  draw() {
    if (!this.ctx) return;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const th = this.theme;
    const accent = th?.accent || "#ffc63d";
    const bg = th?.background;

    if (bg?.kind === "image" && this._bgImg?.complete) {
      this.ctx.fillStyle = bg.color || "#080705";
      this.ctx.fillRect(0, 0, W, H);
      const f = coverCrop(W, H, this._bgImg.naturalWidth, this._bgImg.naturalHeight);
      this.ctx.drawImage(this._bgImg, f.dx, f.dy, f.dw, f.dh);
    } else if (bg?.kind === "gradient") {
      const a = ((bg.angle || 160) * Math.PI) / 180;
      const len = Math.abs(H * Math.sin(a)) + Math.abs(W * Math.cos(a));
      const g = this.ctx.createLinearGradient(
        (W - len * Math.cos(a)) / 2,
        (H - len * Math.sin(a)) / 2,
        (W + len * Math.cos(a)) / 2,
        (H + len * Math.sin(a)) / 2,
      );
      g.addColorStop(0, bg.from);
      g.addColorStop(1, bg.to);
      this.ctx.fillStyle = g;
      this.ctx.fillRect(0, 0, W, H);
    } else if (bg?.kind === "radial") {
      const g = this.ctx.createRadialGradient(W * 0.5, 0, 0, W * 0.5, 0, Math.max(W, H) * 0.85);
      g.addColorStop(0, bg.from);
      g.addColorStop(1, bg.to);
      this.ctx.fillStyle = g;
      this.ctx.fillRect(0, 0, W, H);
    } else {
      this.ctx.fillStyle = bg?.color || "#05060a";
      this.ctx.fillRect(0, 0, W, H);
    }

    const rects = this.getRects();
    if (rects.length === 0) return;
    const showNames = th?.showNames !== false;
    const showChips = th?.showChips !== false;
    const focusKey = this.template === "spotlight" ? this.getFocusKey() : null;

    for (const r of rects) {
      const entry = this.entries.get(r.key);
      const v = entry?.videoEl;
      const px = r.x * W;
      const py = r.y * H;
      const pw = r.w * W;
      const ph = r.h * H;
      const radius = Math.max(6, Math.min(24, pw * 0.04));
      this.roundRect(px, py, pw, ph, radius);
      this.ctx.save();
      this.ctx.clip();

      const noVideo = entry && entry.hasVideo === false;
      const ready = v && !noVideo && v.readyState >= 2 && v.videoWidth > 0;
      if (ready) {
        // Cameras cover-crop their tiles; shared screens letterbox (a
        // cropped slide loses content the presenter is pointing at).
        const fit = entry?.isScreen ? containCrop(pw, ph, v.videoWidth, v.videoHeight) : coverCrop(pw, ph, v.videoWidth, v.videoHeight);
        if (entry?.isScreen) {
          this.ctx.fillStyle = "#000";
          this.ctx.fillRect(px, py, pw, ph);
        }
        this.ctx.drawImage(v, px + fit.dx, py + fit.dy, fit.dw, fit.dh);
      } else {
        this.ctx.fillStyle = "#11141d";
        this.ctx.fillRect(px, py, pw, ph);
        if (noVideo) {
          // A voice-only / listener tile: initials + a note, never the
          // misleading "connecting…" that belongs to a slow video feed.
          const label = r.label || "?";
          const initials = String(label).trim().slice(0, 2).toUpperCase() || "?";
          const avatarR = Math.min(pw, ph) * 0.16;
          this.ctx.fillStyle = entry?.hasAudio
            ? hexSoft(accent, 0.16)
            : "rgba(255,255,255,0.07)";
          this.ctx.beginPath();
          this.ctx.arc(px + pw / 2, py + ph * 0.44, avatarR, 0, Math.PI * 2);
          this.ctx.fill();
          this.ctx.strokeStyle = entry?.hasAudio
            ? hexSoft(accent, 0.4)
            : "rgba(255,255,255,0.18)";
          this.ctx.lineWidth = 1.5;
          this.ctx.stroke();
          this.ctx.fillStyle = entry?.hasAudio ? accent : "#8a8371";
          this.ctx.font = `700 ${avatarR * 0.9}px system-ui, sans-serif`;
          this.ctx.textAlign = "center";
          this.ctx.textBaseline = "middle";
          this.ctx.fillText(initials, px + pw / 2, py + ph * 0.44 + 1);
          const note = !entry?.hasAudio
            ? "No camera or mic"
            : r.isSelf
              ? "Voice only (camera off)"
              : "Voice only";
          this.ctx.font = `600 ${Math.max(12, ph * 0.045)}px system-ui, sans-serif`;
          this.ctx.fillStyle = "rgba(255,255,255,0.5)";
          this.ctx.fillText(note, px + pw / 2, py + ph * 0.44 + avatarR + Math.max(16, ph * 0.05));
        } else if (v && v.readyState < 2) {
          this.ctx.fillStyle = "rgba(255,255,255,0.35)";
          this.ctx.font = `${Math.max(14, pw * 0.05)}px ui-monospace, monospace`;
          this.ctx.textAlign = "center";
          this.ctx.fillText("connecting…", px + pw / 2, py + ph / 2);
        }
      }

      // name tag, baked into the broadcast (toggleable via the theme)
      if (showNames) {
        const tagH = Math.max(18, ph * 0.08);
        this.ctx.font = `600 ${tagH * 0.52}px system-ui, sans-serif`;
        const labelWidth = this.ctx.measureText(r.label).width || tagH * 2;
        const tagW = Math.min(pw, labelWidth + tagH * 2.1 + 60);
        this.ctx.fillStyle = "rgba(5,6,10,0.62)";
        this.ctx.fillRect(px, py, tagW, tagH);
        this.ctx.fillStyle = r.isSelf ? accent : "#ffffff";
        this.ctx.textBaseline = "middle";
        this.ctx.fillText(r.label, px + tagH * 0.55, py + tagH / 2 + 1);
        if (showChips && r.isScreen && px + tagW + tagH * 3 < px + pw) {
          // "SCREEN" chip to the right of the name, like the DOM tile.
          const text = "SCREEN";
          const chipW = this.ctx.measureText(text).width + tagH * 1.15;
          this.ctx.fillStyle = accent;
          this.ctx.beginPath();
          this.ctx.roundRect ? this.ctx.roundRect(px + tagW + tagH * 0.3, py, chipW, tagH, tagH / 2) : this.ctx.rect(px + tagW + tagH * 0.3, py, chipW, tagH);
          this.ctx.fill();
          this.ctx.fillStyle = "#0c0b08";
          this.ctx.fillText(text, px + tagW + tagH * 0.3 + tagH * 0.55, py + tagH / 2 + 1);
        }
      }
      this.ctx.restore();

      const featured = r.key === focusKey || r.isSelf;
      this.ctx.strokeStyle = featured ? hexSoft(accent, 0.85) : "rgba(255,255,255,0.14)";
      this.ctx.lineWidth = featured ? 3 : 1;
      this.ctx.beginPath();
      this.ctx.roundRect(px, py, pw, ph, radius);
      this.ctx.stroke();
      if (r.key === focusKey && !r.isSelf) {
        // A "spotlighting this" ring so the audience can see the cut target.
        this.ctx.strokeStyle = hexSoft(accent, 0.45);
        this.ctx.lineWidth = 1.5;
        this.ctx.setLineDash([6, 6]);
        this.ctx.beginPath();
        this.ctx.roundRect(px - 3, py - 3, pw + 6, ph + 6, radius + 3);
        this.ctx.stroke();
        this.ctx.setLineDash([]);
      }
    }

    this.drawWatermark(accent);
  }

  // Logo / waxwing watermark stamped into the broadcast, per the theme's
  // corner + size. The built-in mark is drawn as a Path2D in the accent
  // color so it stays crisp at any canvas resolution.
  drawWatermark(accent) {
    const th = this.theme;
    if (!th) return;
    const logo = th.logo || {};
    const useLogo = logo.enabled && logo.dataUrl && this._logoImg?.complete;
    if (!useLogo && th.showWatermark === false) return;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const size = Math.max(24, (logo.size || 0.13) * W);
    const margin = Math.max(14, W * 0.02);
    const pos = logo.pos || "br";
    const xFor = { tl: margin, tr: W - size - margin, bl: margin, br: W - size - margin, bc: (W - size) / 2 };
    const yFor = { tl: margin, tr: margin, bl: H - size - margin, br: H - size - margin, bc: H - size - margin };
    const x = xFor[pos] ?? xFor.br;
    const y = yFor[pos] ?? yFor.br;
    this.ctx.save();
    this.ctx.globalAlpha = 0.9;
    if (useLogo) {
      const iw = this._logoImg.naturalWidth || 1;
      const ih = this._logoImg.naturalHeight || 1;
      this.ctx.drawImage(this._logoImg, x, y, size, size * (ih / iw));
    } else {
      const pw = size * 0.5;
      const ph = pw * (38.38 / 47.55);
      this.ctx.translate(x + (size - pw) / 2, y + (size - ph) / 2);
      this.ctx.scale(pw / 47.55, ph / 38.38);
      this.ctx.translate(-821.53, -793.74);
      this.ctx.fillStyle = accent;
      this.ctx.fill(new Path2D(WW_MARK_PATH));
    }
    this.ctx.restore();
  }

  roundRect(x, y, w, h, r) {
    const ctx = this.ctx;
    if (!ctx.roundRect) {
      ctx.rect(x, y, w, h);
      return;
    }
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  }
}

export function makeStageVideo(className) {
  const video = el("video", { class: className, autoplay: "", playsinline: "" });
  return video;
}
