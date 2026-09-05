// The Stage (PRD Phase 3 + the compositing half of the "browser SFU").
//
// The host arranges participant feeds on a 16:9 stage: tiles auto-arrange
// (solo / side-by-side / spotlight+stack / 2×2 grid) and can be dragged or
// resized free-form by the host. Every tile is mirrored onto a 1920×1080
// canvas — that canvas is what guests receive (with baked-in name tags) and
// what the Director's Cut records when Region Capture isn't available.

import { STAGE } from "./config.js";
import { el, clamp, coverCrop, containCrop } from "./util.js";

const pad = STAGE.padding;
const INSET = pad; // outer margin of the whole arrangement

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
    this.custom = new Map(); // key -> { x, y, w, h } normalized
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
    if (isScreen || (this.order.some((k) => this.entries.get(k)?.isScreen) && !this.custom.size)) {
      // Entering presentation mode: drop manual arrangement so the cameras
      // fall into the strip and screens own the band. (Empty customs only —
      // a host fine-tuning mid-presentation keeps their tweaks.)
      this.custom.clear();
    }
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
    if (this.order.some((k) => this.entries.get(k)?.isScreen)) {
      // still in presentation mode — keep the auto layout
    } else {
      this.custom.clear(); // left presentation mode
    }
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
    const screens = this.order.filter(isScreenKey);
    const cams = this.order.filter((k) => !isScreenKey(k));
    const layout =
      screens.length > 0
        ? mixedRects(screens.length, cams.length)
        : { screens: [], cams: autoRects(cams.length) };
    const baseFor = new Map();
    cams.forEach((key, i) => baseFor.set(key, layout.cams[i]));
    screens.forEach((key, i) => baseFor.set(key, layout.screens[i]));
    return this.order.map((key) => {
      const base = baseFor.get(key);
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
    this.ctx.fillStyle = "#05060a";
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  draw() {
    if (!this.ctx) return;
    const W = this.canvas.width;
    const H = this.canvas.height;
    this.ctx.fillStyle = "#05060a";
    this.ctx.fillRect(0, 0, W, H);
    const rects = this.getRects();
    if (rects.length === 0) return;

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
            ? "rgba(255,198,61,0.16)"
            : "rgba(255,255,255,0.07)";
          this.ctx.beginPath();
          this.ctx.arc(px + pw / 2, py + ph * 0.44, avatarR, 0, Math.PI * 2);
          this.ctx.fill();
          this.ctx.strokeStyle = entry?.hasAudio
            ? "rgba(255,198,61,0.4)"
            : "rgba(255,255,255,0.18)";
          this.ctx.lineWidth = 1.5;
          this.ctx.stroke();
          this.ctx.fillStyle = entry?.hasAudio ? "#ffc63d" : "#8a8371";
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

      // name tag, baked into the broadcast
      const tagH = Math.max(18, ph * 0.08);
      this.ctx.font = `600 ${tagH * 0.52}px system-ui, sans-serif`;
      const labelWidth = this.ctx.measureText(r.label).width || tagH * 2;
      const tagW = Math.min(pw, labelWidth + tagH * 2.1 + 60);
      this.ctx.fillStyle = "rgba(5,6,10,0.62)";
      this.ctx.fillRect(px, py, tagW, tagH);
      this.ctx.fillStyle = r.isSelf ? "#ffc63d" : "#ffffff";
      this.ctx.textBaseline = "middle";
      this.ctx.fillText(r.label, px + tagH * 0.55, py + tagH / 2 + 1);
      if (r.isScreen && px + tagW + tagH * 3 < px + pw) {
        // "SCREEN" chip to the right of the name, like the DOM tile.
        const text = "SCREEN";
        const chipW = this.ctx.measureText(text).width + tagH * 1.15;
        this.ctx.fillStyle = "#ffc63d";
        this.ctx.beginPath();
        this.ctx.roundRect ? this.ctx.roundRect(px + tagW + tagH * 0.3, py, chipW, tagH, tagH / 2) : this.ctx.rect(px + tagW + tagH * 0.3, py, chipW, tagH);
        this.ctx.fill();
        this.ctx.fillStyle = "#0c0b08";
        this.ctx.fillText(text, px + tagW + tagH * 0.3 + tagH * 0.55, py + tagH / 2 + 1);
      }
      this.ctx.restore();

      this.ctx.strokeStyle = r.isSelf ? "rgba(255,198,61,0.85)" : "rgba(255,255,255,0.14)";
      this.ctx.lineWidth = r.isSelf ? 3 : 1;
      this.ctx.beginPath();
      this.ctx.roundRect(px, py, pw, ph, radius);
      this.ctx.stroke();
    }
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
