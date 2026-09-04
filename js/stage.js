// The Stage (PRD Phase 3 + the compositing half of the "browser SFU").
//
// The host arranges participant feeds on a 16:9 stage: tiles auto-arrange
// (solo / side-by-side / spotlight+stack / 2×2 grid) and can be dragged or
// resized free-form by the host. Every tile is mirrored onto a 1920×1080
// canvas — that canvas is what guests receive (with baked-in name tags) and
// what the Director's Cut records when Region Capture isn't available.

import { STAGE } from "./config.js";
import { el, clamp, coverCrop } from "./util.js";

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

  addParticipant({ key, label, isSelf = false }) {
    if (this.entries.has(key)) {
      this.entries.get(key).label = label;
      this.syncDom();
      return;
    }
    const tile = el("div", { class: "tile", dataset: { key } });
    const video = el("video", {
      autoplay: "",
      muted: "",
      playsinline: "",
      "webkit-playsinline": "", // legacy iOS
      "x5-playsinline": "", // Android WebView
    });
    const tag = el("div", { class: "tile-tag" }, el("span", { class: "tile-name", text: label }));
    if (isSelf) tag.append(el("span", { class: "tile-role chip-host", text: "HOST" }));
    const handle = el("div", { class: "tile-handle", title: "Drag to move" });
    const grip = el("div", { class: "tile-grip", title: "Drag to resize" });
    if (!isSelf) tag.append(el("span", { class: "tile-role chip-guest", text: "GUEST" }));
    tile.append(video, tag, handle, grip);
    tile.addEventListener("dblclick", () => {
      if (!this.interactive) return;
      this.custom.delete(key);
      this.syncDom();
    });
    this.container.append(tile);
    this.entries.set(key, { key, label, isSelf, tileEl: tile, videoEl: video, tagEl: tag });
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
    const rects = autoRects(this.order.length);
    return this.order.map((key, i) => {
      const base = rects[i];
      const custom = this.custom.get(key);
      return {
        key,
        x: custom ? custom.x : base.x,
        y: custom ? custom.y : base.y,
        w: custom ? custom.w : base.w,
        h: custom ? custom.h : base.h,
        label: this.entries.get(key)?.label || "",
        isSelf: this.entries.get(key)?.isSelf || false,
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

      const ready = v && v.readyState >= 2 && v.videoWidth > 0;
      if (ready) {
        const { dx, dy, dw, dh } = coverCrop(pw, ph, v.videoWidth, v.videoHeight);
        this.ctx.drawImage(v, px + dx, py + dy, dw, dh);
      } else {
        this.ctx.fillStyle = "#11141d";
        this.ctx.fillRect(px, py, pw, ph);
        if (v && v.readyState < 2) {
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
