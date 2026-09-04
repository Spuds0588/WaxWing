// Small shared helpers: DOM creation, formatting, downloads, toasts.

import { ROOM_CODE_ALPHABET } from "./config.js";

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function randomRoomCode(len = 6) {
  const bytes =
    typeof crypto !== "undefined" && crypto.getRandomValues
      ? crypto.getRandomValues(new Uint8Array(len))
      : null;
  let out = "";
  for (let i = 0; i < len; i++) {
    const idx = bytes ? bytes[i] % ROOM_CODE_ALPHABET.length : Math.floor(Math.random() * ROOM_CODE_ALPHABET.length);
    out += ROOM_CODE_ALPHABET[idx];
  }
  return out;
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v !== undefined && v !== null && v !== false) {
      node.setAttribute(k, v === true ? "" : v);
    }
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export const isIOS = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  // iPadOS reports as macOS on desktop Safari — sniff touch + Mac.
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

export const isSmallScreen = () => window.matchMedia("(max-width: 820px)").matches;

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export function fmtClock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export const fileStamp = (d = new Date()) =>
  d.toISOString().replace(/[-:T]/g, "").slice(0, 14);

export function safeName(str) {
  const cleaned = String(str || "participant")
    // Replace filesystem-hostile characters with spaces, collapse, then
    // switch remaining whitespace to underscores.
    .replace(/[^\w\-. ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/ /g, "_")
    // No leading dots: avoids dotfiles and ".." traversal-looking names.
    .replace(/^\.+/, "");
  return cleaned || "participant";
}

export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

export function coverCrop(outerW, outerH, innerW, innerH) {
  // object-fit: cover math -> draws inner onto outer without distortion.
  const scale = Math.max(outerW / innerW, outerH / innerH);
  const dw = innerW * scale;
  const dh = innerH * scale;
  return { dw, dh, dx: (outerW - dw) / 2, dy: (outerH - dh) / 2 };
}

export function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

// --- Toasts -------------------------------------------------------------

let toastRoot = null;
export function notify(message, kind = "info", ms = 5000) {
  if (!toastRoot) {
    toastRoot = el("div", { class: "toasts", id: "toasts", "aria-live": "polite" });
    document.body.append(toastRoot);
  }
  const t = el("div", { class: `toast toast-${kind}` }, el("span", { class: "toast-msg", text: message }));
  if (kind === "danger") {
    const close = el("button", { class: "toast-close", "aria-label": "Dismiss", text: "×" });
    close.addEventListener("click", () => t.remove());
    t.append(close);
  }
  toastRoot.append(t);
  if (kind !== "danger") setTimeout(() => t.classList.add("toast-out"), ms);
  t.addEventListener("animationend", () => {
    if (t.classList.contains("toast-out")) t.remove();
  });
}
