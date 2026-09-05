// WaxWing — app orchestration.
//
// Role comes from the URL: no ?room= parameter => you are the HOST (a new
// studio opens). ?room=CODE => you are a GUEST dialing into that studio.
//
// Nothing here talks to a backend: PeerJS handles signaling against its free
// public cloud, media + data flow straight between peers, and every file is
// written locally by whoever owns the camera that produced it.

import { APP, STORAGE_KEYS, LOCAL_RECORD } from "./config.js";
import {
  $,
  el,
  notify,
  fmtBytes,
  fmtClock,
  safeName,
  downloadBlob,
  isIOS,
} from "./util.js";
import {
  listDevices,
  openMasterStream,
  makeProxyVideoTrack,
  screenShareSupported,
  openScreenShare,
  makeScreenProxyTrack,
  savedDeviceIds,
  rememberDeviceIds,
  stopStream,
} from "./device.js";
import {
  BG_PRESETS,
  ACCENT_PRESETS,
  DEFAULT_THEME,
  loadTheme,
  saveTheme,
  applyStageTheme,
  fileToDataUrl,
} from "./theme.js";
import * as fs from "./fs.js";
import { AudioBus } from "./audio-bus.js";
import { Network, randomRoomCode } from "./network.js";
import { Stage } from "./stage.js";
import {
  startRecording,
  startStageRecording,
  localFileName,
  stageFileName,
  recorderSupported,
  cropSupported,
  pickMimeType,
  canRecordVideo,
} from "./recorder.js";
import { uploadBlob } from "./sync.js";

const MAX_GUESTS = APP.maxGuests;

// ---- tiny element helper ------------------------------------------------

const els = {};
for (const id of [
  "connPill", "roomCluster", "roomChipCode", "btnCopyInvite",
  "hostControls", "btnShareScreen", "btnShareScreenLabel",
  "btnResetLayout", "btnStageRec", "btnRecord", "btnRecordLabel",
  "btnExit", "btnExitLabel", "recChip", "recTime", "stageChip", "stageTime",
  "syncChip", "qualityNote", "stage", "stageEmpty", "guestSelf", "guestSelfVideo",
  "stageAudioHint", "sidebar", "guestCountBadge", "guestList", "guestListEmpty",
  "inviteCode", "btnCopyInvite2", "recRowSelf", "recRowStage", "recModeLabel",
  "capQualityLabel", "welcomeModal", "roleBlurb", "nameInput", "camSelect",
  "micSelect", "btnRefreshDevices", "btnFolder", "folderLabel", "capList",
  "welcomeError", "previewVideo", "previewState", "btnEnter", "btnEnterLabel",
  "syncModal", "syncTitle", "syncList", "syncNote", "btnSyncClose",
  "dontClosePill", "dontCloseText", "fatalPanel", "fatalTitle", "fatalMessage",
  "btnFatalReload", "composerCanvas", "stageShell", "btnFullscreen",
  "orientHint", "optVideo", "optMic", "optSave", "saveLabel", "saveHint",
  "saveRow", "folderWrap", "recChipState", "btnTheme", "themeModal",
  "btnThemeClose", "themePanel", "bgSwatches", "bgCustom", "bgFile",
  "btnBgUpload", "btnBgRemove", "accentSwatches", "accentCustom", "logoFile",
  "btnLogoUpload", "btnLogoRemove", "logoEnabled", "logoPos", "logoSize",
  "optNames", "optChips", "optWatermark", "optFrame", "btnSaveArrangement",
  "btnResetAuto", "stageLayoutBar",
]) {
  els[id] = $(`#${id}`);
}

// ---- state ---------------------------------------------------------------

const S = {
  role: "host", // set at boot from the URL
  room: null,
  name: "",
  quality: "",
  entered: false,
  // Join prefs (camera/mic toggles + the local-master save opt-in).
  wantVideo: true,
  wantAudio: true,
  saveMaster: true,
  hasMedia: false, // did we actually open any track?
  showActive: false, // host: a broadcast run is live (guests recording)
  // local screen share (either role) — a separate stream from the camera
  masterStream: null,
  shareActive: false,
  screenStream: null,
  screenProxyTrack: null,
  previewStream: null,
  previewCam: "",
  proxyVideoTrack: null,
  net: null,
  bus: null,
  stage: null,
  guestStageVideo: null,
  stageLive: false, // guest has received the stage stream
  // own local recording (host's master / guest's master)
  recActive: false,
  recRun: null,
  recStartedAt: 0,
  recTimer: null,
  localRec: null,
  lastOwnRecording: null, // { run, blob, fileName, mode } awaiting upload
  // host: Director's Cut
  stageRecActive: false,
  stageRec: null,
  stageRecMode: null,
  stageRecStartedAt: 0,
  stageRecTimer: null,
  // host: post-show sync bookkeeping
  sync: null, // { done, rows: Map<key, row>, files: [] }
  busy: false,
  lastBroadcastRun: null,
};

const inviteUrl = () =>
  `${location.origin}${location.pathname.replace(/\/+$/, "")}?room=${S.room}`;

// ---- boot ----------------------------------------------------------------

let hostStarted = false;

// The selling page's demo stage is a fixed 640×360 component that is scaled
// to its column with transform: scale(). Keeping the authored size constant
// means its internal layout (tiles, chips, invite bar) can never reflow or
// collide as the column shrinks — the wrapper below it carries the visible
// footprint via aspect-ratio, and the scaled child is clipped inside it.
const HS_WIDTH = 640;
function fitHeroStage() {
  const wrap = document.querySelector(".hero-stage-wrap");
  if (!wrap) return;
  // Border-box width so the scaled 640px stage fills the wrapper exactly
  // (clientWidth excludes the wrapper's own borders, which leaves a 1px gap).
  const w = wrap.getBoundingClientRect().width;
  if (!w) return; // landing hidden (mode-app) or display:none
  wrap.style.setProperty("--hs-scale", String(Math.min(1, w / HS_WIDTH)));
}

// ---- animated hero demo (landing page) ------------------------------
// The demo stage cycles through the whole WaxWing journey: host gets a
// magic link -> guests join (incl. mobile) -> screen shares -> the host
// cuts grid/spotlight/custom layouts -> record -> guest masters stream
// back -> all masters in the folder. Reduced-motion users get a static
// full-studio frame instead.
const HS_DEMO = [
  { scene: "link", ms: 4300, toast: "Your magic link is ready — send it to anyone, no sign-up", count: "1" },
  { scene: "join", ms: 4600, toast: "Guests tap the link and their cameras connect straight to you — even on a phone", count: "4" },
  { scene: "share", ms: 4600, toast: "Maya shares her screen — a live SCREEN tile joins the stage", count: "4" },
  { scene: "layout", ms: 7200, toast: "You direct the cut — grid, spotlight, or your own custom arrangement", count: "4", layouts: ["grid", "spotlight", "custom"], layoutMs: 2200 },
  { scene: "record", ms: 5600, toast: "One click records 4 full-quality local masters — your disk is the archive", count: "4" },
  { scene: "done", ms: 4000, toast: "Stop — every guest master lands in your folder, peer-to-peer. That's the whole show", count: "4" },
];

function startHeroDemo() {
  const stage = document.querySelector(".hero-stage");
  if (!stage) return;
  const count = stage.querySelector(".hs-count b");
  const rec = stage.querySelector(".hs-rec");
  const toast = stage.querySelector(".hs-toast");
  const lbItems = Array.from(stage.querySelectorAll(".hs-lb-item"));
  const fchips = Array.from(stage.querySelectorAll(".hs-fchip"));

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    stage.dataset.scene = "join"; // static full-studio frame
    return;
  }

  // Single self-rescheduling tick drives the whole storyboard: scene
  // changes come from a timestamped clock (immune to timer throttling and
  // to a thrown error killing the chain), the layout beat's
  // grid->spotlight->custom walk is derived from elapsed scene time (no
  // parallel timers). The clock freezes only while the tab is hidden (where
  // timers get throttled), so the loop always runs whenever the page is
  // visible — no matter where the stage sits in the scroll — and scenes
  // resume where they left off.
  let idx = -1;
  let sceneStart = 0;
  let paused = false;
  let frozenElapsed = 0;

  function setPaused(p) {
    if (p === paused) return;
    if (p) frozenElapsed = performance.now() - sceneStart;
    else sceneStart = performance.now() - frozenElapsed; // resume where it left off
    paused = p;
  }
  document.addEventListener("visibilitychange", () => setPaused(document.hidden));

  // Progress bars + check states for the files panel: recording beat = the
  // host's file is green locally, guests sweep their P2P transfer bars;
  // done beat = everything green.
  function setFiles(phase) {
    fchips.forEach((chip, i) => {
      chip.classList.toggle("is-syncing", phase === "record" && i > 0);
      chip.classList.toggle("is-done", phase === "done" || i === 0);
      const st = chip.querySelector(".hs-fs");
      if (phase === "done" || i === 0) st.textContent = "Saved ✓";
      else st.textContent = "P2P";
    });
  }

  function paint(step) {
    stage.dataset.scene = step.scene;
    stage.dataset.layout = step.layouts ? step.layouts[0] : "";
    stage.dataset.rec = step.scene === "record" ? "on" : "";
    rec.classList.toggle("is-on", step.scene === "record");
    count.textContent = step.count;
    if (step.layouts) {
      lbItems.forEach((it) => it.classList.toggle("is-on", it.dataset.l === step.layouts[0]));
    }
    setFiles(step.scene === "record" || step.scene === "done" ? step.scene : null);
    toast.textContent = step.toast;
    toast.classList.remove("is-on");
    void toast.offsetWidth; // restart the auto-fade animation
    toast.classList.add("is-on");
  }

  function stepDuration(step) {
    return step.layouts ? step.layouts.length * step.layoutMs + 600 : step.ms;
  }

  function tick() {
    try {
      const step = HS_DEMO[idx];
      if (!step) {
        idx = 0;
        sceneStart = performance.now();
        paint(HS_DEMO[0]);
      } else if (!paused) {
        const elapsed = performance.now() - sceneStart;
        if (elapsed >= stepDuration(step)) {
          idx = (idx + 1) % HS_DEMO.length;
          sceneStart = performance.now();
          paint(HS_DEMO[idx]);
        } else if (step.layouts) {
          // The directing beat walks grid -> spotlight -> custom on its own
          // cadence, derived from elapsed scene time.
          const li = Math.min(
            step.layouts.length - 1,
            Math.floor(elapsed / step.layoutMs),
          );
          if (stage.dataset.layout !== step.layouts[li]) {
            stage.dataset.layout = step.layouts[li];
            lbItems.forEach((it) =>
              it.classList.toggle("is-on", it.dataset.l === step.layouts[li]),
            );
          }
        }
      }
    } catch {
      // Never let an error kill the loop — the show must go on.
    }
    setTimeout(tick, 250);
  }
  tick();
}

function boot() {
  const params = new URLSearchParams(location.search);
  S.room = (params.get("room") || "").toUpperCase().trim() || null;
  S.role = S.room ? "guest" : "host";

  if (S.role === "guest") {
    // Guests land straight on the preflight modal (body.mode-app set in HTML).
    document.body.classList.add("guest-mode");
    bootStudio();
    return;
  }

  // Hosts land on the selling home page. The studio (and with it the camera
  // probe) only boots once they start a studio — no permissions before intent.
  for (const btn of document.querySelectorAll("[data-start]")) {
    btn.addEventListener("click", startHostStudio);
  }
  fitHeroStage();
  startHeroDemo();
  window.addEventListener("resize", fitHeroStage);
}

function startHostStudio() {
  if (hostStarted) return;
  hostStarted = true;
  document.body.classList.remove("mode-home");
  document.body.classList.add("mode-app");
  bootStudio();
  // Still inside the user gesture: focusing is safe on iOS too.
  els.nameInput?.focus();
  if (els.nameInput?.value) els.nameInput.select();
}

function bootStudio() {
  // Mobile guests get a leaner shell (no sidebar, floating controls).
  if (S.role === "guest") document.body.classList.add("guest-mode");

  if (!window.isSecureContext) {
    return showFatal(
      "Camera & WebRTC need HTTPS",
      "WaxWing must run on https:// (or localhost) so the browser will allow camera and microphone access.",
    );
  }

  try {
    S.name = localStorage.getItem(STORAGE_KEYS.name) || "";
  } catch { /* ignore */ }
  els.nameInput.value = S.name;

  // Welcome copy per role.
  if (S.role === "guest") {
    els.roleBlurb.textContent =
      `You're joining studio ${S.room}. Watch the host's stage live and jump on it with ` +
      `your camera and mic — both optional, so you can also join as a voice or ` +
      `listen-only guest. Your local master only exists if you choose to save it.`;
    els.btnEnterLabel.textContent = "Join live studio";
    els.saveLabel.textContent = "Record my master & send it to the host";
  } else {
    els.roleBlurb.textContent =
      "You're the host. Guests connect straight to your browser over WebRTC — no accounts, no servers. " +
      "Pick a name, choose your gear, and share the room code once you're on stage.";
    els.btnEnterLabel.textContent = "Enter the studio";
    els.saveLabel.textContent = "Save my local master";
  }

  // Restore the saved join prefs, then keep the toggles/selects coherent.
  els.optVideo.checked = readPref(STORAGE_KEYS.optVideo, true);
  els.optMic.checked = readPref(STORAGE_KEYS.optMic, true);
  els.optSave.checked = readPref(STORAGE_KEYS.optSave, true);
  syncMediaPrefs();

  renderCaps();
  els.recModeLabel.textContent = pickMimeType() || "unavailable";

  // The folder picker is a Chromium-desktop-only API; hide it elsewhere and
  // let the save hint carry the memory note instead.
  els.folderWrap.classList.toggle("hidden", !fs.fsSupported);

  // Wire static UI.
  els.btnEnter.addEventListener("click", handleEnter);
  wireThemePanel();
  els.btnShareScreen.addEventListener("click", toggleShare);
  els.btnRefreshDevices.addEventListener("click", () => populateDeviceSelects().then(startCameraPreview));
  els.camSelect.addEventListener("change", startCameraPreview);
  els.optVideo.addEventListener("change", () => {
    syncMediaPrefs();
    persistPrefs();
    if (els.optVideo.checked) {
      els.previewState.textContent = "Starting camera…";
      startCameraPreview();
    } else {
      stopPreview();
      els.previewState.textContent = "Camera off — the stage shows your name tile.";
      els.previewState.classList.remove("hidden");
    }
  });
  els.optMic.addEventListener("change", () => {
    syncMediaPrefs();
    persistPrefs();
  });
  els.optSave.addEventListener("change", () => {
    syncMediaPrefs();
    persistPrefs();
  });
  els.btnFolder.addEventListener("click", async () => {
    const handle = await fs.chooseDefaultDir();
    if (handle) updateFolderLabel();
  });
  els.btnCopyInvite.addEventListener("click", copyInvite);
  els.btnCopyInvite2.addEventListener("click", copyInvite);
  els.btnResetLayout.addEventListener("click", () => S.stage?.resetLayout());
  els.btnRecord.addEventListener("click", toggleRecord);
  els.btnStageRec.addEventListener("click", toggleStageRec);
  els.btnExit.addEventListener("click", handleExit);
  els.btnFatalReload.addEventListener("click", () => location.reload());
  els.btnSyncClose.addEventListener("click", () => els.syncModal.classList.add("hidden"));
  els.stageAudioHint.addEventListener("click", () => {
    const v = S.guestStageVideo;
    if (!v) return;
    v.muted = false;
    v.play().catch(() => notify("Browser blocked audio — tap again after interacting.", "danger"));
    els.stageAudioHint.classList.add("hidden");
  });
  window.addEventListener("devicechange", () => populateDeviceSelects(true).then(startCameraPreview));
  window.addEventListener("beforeunload", (e) => {
    if (S.recActive || S.showActive || S.stageRecActive || (S.sync && !S.sync.done) || uploadInProgress) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  // Full screen for the stage (guests on phones live here).
  els.btnFullscreen.addEventListener("click", toggleStageFullscreen);
  document.addEventListener("fullscreenchange", updateFsIcon);
  document.addEventListener("webkitfullscreenchange", updateFsIcon);

  // Re-evaluate the "rotate your phone" nudge on any size/orientation change.
  const onViewportChange = () => updateOrientHint();
  window.addEventListener("resize", onViewportChange);
  window.addEventListener("orientationchange", onViewportChange);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) updateOrientHint();
  });

  if (isIOS()) {
    // iOS won't reveal device labels without a user gesture — probing here
    // would just throw a premature permission prompt, so populate bare lists.
    populateDeviceSelects().then(startCameraPreview);
  } else if (S.wantVideo || S.wantAudio) {
    // Warm the exact media the participant enabled (never ask for a camera
    // the user switched off — that permission probe is the feedback trigger
    // guests shouldn't hit when joining as voice/listen-only).
    navigator.mediaDevices
      ?.getUserMedia({ audio: S.wantAudio, video: S.wantVideo })
      .then(async (st) => {
        st.getTracks().forEach((t) => t.stop());
        await populateDeviceSelects();
        startCameraPreview();
      })
      .catch(async () => {
        await populateDeviceSelects();
        startCameraPreview();
      });
  } else {
    populateDeviceSelects().then(startCameraPreview);
  }

  updateFolderLabel();
}

// ---- join prefs (camera/mic toggles + local-master save) ------------------

function readPref(key, dflt) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? dflt : v !== "0";
  } catch {
    return dflt;
  }
}

function persistPrefs() {
  try {
    localStorage.setItem(STORAGE_KEYS.optVideo, els.optVideo.checked ? "1" : "0");
    localStorage.setItem(STORAGE_KEYS.optMic, els.optMic.checked ? "1" : "0");
    localStorage.setItem(STORAGE_KEYS.optSave, els.optSave.checked ? "1" : "0");
  } catch {
    /* private mode */
  }
}

// Keep the selects, the save toggle and the hints in sync with the switches.
function syncMediaPrefs() {
  S.wantVideo = els.optVideo.checked;
  S.wantAudio = els.optMic.checked;
  els.camSelect.disabled = !S.wantVideo;
  els.micSelect.disabled = !S.wantAudio;

  const anyMedia = S.wantVideo || S.wantAudio;
  const recordable = anyMedia && canRecordVideo();
  els.optSave.disabled = !recordable;
  els.saveRow.classList.toggle("switch-disabled", !recordable);
  if (!recordable && els.optSave.checked) els.optSave.checked = false;
  S.saveMaster = els.optSave.checked && recordable;

  let hint;
  if (!anyMedia) {
    hint =
      "No camera or mic — you can still join and watch the stage, but there is nothing to record.";
  } else if (!canRecordVideo()) {
    hint = "This browser can't record video locally — you'll still be live on the stage.";
  } else if (S.role === "guest") {
    hint = S.saveMaster
      ? "Saved at full quality on your device, then streamed to the host when the show stops."
      : "You'll be live on the stage, but nothing is stored or sent when the show records.";
  } else {
    hint = S.saveMaster
      ? "Records your own camera at full quality when you press Record — you can pick the folder then."
      : "You'll run the show, but keep no local master yourself.";
  }
  els.saveHint.textContent = hint;
}

// ---- studio theme (backgrounds, logo, colors, elements, templates) --------

// themeSet applies a mutation to S.theme, pushes it into the stage DOM and
// the composer canvas, and persists it. The host's stage is the live
// preview, so every panel change is immediately visible — and because the
// composer reads the same theme, guests and the Director's Cut follow.
function themeSet(mutate) {
  if (!S.theme) S.theme = loadTheme();
  mutate(S.theme);
  applyTheme();
  saveTheme(S.theme);
}

function applyTheme() {
  if (!S.stage) return;
  S.stage.setTheme(S.theme);
  S.stage.applyTemplate(S.theme.template, S.theme.custom);
  applyStageTheme(S.theme, els.stage);
  refreshThemePanel();
  refreshLayoutBar();
}

// The stage-layout quick bar: visible only while shared screens are live, so
// the host can flip between Auto / Grid (head-to-head) / Spotlight / Custom
// without opening the theme panel. Mirrors the theme panel's template chips.
function refreshLayoutBar() {
  if (!els.stageLayoutBar) return;
  const host = S.role === "host";
  const screenCount = host && S.stage ? S.stage.order.filter((k) => S.stage.entries.get(k)?.isScreen).length : 0;
  els.stageLayoutBar.classList.toggle("hidden", !host || screenCount === 0);
  if (host && S.theme) {
    for (const btn of els.stageLayoutBar.querySelectorAll("[data-layout]")) {
      btn.classList.toggle("active", btn.dataset.layout === S.theme.template);
    }
  }
}

function refreshThemePanel() {
  if (!S.theme) return;
  const t = S.theme;
  for (const btn of els.themePanel.querySelectorAll("[data-tpl]")) {
    btn.classList.toggle("active", btn.dataset.tpl === t.template);
  }
  for (const btn of els.bgSwatches.querySelectorAll("[data-bg]")) {
    const p = BG_PRESETS.find((b) => b.key === btn.dataset.bg);
    const active =
      p &&
      ((t.background.kind === "radial" && p.kind === "radial" && t.background.from === p.from && t.background.to === p.to) ||
        (t.background.kind === "gradient" && p.kind === "gradient" && t.background.from === p.from && t.background.to === p.to) ||
        (t.background.kind === "color" && p.kind === "color" && t.background.color === p.color));
    btn.classList.toggle("active", Boolean(active));
  }
  for (const btn of els.accentSwatches.querySelectorAll("[data-accent]")) {
    btn.classList.toggle("active", btn.dataset.accent === t.accent);
  }
  els.accentCustom.value = t.accent || DEFAULT_THEME.accent;
  els.bgCustom.value =
    t.background.kind === "color" ? t.background.color : DEFAULT_THEME.background.color;
  els.logoEnabled.checked = Boolean(t.logo?.enabled);
  els.logoPos.value = t.logo?.pos || "br";
  els.logoSize.value = String(Math.round((t.logo?.size || 0.13) * 100));
  els.optNames.checked = t.showNames !== false;
  els.optChips.checked = t.showChips !== false;
  els.optWatermark.checked = t.showWatermark !== false;
  els.optFrame.checked = t.frame !== false;
  els.btnLogoRemove.classList.toggle("hidden", !t.logo?.dataUrl);
  els.btnBgRemove.classList.toggle("hidden", t.background.kind !== "image");
}

function wireThemePanel() {
  // Host-only feature: the broadcast is the host's stage, so the panel
  // lives with the host controls (hidden for guests by handleEnter).
  els.btnTheme.addEventListener("click", () => els.themeModal.classList.remove("hidden"));
  els.btnThemeClose.addEventListener("click", () => els.themeModal.classList.add("hidden"));
  els.themeModal.addEventListener("click", (e) => {
    if (e.target === els.themeModal) els.themeModal.classList.add("hidden");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !els.themeModal.classList.contains("hidden")) {
      els.themeModal.classList.add("hidden");
    }
  });

  // Template chips (theme panel + the stage quick bar share the same wiring).
  const wireTplChips = (btn) => {
    btn.addEventListener("click", () => {
      const tpl = btn.dataset.tpl || btn.dataset.layout;
      themeSet((t) => {
        t.template = tpl;
        if (tpl !== "custom") t.custom = null;
      });
      notify(`Layout: ${tpl === "auto" ? "Auto" : tpl === "grid" ? "Grid (head-to-head)" : tpl === "spotlight" ? "Spotlight" : "Custom"}.`, "");
    });
  };
  for (const btn of els.themePanel.querySelectorAll("[data-tpl]")) wireTplChips(btn);
  for (const btn of els.stageLayoutBar.querySelectorAll("[data-layout]")) wireTplChips(btn);

  // Save the host's current arrangement as a custom template.
  els.btnSaveArrangement.addEventListener("click", () => {
    if (!S.stage) return;
    const rects = S.stage.getRects().map((r) => ({
      x: Number(r.x.toFixed(4)),
      y: Number(r.y.toFixed(4)),
      w: Number(r.w.toFixed(4)),
      h: Number(r.h.toFixed(4)),
    }));
    themeSet((t) => {
      t.template = "custom";
      t.custom = rects;
    });
    notify("Arrangement saved as the Custom template.", "success");
  });
  els.btnResetAuto.addEventListener("click", () => {
    themeSet((t) => {
      t.template = "auto";
      t.custom = null;
    });
  });

  // Background swatches + custom color + image upload.
  buildSwatches(els.bgSwatches, BG_PRESETS, "bg");
  for (const btn of els.bgSwatches.querySelectorAll("[data-bg]")) {
    btn.addEventListener("click", () => {
      const p = BG_PRESETS.find((b) => b.key === btn.dataset.bg);
      if (!p) return;
      themeSet((t) => {
        t.background = p.kind === "color"
          ? { kind: "color", color: p.color, from: p.from, to: p.to, angle: p.angle, image: null, imageLabel: "" }
          : { kind: p.kind, from: p.from, to: p.to, angle: p.angle, color: p.color || "#080705", image: null, imageLabel: "" };
      });
    });
  }
  els.bgCustom.addEventListener("input", () => {
    themeSet((t) => {
      t.background = { kind: "color", color: els.bgCustom.value, from: "#241706", to: "#080705", angle: 160, image: null, imageLabel: "" };
    });
  });
  els.btnBgUpload.addEventListener("click", () => els.bgFile.click());
  els.btnBgRemove.addEventListener("click", () => {
    themeSet((t) => {
      const p = BG_PRESETS[0];
      t.background = { ...p, image: null, imageLabel: "" };
    });
  });
  els.bgFile.addEventListener("change", async () => {
    const file = els.bgFile.files?.[0];
    if (!file) return;
    try {
      const { dataUrl, label } = await fileToDataUrl(file, { maxDim: 1920 });
      themeSet((t) => {
        t.background = { ...t.background, kind: "image", image: dataUrl, imageLabel: label, color: t.background.color || "#080705" };
      });
      notify("Background image applied.", "success");
    } catch (err) {
      notify(err.message, "danger");
    } finally {
      els.bgFile.value = "";
    }
  });

  // Accent swatches + custom.
  buildSwatches(els.accentSwatches, ACCENT_PRESETS.map((c) => ({ key: c, color: c, kind: "color" })), "accent");
  for (const btn of els.accentSwatches.querySelectorAll("[data-accent]")) {
    btn.addEventListener("click", () => {
      themeSet((t) => {
        t.accent = btn.dataset.accent;
      });
    });
  }
  els.accentCustom.addEventListener("input", () => {
    themeSet((t) => {
      t.accent = els.accentCustom.value;
    });
  });

  // Logo upload / removal / position / size / toggle.
  els.btnLogoUpload.addEventListener("click", () => els.logoFile.click());
  els.btnLogoRemove.addEventListener("click", () => {
    themeSet((t) => {
      t.logo = { ...t.logo, dataUrl: null, label: "" };
    });
  });
  els.logoFile.addEventListener("change", async () => {
    const file = els.logoFile.files?.[0];
    if (!file) return;
    try {
      const { dataUrl, label } = await fileToDataUrl(file, { maxDim: 640, preferPng: /png|svg/i.test(file.type) });
      themeSet((t) => {
        t.logo = { ...t.logo, dataUrl, label, enabled: true };
      });
      notify("Logo applied — it's live on the stage and in the broadcast.", "success");
    } catch (err) {
      notify(err.message, "danger");
    } finally {
      els.logoFile.value = "";
    }
  });
  els.logoEnabled.addEventListener("change", () => {
    themeSet((t) => {
      t.logo = { ...t.logo, enabled: els.logoEnabled.checked };
    });
  });
  els.logoPos.addEventListener("change", () => {
    themeSet((t) => {
      t.logo = { ...t.logo, pos: els.logoPos.value };
    });
  });
  els.logoSize.addEventListener("input", () => {
    themeSet((t) => {
      t.logo = { ...t.logo, size: Number(els.logoSize.value) / 100 };
    });
  });

  // Element toggles.
  const bindToggle = (input, key) => {
    input.addEventListener("change", () => {
      themeSet((t) => {
        t[key] = input.checked;
      });
    });
  };
  bindToggle(els.optNames, "showNames");
  bindToggle(els.optChips, "showChips");
  bindToggle(els.optWatermark, "showWatermark");
  bindToggle(els.optFrame, "frame");

  refreshThemePanel();
}

// Renders the background / accent preset swatches into their containers.
function buildSwatches(container, presets, kind) {
  container.innerHTML = "";
  for (const p of presets) {
    const style =
      kind === "bg"
        ? p.kind === "color"
          ? `background:${p.color}`
          : `background:linear-gradient(150deg, ${p.from}, ${p.to})`
        : `background:${p.color}`;
    const btn = el("button", {
      type: "button",
      class: "swatch",
      style,
      title: p.label || p.key,
      "aria-label": p.label || p.key,
    });
    if (kind === "bg") btn.dataset.bg = p.key;
    else btn.dataset.accent = p.key;
    container.append(btn);
  }
}

// ---- camera preview (preflight, before you commit to entering) -----------

// A cheap, muted self-view so the user can verify their camera in the
// welcome modal BEFORE joining. On Enter the master ladder re-opens the
// camera at full resolution; the preview stream is only ever a low-res
// stand-in and is stopped the moment the studio opens.

const PREVIEW_RES = { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } };

function stopPreview() {
  stopStream(S.previewStream);
  S.previewStream = null;
  S.previewCam = "";
  els.previewVideo.srcObject = null;
}

async function startCameraPreview() {
  if (!navigator.mediaDevices?.getUserMedia || S.entered) return;
  if (!S.wantVideo) return; // camera toggled off — nothing to preview
  const camId = els.camSelect.value;
  // Already previewing this camera — don't restart (e.g. devicechange).
  if (S.previewCam === camId && S.previewStream) return;
  stopPreview();
  S.previewCam = camId;
  els.previewState.textContent = "Starting camera…";
  els.previewState.classList.remove("hidden");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: camId ? { exact: camId } : undefined, ...PREVIEW_RES },
      audio: false,
    });
    // The selection may have changed while the permission prompt was up.
    if (els.camSelect.value !== camId || S.entered) {
      stopStream(stream);
      return;
    }
    S.previewStream = stream;
    els.previewVideo.srcObject = stream;
    els.previewState.classList.add("hidden");
  } catch {
    // Permission denied / no camera: stay graceful — joining is still fine.
    els.previewVideo.srcObject = null;
    els.previewState.textContent = camId
      ? "Preview unavailable for that camera — you can still join and check on stage."
      : "Camera preview needs permission — you can still join and check on stage.";
    els.previewState.classList.remove("hidden");
  }
}

let uploadInProgress = false;

// ---- capabilities ---------------------------------------------------------

function renderCaps() {
  const isChromium =
    /Chrome|Chromium|Edg|Brave/i.test(navigator.userAgent) && !/Firefox/i.test(navigator.userAgent);
  const caps = [
    { label: "Chromium desktop recommended (4K + disk recording)", ok: isChromium, optional: !isChromium },
    { label: "Direct-to-disk recording", ok: fs.fsSupported, optional: true },
    { label: "MediaRecorder", ok: recorderSupported, optional: false },
    { label: "Region Capture for 1080p Director's Cut", ok: cropSupported, optional: true },
    { label: "WebRTC peer-to-peer", ok: typeof RTCPeerConnection !== "undefined", optional: false },
  ];
  for (const c of caps) {
    const cls = c.ok ? "ok" : c.optional ? "warn" : "bad";
    els.capList.append(el("li", { class: `cap-item ${cls}`, text: c.label }));
  }
}

// ---- device selects -------------------------------------------------------

async function populateDeviceSelects(keepSelection = false) {
  const prev = { cam: els.camSelect.value, mic: els.micSelect.value };
  let cams = [];
  let mics = [];
  try {
    ({ cams, mics } = await listDevices());
  } catch { /* permission prompt */ }

  const fill = (select, list, fallbackLabel) => {
    const before = keepSelection ? select.value : "";
    select.innerHTML = "";
    select.append(el("option", { value: "", text: fallbackLabel }));
    for (const d of list) {
      select.append(el("option", { value: d.deviceId, text: d.label || fallbackLabel }));
    }
    if (keepSelection && before) select.value = before;
  };
  fill(els.camSelect, cams, "Default camera");
  fill(els.micSelect, mics, "Default microphone");

  if (!keepSelection) {
    const saved = savedDeviceIds();
    if (saved.cam) els.camSelect.value = saved.cam;
    if (saved.mic) els.micSelect.value = saved.mic;
  }
  if (!keepSelection && !cams.length && !mics.length) {
    // keep whatever the user typed pre-permission
  }
  if (prev.cam) els.camSelect.value = prev.cam || els.camSelect.value;
  if (prev.mic) els.micSelect.value = prev.mic || els.micSelect.value;
}

async function copyInvite() {
  const url = inviteUrl();
  if (!S.room) {
    notify("The studio is still starting — try again in a second.", "warn");
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    const ta = el("textarea", { style: "position:fixed;opacity:0" });
    ta.value = url;
    document.body.append(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch { /* ignore */ }
    ta.remove();
  }
  notify("Invite link copied — send it to your guests.", "success");
}

function updateFolderLabel() {
  const name = fs.dirName();
  els.folderLabel.textContent = name
    ? `Folder: ${name} — recordings stream straight to disk.`
    : "Recommended — writes 4K masters straight to disk. Safari/Firefox fall back to memory.";
}

// ---- entering the studio --------------------------------------------------

async function handleEnter() {
  if (S.busy) return;
  S.name = els.nameInput.value.trim().slice(0, 24);
  if (!S.name) {
    els.welcomeError.textContent = "Pick a name so the others know who you are.";
    els.welcomeError.classList.remove("hidden");
    return;
  }
  els.welcomeError.classList.add("hidden");
  syncMediaPrefs(); // toggles may have changed since the modal opened
  persistPrefs();
  S.busy = true;
  setEnterState(S.wantVideo ? "Starting cameras…" : "Connecting…", true);

  try {
    const camId = S.wantVideo ? els.camSelect.value : "";
    const micId = S.wantAudio ? els.micSelect.value : "";
    const { stream, quality } = await openMasterStream({
      camId,
      micId,
      wantVideo: S.wantVideo,
      wantAudio: S.wantAudio,
      onAttempt: (ladder) => setEnterState(`Requesting ${ladder.label} camera…`, true),
    });
    rememberDeviceIds(camId, micId);
    S.masterStream = stream;
    S.hasMedia = stream.getTracks().length > 0;
    S.quality = quality;
    S.proxyVideoTrack =
      S.role === "guest" && S.wantVideo ? makeProxyVideoTrack(stream) : null;

    // The preflight preview served its purpose — drop it so the camera
    // light is off until the master ladder opens the real session stream.
    stopPreview();
    els.previewVideo.srcObject = stream;
    els.previewState.classList.add("hidden");
    try {
      localStorage.setItem(STORAGE_KEYS.name, S.name);
    } catch { /* ignore */ }

    els.welcomeModal.classList.add("hidden");
    els.roomCluster.classList.remove("hidden");
    els.hostControls.classList.remove("hidden");
    S.entered = true;

    if (S.role === "host") await setupHost();
    else await setupGuest();

    const cap = S.wantVideo ? quality : "no camera";
    els.qualityNote.textContent =
      `Local capture ${cap} · P2P link 1280×720 · ${pickMimeType() || "webm"}`;
    if (S.role === "host") {
      els.capQualityLabel.textContent = quality;
      els.sidebar.classList.remove("hidden");
      els.btnExitLabel.textContent = "End show";
    } else {
      els.btnResetLayout.hidden = true;
      els.btnStageRec.hidden = true;
      els.btnRecord.hidden = true;
      els.btnTheme.hidden = true; // the broadcast carries the host's theme
      els.btnExitLabel.textContent = "Leave";
    }
    refreshShareControls();
    els.btnFullscreen.classList.remove("hidden");
    updateFsIcon();
    updateOrientHint();
  } catch (err) {
    els.welcomeModal.classList.remove("hidden");
    els.welcomeError.textContent = err.message;
    els.welcomeError.classList.remove("hidden");
    cleanupMedia();
  } finally {
    S.busy = false;
    setEnterState("", false);
  }
}

function setEnterState(text, busy) {
  els.btnEnter.disabled = busy;
  if (text) els.btnEnterLabel.textContent = text;
  else {
    els.btnEnterLabel.textContent =
      S.role === "guest" ? "Join live studio" : "Enter the studio";
  }
}

function cleanupMedia() {
  stopStream(S.masterStream);
  S.masterStream = null;
  S.proxyVideoTrack?.stop();
  S.proxyVideoTrack = null;
}

// ---- host setup -----------------------------------------------------------

async function setupHost() {
  S.busy = true;
  try {
    // Stage + composer canvas (the broadcast itself). Created once.
    if (!S.stage) {
      S.stage = new Stage({ container: els.stage, canvas: els.composerCanvas });
      S.stage.initCanvas();
      S.stage.addParticipant({
        key: "self",
        label: S.name,
        isSelf: true,
        hasVideo: S.wantVideo,
        hasAudio: S.wantAudio,
      });
      S.stage.setStream("self", S.masterStream);
    }

    // Host-only studio theme: apply the saved look to the stage DOM and the
    // composer canvas (guests receive it baked into the broadcast video).
    S.theme = loadTheme();
    applyTheme();

    // Audio mixer — the host is the star that mixes everyone.
    if (!S.bus) {
      S.bus = new AudioBus();
      S.bus.setRefreshListener(() => S.net?.refreshAllStageCalls());
      await S.bus.start();
    }
    S.bus.addSource("self", S.masterStream);

    // Room code: retry a few times on the unlikely "id taken" collision.
    let started = false;
    for (let attempt = 0; attempt < 3 && !started; attempt++) {
      S.room = randomRoomCode(APP.roomCodeLength);
      els.roomChipCode.textContent = S.room;
      els.inviteCode.textContent = S.room;

      const net = new Network({ displayName: S.name, onEvent: hostEvents });
      net.setStageStreamProvider((guestKey) => stageStreamFor(guestKey));
      S.net = net;
      try {
        await net.host({ roomCode: S.room });
        started = true;
      } catch (err) {
        net.destroy();
        S.net = null;
        if (err?.code === "room-taken") continue;
        throw err;
      }
    }
    if (!started) throw new Error("Could not claim a room code — try again.");

    els.btnResetLayout.hidden = false;
    els.stageEmpty.classList.remove("hidden");
    setPill("waiting", "Waiting for guests");
  } finally {
    S.busy = false;
  }
}

function stageStreamFor(guestKey) {
  const videoTrack = S.stage.canvasTrack;
  const audioTracks = S.bus.guestBusStream(guestKey).getAudioTracks();
  return new MediaStream([videoTrack, ...audioTracks]);
}

function setPill(kind, text) {
  els.connPill.textContent = text;
  els.connPill.className = `pill pill-${kind}`;
}

// ---- full screen + orientation -------------------------------------------

function toggleStageFullscreen() {
  const shell = els.stageShell;
  const video = S.guestStageVideo || els.stage.querySelector("video");
  try {
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
      if (typeof shell.requestFullscreen === "function") {
        shell.requestFullscreen({ navigationUI: "hide" }).catch(() => {
          notify("Full screen was blocked by the browser.", "warn");
        });
      } else if (video && typeof video.webkitEnterFullscreen === "function") {
        video.webkitEnterFullscreen(); // iOS Safari video-only path
      } else {
        notify("Full screen isn't supported in this browser.", "warn");
      }
    } else if (typeof document.exitFullscreen === "function") {
      document.exitFullscreen();
    } else if (video && typeof video.webkitExitFullscreen === "function") {
      video.webkitExitFullscreen();
    }
  } catch (err) {
    notify(`Full screen failed: ${err.message}`, "danger");
  }
  updateFsIcon();
}

function updateFsIcon() {
  const on = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
  const active = on ? "Exit full screen" : "Full screen";
  els.btnFullscreen?.classList.toggle("fs-active", on);
  els.btnFullscreen?.querySelector(".ico-fs-in")?.classList.toggle("hidden", on);
  els.btnFullscreen?.querySelector(".ico-fs-out")?.classList.toggle("hidden", !on);
  if (els.btnFullscreen) {
    els.btnFullscreen.setAttribute("aria-label", active);
    els.btnFullscreen.title = active;
  }
}

function updateOrientHint() {
  const portraitPhone =
    window.matchMedia("(orientation: portrait) and (max-width: 820px)").matches;
  const show =
    S.role === "guest" && S.stageLive && portraitPhone && !S.recActive && !document.hidden;
  els.orientHint.classList.toggle("hidden", !show);
}

function setGuestCountUI() {
  const n = S.net?.guestCount() || 0;
  els.guestCountBadge.textContent = `${n}/${MAX_GUESTS}`;
  els.guestListEmpty.classList.toggle("hidden", n > 0);
}

function makeGuestRow(key, name) {
  const initials = name.trim().slice(0, 2).toUpperCase() || "?";
  const li = el("li", { class: "guest-row", dataset: { key } },
    el("span", { class: "guest-avatar", text: initials }),
    el("span", { class: "guest-name", text: name }),
    el("span", { class: "guest-state", text: "Joined" }),
  );
  els.guestList.append(li);
  return li;
}

// ---- host: network events ------------------------------------------------

function hostEvents(e) {
  switch (e.type) {
    case "peer-state":
      if (e.state === "online") {
        setPill("live", "Studio live");
        els.stageEmpty.classList.remove("hidden");
        notify("Studio is live — share the room code.", "success");
      } else if (e.state === "disconnected" || e.state === "error") {
        setPill("busy", "Reconnecting…");
        try { S.net?.peer?.reconnect(); } catch { /* ignore */ }
      }
      break;
    case "fatal":
      if (e.code !== "room-taken") showFatal("Connection problem", e.message);
      break;
    case "guest-add": {
      if (S.net.guestCount() > MAX_GUESTS) {
        notify(`${e.name} couldn't join — the studio is full (host + ${MAX_GUESTS} guests).`, "danger");
        S.net.rejectGuest(e.key, "show-full");
        break;
      }
      const media = e.media || { video: true, audio: true };
      S.stage.addParticipant({
        key: e.key,
        label: e.name,
        hasVideo: media.video !== false,
        hasAudio: media.audio !== false,
      });
      const row = makeGuestRow(e.key, e.name);
      // Tell the host what this guest is actually bringing (or not).
      if (media.video === false) {
        row.querySelector(".guest-state").textContent =
          media.audio === false ? "Listening" : "Voice only";
      }
      S.bus.ensureGuestBus(e.key);
      setGuestCountUI();
      updateComposerNeed();
      // Late joiners during a show get the record cue right away (their own
      // save opt-in decides whether that starts a recorder).
      if (S.showActive) S.net.sendToGuest(e.key, { t: "rec-start", run: S.recRun });
      if (S.stageRecActive) S.net.sendToGuest(e.key, { t: "stage-rec-on" });
      break;
    }
    case "guest-meta":
      S.stage.setLabel(e.key, e.name);
      els.guestList.querySelector(`[data-key="${e.key}"] .guest-name`).textContent = e.name;
      break;
    case "guest-media":
      S.stage.setStream(e.key, e.stream);
      S.bus.addSource(e.key, e.stream);
      break;
    case "guest-screen-media": {
      // A guest's shared tab/window/screen arrives as its own tile + audio
      // source (owned by that guest for the mixer's no-self-echo rules).
      const name = S.net.guests.get(e.key)?.name || "Guest";
      const sk = screenKeyFor(e.key);
      if (!S.stage.entries.has(sk)) {
        S.stage.addParticipant({
          key: sk,
          label: name,
          isScreen: true,
          hasVideo: true,
          hasAudio: Boolean(e.stream.getAudioTracks().length),
        });
      }
      S.stage.setStream(sk, e.stream);
      S.bus.addSource(sk, e.stream, e.key);
      updateComposerNeed();
      refreshLayoutBar();
      break;
    }
    case "guest-screen-remove":
      removeRemoteScreen(e.key);
      break;
    case "guest-remove":
      removeRemoteScreen(e.key);
      S.stage.removeParticipant(e.key);
      S.bus.removeGuestBus(e.key);
      S.bus.removeSource(e.key);
      setGuestCountUI();
      updateComposerNeed();
      els.guestList.querySelector(`[data-key="${e.key}"]`)?.remove();
      if (S.sync && !S.sync.done) failSyncRow(e.key, "left the show");
      break;
    case "dc-open":
      break;
    case "data":
      hostOnData(e.key, e.msg);
      break;
    case "binary":
      hostOnBinary(e.key, e.chunk);
      break;
  }
}

// ---- host: protocol messages + sync receive ------------------------------

// ---- screen share ---------------------------------------------------------

const screenKeyFor = (peerKey) => (peerKey === "self" ? "screen:self" : `screen:${peerKey}`);

// Host: drop one remote participant's shared screen (tile + its audio).
function removeRemoteScreen(peerKey) {
  const sk = screenKeyFor(peerKey);
  S.stage?.removeParticipant(sk);
  S.bus?.removeSource(sk);
  updateComposerNeed();
  refreshLayoutBar();
}

async function toggleShare() {
  if (S.busy || !S.entered) return;
  if (S.shareActive) {
    stopShare();
    return;
  }
  if (!screenShareSupported()) {
    notify("Screen sharing isn't supported in this browser (it needs getDisplayMedia).", "warn");
    return;
  }
  let stream;
  try {
    stream = await openScreenShare();
  } catch (err) {
    if (err?.cancelled) return; // user closed the picker
    notify(`Couldn't start sharing: ${err.message}`, "danger");
    return;
  }
  if (!stream || !stream.getVideoTracks().length) {
    stream?.getTracks().forEach((t) => t.stop());
    return;
  }
  const track = stream.getVideoTracks()[0];
  const hasAudio = stream.getAudioTracks().length > 0;
  // The browser's own "Stop sharing" bar and the picker both end the track.
  track.addEventListener("ended", () => stopShare(true));

  S.screenStream = stream;
  if (S.role === "guest") {
    // Guest -> host: the screen is its own media call; the host composes it
    // into the broadcast, so every guest (including this one) sees it live.
    const proxy = makeScreenProxyTrack(stream);
    S.screenProxyTrack = proxy;
    const out = new MediaStream();
    if (proxy) out.addTrack(proxy);
    for (const t of stream.getAudioTracks()) out.addTrack(t);
    S.net?.shareScreen(out);
  } else {
    // Host share: straight onto the local stage/composer (no transport hop).
    const sk = screenKeyFor("self");
    if (!S.stage.entries.has(sk)) {
      S.stage.addParticipant({
        key: sk,
        label: S.name,
        isScreen: true,
        hasVideo: true,
        hasAudio,
      });
    }
    S.stage.setStream(sk, stream);
    // Tab audio joins the mix under "self" ownership: recorded in the
    // Director's Cut and heard by guests, but NOT replayed on the host's own
    // speakers (that would loop the tab back into itself).
    S.bus.addSource(sk, stream, "self");
    updateComposerNeed();
    refreshLayoutBar();
  }
  S.shareActive = true;
  refreshShareControls();
  notify("You're sharing your screen — it's live on the stage.", "success");
}

function stopShare(silent = false) {
  const wasActive = S.shareActive;
  S.shareActive = false;
  if (S.role === "guest") {
    if (wasActive || S.screenProxyTrack) {
      S.net?.sendToHost({ t: "screen-off" });
      S.net?.stopScreenShare();
    }
    S.screenProxyTrack?.stop();
    S.screenProxyTrack = null;
  } else if (S.screenStream) {
    removeRemoteScreen("self");
  }
  stopStream(S.screenStream);
  S.screenStream = null;
  refreshShareControls();
  if (wasActive && !silent) notify("Screen sharing stopped.", "");
}

function refreshShareControls() {
  const show = S.entered && screenShareSupported();
  els.btnShareScreen?.classList.toggle("hidden", !show);
  els.btnShareScreen?.classList.toggle("on", S.shareActive);
  if (els.btnShareScreenLabel) {
    els.btnShareScreenLabel.textContent = S.shareActive ? "Stop" : "Share";
  }
  const title = S.shareActive
    ? "Stop sharing your screen"
    : "Share your screen, a window, or a tab";
  els.btnShareScreen?.setAttribute("aria-label", title);
  els.btnShareScreen?.setAttribute("title", title);
}

function hostOnData(key, msg) {
  if (!msg || typeof msg !== "object") return;
  switch (msg.t) {
    case "screen-off":
      removeRemoteScreen(key);
      break;
    case "rec-done": {
      // A guest finished its local master (or can't record at all — e.g.
      // iOS Safari). Either way, stop waiting for it.
      if (S.recAcked) S.recAcked.add(key);
      if (S.pendingRecAcks) S.pendingRecAcks.delete(key);
      break;
    }
    case "sync-start": {
      beginGuestSync(key, msg);
      break;
    }
    case "sync-end": {
      // Bytes tell the truth; this just confirms intent.
      break;
    }
  }
}

function hostOnBinary(key, chunk) {
  const row = S.sync?.rows.get(key);
  if (!row || row.done || row.failed) return;
  row.received += chunk.length;
  try {
    row.sink.write(chunk);
  } catch (err) {
    failSyncRow(key, "write error");
    return;
  }
  const pct = row.size ? Math.min(100, (row.received / row.size) * 100) : 0;
  const now = Date.now();
  if (now - (row.lastPaint || 0) > 180) {
    row.lastPaint = now;
    row.bar.style.width = `${pct}%`;
    row.statusEl.textContent = `Receiving ${fmtBytes(row.received)}${row.size ? ` / ${fmtBytes(row.size)}` : ""}`;
  }
  if (row.size && row.received >= row.size) finishGuestSync(key);
}

async function beginGuestSync(key, msg) {
  const row = S.sync?.rows.get(key);
  if (!row || row.done) return;
  row.size = msg.size || 0;
  row.statusEl.textContent = "Receiving…";
  if (!row.size) {
    finishGuestSync(key);
    return;
  }
  const guestName = S.net.guests.get(key)?.name || "guest";
  const fileName = safeName(guestName) + "-" + (msg.name || "recording.webm");
  try {
    row.sink = await fs.createRecordingSink(fileName);
    row.fileName = fileName;
  } catch (err) {
    failSyncRow(key, "folder unavailable");
  }
}

async function finishGuestSync(key) {
  const row = S.sync?.rows.get(key);
  if (!row || row.done) return;
  row.done = true;
  try {
    if (row.sink) {
      const res = await row.sink.close();
      row.mode = res.mode;
      row.blob = res.blob;
      row.fileName = res.fileName;
      row.dirName = res.dirName;
      S.sync.files.push(res);
    }
    row.statusEl.textContent = row.blob
      ? `Saved ${fmtBytes(row.blob.size)} ✓`
      : "Nothing to sync";
    row.bar.style.width = "100%";
    row.li.classList.add("done");
    if (row.blob && row.mode === "memory") {
      // No host folder was picked — get the file off the wire anyway.
      downloadBlob(row.blob, row.fileName);
      row.statusEl.textContent = "Downloaded ✓";
    }
  } catch (err) {
    failSyncRow(key, "save failed");
    return;
  }
  S.sync.doneCount++;
  checkSyncComplete();
}

function failSyncRow(key, why) {
  const row = S.sync?.rows.get(key);
  if (!row) return;
  row.failed = true;
  row.done = true;
  row.statusEl.textContent = `— ${why}`;
  row.li.classList.add("fail");
  try { row.sink?.close(); } catch { /* ignore */ }
  S.sync.doneCount++;
  checkSyncComplete();
}

function checkSyncComplete() {
  if (!S.sync || S.sync.done) return;
  if (S.sync.doneCount >= S.sync.rows.size) {
    S.sync.done = true;
    els.btnSyncClose.disabled = false;
    els.syncChip.classList.add("hidden");
    els.dontClosePill.classList.add("hidden");
    notify(`All guest recordings synced (${S.sync.files.length} file${S.sync.files.length === 1 ? "" : "s"}).`, "success");
    if (S.stageRecActive) showDontClose(true); // stage rec may still run
  }
}

// ---- host: record controls ------------------------------------------------

async function toggleRecord() {
  if (S.busy || S.role !== "host") return;
  if (S.showActive) await stopShow();
  else await startShow();
}

async function ensureFolder() {
  if (fs.hasDir()) {
    const ok = await fs.ensureDirUsable({ hasGesture: true });
    if (ok) return true;
  }
  const dir = await fs.chooseDefaultDir({ quiet: true });
  if (dir) {
    updateFolderLabel();
    return true;
  }
  return false;
}

// The host's Record button drives the whole SHOW. Everyone who opted in at
// preflight saves their own local master; everyone who opted out stays live
// with nothing stored. The host's own recorder only runs when the host opted
// in, but the run is always broadcast so guests that opted in record theirs.
async function startShow() {
  if (S.busy || S.showActive) return;
  S.busy = true;
  S.recRun = String(Date.now());
  const hostSaves = S.saveMaster && S.hasMedia;
  try {
    if (hostSaves) {
      if (fs.fsSupported) {
        if (!(await ensureFolder())) {
          notify("Recording cancelled — pick a folder first.", "danger");
          return;
        }
      } else {
        // No File System Access here (iOS Safari / Android / some WebViews):
        // fall back to the PRD's in-memory Blob recording with a warning.
        notify("This browser can't write straight to disk — recording to memory. Keep shows short.", "warn");
      }
      try { await S.bus?.start(); } catch { /* audio needs another gesture */ }
      S.localRec = await startRecording({
        stream: S.masterStream,
        fileName: localFileName(S.name),
        bitsPerSecond: LOCAL_RECORD.bitsPerSecond,
      });
      S.recActive = true;
    } else {
      els.recRowSelf.dataset.state = "idle";
      els.recRowSelf.querySelector(".rec-state").textContent = S.hasMedia
        ? "Not saving — master recording is off"
        : "Nothing to record — no camera or mic";
    }

    S.showActive = true;
    S.recStartedAt = Date.now();
    els.btnRecord.classList.add("on");
    els.btnRecordLabel.textContent = "Stop";
    els.recChipState.textContent = hostSaves ? "Recording" : "Guests recording";
    els.recChip.classList.remove("hidden");
    startRecTimers();
    showDontClose(true);
    updateComposerNeed();

    if (S.net) {
      S.recAcked = new Set(); // guests that can't/won't record ack early
      S.lastBroadcastRun = S.recRun;
      S.net.broadcast({ t: "rec-start", run: S.recRun });
    }
  } catch (err) {
    // A failed recorder start rolls the whole run back (the broadcast above
    // never fired, so guests were never told to record).
    S.localRec = null;
    S.recActive = false;
    S.showActive = false;
    stopRecTimers();
    els.btnRecord.classList.remove("on");
    els.btnRecordLabel.textContent = "Record";
    els.recChip.classList.add("hidden");
    els.recRowSelf.dataset.state = "idle";
    els.recRowSelf.querySelector(".rec-state").textContent = "Idle";
    updateComposerNeed();
    showDontClose(false);
    notify(`Couldn't start recording: ${err.message}`, "danger");
  } finally {
    S.busy = false;
  }
}

async function stopShow() {
  if (S.busy || !S.showActive) return;
  S.busy = true;
  const run = S.recRun;
  const hostSaved = S.recActive;
  try {
    els.btnRecord.disabled = true;
    els.btnRecordLabel.textContent = "Finishing…";

    if (hostSaved && S.localRec) {
      const res = await S.localRec.stop();
      S.localRec = null;
      S.recActive = false;
      S.lastOwnRecording = { run, ...res };
      els.recRowSelf.dataset.state = "done";
      els.recRowSelf.querySelector(".rec-state").textContent = "Saved locally";
      if (res.mode === "memory") {
        notify("Recording kept in memory — downloading the copy now.", "warn");
        downloadBlob(res.blob, res.fileName);
      }
    } else {
      // The host ran the show without a local master — guests that opted in
      // still recorded theirs and their files come back in the sync round.
      els.recRowSelf.querySelector(".rec-state").textContent =
        S.saveMaster && !S.hasMedia ? "Nothing to record" : "Not saving — master recording is off";
    }

    S.showActive = false;
    stopRecTimers();
    els.btnRecord.classList.remove("on");
    els.btnRecordLabel.textContent = "Record";
    els.btnRecord.disabled = false;
    els.recChip.classList.add("hidden");
    updateComposerNeed();

    if (S.net && run) {
      S.net.broadcast({ t: "rec-stop", run });
      // Guests that already acked ("won't record") aren't waited on.
      const guestKeys = [...S.net.guests.keys()].filter((k) => !S.recAcked?.has(k));
      if (guestKeys.length) {
        S.pendingRecAcks = new Set(guestKeys);
        els.recRowSelf.querySelector(".rec-state").textContent = "Waiting for guests…";
        await waitForGuestAcks();
        await startSyncRound(run);
      }
    }
    // Keep the tab-open reminder while a sync round is still streaming.
    if (!S.sync || S.sync.done) showDontClose(false);
    els.recRowSelf.querySelector(".rec-state").textContent =
      hostSaved ? "Saved locally" : "Not saving — master recording is off";
  } catch (err) {
    // A failed finalize must still leave the controls usable and honest
    // (e.g. a full disk or a sink write error at stop time).
    S.showActive = false;
    S.recActive = false;
    S.localRec = null;
    stopRecTimers();
    els.btnRecord.disabled = false;
    els.btnRecordLabel.textContent = "Record";
    els.btnRecord.classList.remove("on");
    els.recChip.classList.add("hidden");
    els.recRowSelf.dataset.state = "idle";
    els.recRowSelf.querySelector(".rec-state").textContent = "Stopped — not saved";
    updateComposerNeed();
    showDontClose(Boolean(S.stageRecActive) || (S.sync && !S.sync.done));
    notify(`Recording had a problem: ${err.message}`, "danger");
  } finally {
    S.busy = false;
  }
}

// Guest-side local master recorder, started by the host's rec-start cue.
// Guests never broadcast; they just record and wait for the host to ask for
// the file after the show stops.
async function startOwnRecording(role, { run } = {}) {
  S.busy = true;
  try {
    try { await S.bus?.start(); } catch { /* audio needs another gesture */ }
    if (run) S.recRun = run;
    else S.recRun = String(Date.now());
    if (!fs.hasDir()) {
      notify(
        "No folder picked — this recording is held in memory. Fine for short shows.",
        "warn",
      );
    }
    S.localRec = await startRecording({
      stream: S.masterStream,
      fileName: localFileName(S.name),
      bitsPerSecond: LOCAL_RECORD.bitsPerSecond,
    });
  } catch (err) {
    notify(`Couldn't start recording: ${err.message}`, "danger");
    S.localRec = null;
    return;
  } finally {
    S.busy = false;
  }

  S.recActive = true;
  S.recStartedAt = Date.now();
  els.btnRecord.classList.add("on");
  els.btnRecordLabel.textContent = "Stop";
  els.recChipState.textContent = "Recording";
  els.recChip.classList.remove("hidden");
  els.recRowSelf.dataset.state = "recording";
  els.recRowSelf.querySelector(".rec-state").textContent = "Recording";
  startRecTimers();
  showDontClose(true);
  updateComposerNeed();
}

async function stopOwnRecording(role, opts = {}) {
  if (!S.localRec) return;
  S.busy = true;
  const run = S.recRun;
  try {
    els.btnRecord.disabled = true;
    els.btnRecordLabel.textContent = "Finishing…";
    const res = await S.localRec.stop();
    S.localRec = null;
    S.recActive = false;
    stopRecTimers();
    els.btnRecord.classList.remove("on");
    els.btnRecordLabel.textContent = "Record";
    els.btnRecord.disabled = false;
    els.recChip.classList.add("hidden");
    els.recRowSelf.dataset.state = "done";
    els.recRowSelf.querySelector(".rec-state").textContent = "Saved locally";
    updateComposerNeed();

    S.lastOwnRecording = { run, ...res };

    // Tell the host it can ask for our file.
    S.net?.sendToHost({
      t: "rec-done",
      run,
      name: res.fileName,
      size: res.blob.size,
    });
    if (res.mode === "memory") {
      notify("Recording kept in memory — it will download after it's sent to the host.", "warn");
    } else {
      notify(`Your master saved to ${res.fileName} ✓`, "success");
    }
    showDontClose(false);
    if (!uploadInProgress && !S.sync) return; // wait for the host to ask
  } catch (err) {
    // A failed finalize must still leave the controls usable and honest
    // (e.g. a full disk or a sink write error at stop time).
    S.recActive = false;
    S.localRec = null;
    stopRecTimers();
    els.btnRecord.disabled = false;
    els.btnRecordLabel.textContent = "Record";
    els.btnRecord.classList.remove("on");
    els.recChip.classList.add("hidden");
    els.recRowSelf.dataset.state = "idle";
    els.recRowSelf.querySelector(".rec-state").textContent = "Stopped — not saved";
    updateComposerNeed();
    showDontClose(false);
    notify(`Recording had a problem: ${err.message}`, "danger");
  } finally {
    S.busy = false;
  }
}

function waitForGuestAcks() {
  const deadline = Date.now() + 6000;
  return new Promise((resolve) => {
    const tick = () => {
      if (S.pendingRecAcks.size === 0 || Date.now() > deadline) resolve();
      else setTimeout(tick, 200);
    };
    tick();
  });
}

async function startSyncRound(run) {
  const keys = [...S.net.guests.keys()];
  if (!keys.length) return;
  S.sync = { run, done: false, doneCount: 0, files: [], rows: new Map() };
  els.syncTitle.textContent = "Syncing guest recordings";
  els.syncList.innerHTML = "";
  els.btnSyncClose.disabled = true;
  els.syncModal.classList.remove("hidden");
  els.syncChip.classList.remove("hidden");
  els.syncNote.textContent =
    "Files stream from each guest's disk over a peer-to-peer data channel. Keep every tab open until the checkmarks appear.";

  for (const key of keys) {
    const guest = S.net.guests.get(key);
    const li = el("li", { class: "sync-row", dataset: { key } },
      el("div", { class: "sync-top" },
        el("span", { class: "sync-name", text: guest?.name || "Guest" }),
        el("span", { class: "sync-status", text: "Waiting…" }),
      ),
      el("div", { class: "bar" }, el("i")),
    );
    els.syncList.append(li);
    const row = {
      li,
      bar: li.querySelector(".bar > i"),
      statusEl: li.querySelector(".sync-status"),
      received: 0,
      size: 0,
      sink: null,
      done: false,
      failed: false,
      blob: null,
    };
    S.sync.rows.set(key, row);
    S.net.sendToGuest(key, { t: "sync-request", run });
  }
  showDontClose(true);
  document.title = "Syncing guest files · WaxWing";
}


// ---- host: Director's Cut ------------------------------------------------

async function toggleStageRec() {
  if (S.busy || S.role !== "host") return;
  if (S.stageRecActive) {
    S.busy = true;
    try {
      const res = await S.stageRec.stop();
      S.stageRec.release?.();
      S.stageRec = null;
      S.stageRecActive = false;
      stopStageTimers();
      els.btnStageRec.classList.remove("on");
      els.stageChip.classList.add("hidden");
      els.recRowStage.dataset.state = "done";
      els.recRowStage.querySelector(".rec-state").textContent = "Saved locally";
      updateComposerNeed();
      if (res.mode === "memory") {
        notify("Stage cut kept in memory — downloading now.", "warn");
        downloadBlob(res.blob, res.fileName);
      }
      showDontClose(S.recActive || (S.sync && !S.sync.done));
    } catch (err) {
      notify(`Stage recording problem: ${err.message}`, "danger");
    } finally {
      S.busy = false;
    }
    return;
  }

  S.busy = true;
  try {
    if (!(await ensureFolder())) return;
    await S.bus?.start();
    els.btnStageRec.classList.add("on");
    els.stageChip.classList.remove("hidden");
    els.recRowStage.dataset.state = "recording";
    els.recRowStage.querySelector(".rec-state").textContent = "Recording";
    S.stageRec = await startStageRecording({
      stageElement: els.stage,
      canvasTrack: S.stage.canvasTrack,
      audioStream: S.bus.masterStream(),
      fileName: stageFileName(),
      onMode: (mode) => {
        S.stageRecMode = mode;
        els.stageTime.textContent = mode === "tab-crop" ? "DOM" : "canvas";
        updateComposerNeed();
      },
    });
    S.stageRecActive = true;
    S.stageRecStartedAt = Date.now();
    startStageTimers();
    showDontClose(true);
    S.net.broadcast({ t: "stage-rec-on" });
  } catch (err) {
    S.stageRec = null;
    S.stageRecActive = false;
    els.btnStageRec.classList.remove("on");
    els.stageChip.classList.add("hidden");
    els.recRowStage.dataset.state = "idle";
    els.recRowStage.querySelector(".rec-state").textContent = "Idle";
    if (err.cancelled) notify("Stage recording cancelled.", "");
    else notify(`Couldn't start the Director's Cut: ${err.message}`, "danger");
  } finally {
    S.busy = false;
  }
}

// ---- timers / composer need / dont-close ----------------------------------

function startRecTimers() {
  updateRecTime();
  S.recTimer = setInterval(updateRecTime, 500);
}
function stopRecTimers() {
  clearInterval(S.recTimer);
  S.recTimer = null;
  document.title = "WaxWing — Local Stream Studio";
}
function updateRecTime() {
  els.recTime.textContent = fmtClock((Date.now() - S.recStartedAt) / 1000);
  // Only claim "REC" in the tab title when THIS device is recording (a host
  // directing a show with saving off keeps the run timer but no local file).
  if (S.recActive) document.title = `● REC ${els.recTime.textContent} · WaxWing`;
}
function startStageTimers() {
  updateStageTime();
  S.stageRecTimer = setInterval(updateStageTime, 500);
}
function stopStageTimers() {
  clearInterval(S.stageRecTimer);
  S.stageRecTimer = null;
}
function updateStageTime() {
  els.stageTime.textContent = fmtClock((Date.now() - S.stageRecStartedAt) / 1000);
}

function updateComposerNeed() {
  if (!S.stage) return;
  const guestsVisible = S.role === "host" && S.net && S.net.guestCount() > 0;
  const stageFallback = S.stageRecActive && S.stageRecMode !== "tab-crop";
  S.stage.requireComposer(Boolean(guestsVisible || stageFallback));
  if (S.role === "host") {
    els.stageEmpty.classList.toggle("hidden", S.net?.guestCount() > 0);
  }
}

function showDontClose(show) {
  els.dontClosePill.classList.toggle("hidden", !show);
  els.dontCloseText.textContent =
    S.recActive || S.showActive
      ? "Recording — keep this tab open"
      : S.stageRecActive
        ? "Recording the stage — keep this tab open"
        : "Syncing files — keep this tab open";
  // Recording hides the rotate nudge — the pill owns the bottom strip.
  updateOrientHint();
}

// ---- guest setup ----------------------------------------------------------

async function setupGuest() {
  els.stageEmpty.classList.add("hidden");
  els.roomChipCode.textContent = S.room;
  els.inviteCode.textContent = S.room;

  // Self-view pip only exists when a camera is actually on.
  if (S.wantVideo) {
    els.guestSelf.classList.remove("hidden");
    els.guestSelfVideo.srcObject = S.masterStream;
  } else {
    els.guestSelf.classList.add("hidden");
  }

  // The stage video fills the 16:9 frame.
  const video = el("video", { class: "stage-video-fill", autoplay: "", playsinline: "" });
  els.stage.append(video);
  S.guestStageVideo = video;

  setPill("busy", "Connecting to host…");
  S.net = new Network({ displayName: S.name, onEvent: guestEvents });
  S.net.prefs = { video: S.wantVideo, audio: S.wantAudio, save: S.saveMaster };
  try {
    await S.net.join({ roomCode: S.room });
    // Uplink = downscaled proxy video (if the camera is on) + mic (if on).
    // A guest with everything off sends no media call — just the data
    // channel — and appears on the host's stage as a name tile.
    const outStream = new MediaStream();
    if (S.proxyVideoTrack) outStream.addTrack(S.proxyVideoTrack);
    for (const t of S.masterStream.getAudioTracks()) outStream.addTrack(t);
    S.net.dialHost(outStream);
  } catch (err) {
    if (err?.type === "peer-unavailable") {
      showFatal("No studio found", `There's no live studio at room ${S.room}. Double-check the link.`);
    } else {
      showFatal("Couldn't connect", err.message);
    }
  }
}

function guestEvents(e) {
  switch (e.type) {
    case "peer-state":
      if (e.state === "online") setPill("busy", "Connecting…");
      else if (e.state === "disconnected" || e.state === "error") {
        setPill("busy", "Reconnecting…");
        try { S.net?.peer?.reconnect(); } catch { /* ignore */ }
      } else if (e.state === "closed" && !S.busy) {
        hostWentAway("The connection to the studio closed.");
      }
      break;
    case "dc-open":
      setPill("busy", "Linked to host — waiting for the stage…");
      break;
    case "stage-media":
      if (!S.guestStageVideo) break;
      S.guestStageVideo.srcObject = e.stream;
      S.stageLive = true;
      setPill("live", "On air");
      tryUnmuteStage();
      updateOrientHint();
      break;
    case "data":
      guestOnData(e.msg);
      break;
    case "host-dc-closed":
      hostWentAway("The host closed the studio.");
      break;
    case "fatal":
      if (e.code === "host-gone") hostWentAway("The host's studio is no longer reachable.");
      else showFatal("Connection problem", e.message);
      break;
  }
}

function guestOnData(msg) {
  if (!msg || typeof msg !== "object") return;
  switch (msg.t) {
    case "rec-start":
      if (S.recActive) break;
      S.recRun = msg.run;
      // The host started a run — each guest decides for themselves whether
      // a local master exists. Skip instantly (and tell the host so it
      // stops waiting) when the guest opted out of saving, has no media to
      // record, or is on a browser that can't mux video.
      if (!S.saveMaster || !S.hasMedia) {
        S.net?.sendToHost({ t: "rec-done", run: msg.run, name: "", size: 0 });
        break;
      }
      if (!canRecordVideo()) {
        // iOS Safari can't mux video with MediaRecorder. Stay live on the
        // stage and tell the host there's nothing to sync, so it doesn't
        // wait for a file that will never come.
        notify("Your browser can't record video locally — you're still live on the stage.", "warn");
        S.net?.sendToHost({ t: "rec-done", run: msg.run, name: "", size: 0 });
        break;
      }
      startOwnRecording("guest", { run: msg.run });
      break;
    case "rec-stop":
      if (S.recActive) stopOwnRecording("guest");
      break;
    case "sync-request":
      sendOwnRecording(msg.run);
      break;
    case "show-full":
      showFatal("Studio is full", "This studio already has a host and 3 guests. Ask the host for a new room.");
      break;
    case "stage-rec-on":
      break;
  }
}

function hostWentAway(why) {
  S.stageLive = false;
  updateOrientHint();
  // The host is gone — nothing can see the share anymore, so end it.
  if (S.shareActive || S.screenStream) stopShare(true);
  const wasRecording = S.recActive;
  if (wasRecording) {
    stopOwnRecording("guest", { silent: true }).then(() => {
      showFatal("Show ended", `${why} Your local recording was saved before the link dropped.`);
    });
  } else {
    showFatal("Show ended", why);
  }
}

async function sendOwnRecording(run) {
  const rec = S.lastOwnRecording;
  if (!rec || rec.synced || run !== rec.run) {
    // Nothing new to send.
    if (!rec || run !== rec.run) {
      S.net?.sendToHost({ t: "sync-start", run, name: "", size: 0 });
    }
    return;
  }
  rec.synced = true;

  els.syncTitle.textContent = "Sending your recording to the host";
  els.syncList.innerHTML = "";
  els.btnSyncClose.disabled = true;
  els.syncModal.classList.remove("hidden");
  els.syncNote.textContent =
    "Your high-res master is traveling peer-to-peer over an encrypted data channel. Don't close this tab.";
  const li = el("li", { class: "sync-row" },
    el("div", { class: "sync-top" },
      el("span", { class: "sync-name", text: rec.fileName }),
      el("span", { class: "sync-status", text: "Starting…" }),
    ),
    el("div", { class: "bar" }, el("i")),
  );
  els.syncList.append(li);
  const bar = li.querySelector(".bar > i");
  const status = li.querySelector(".sync-status");

  uploadInProgress = true;
  els.syncChip.classList.remove("hidden");
  showDontClose(true);
  try {
    S.net?.sendToHost({ t: "sync-start", run, name: rec.fileName, size: rec.blob.size });
    await uploadBlob({
      send: (b) => S.net.sendBinaryToHost(b),
      buffered: () => S.net.hostBufferedAmount(),
      waitLow: () => S.net.waitHostLowWater(),
      blob: rec.blob,
      onProgress: ({ sent, size }) => {
        const pct = size ? (sent / size) * 100 : 100;
        bar.style.width = `${pct}%`;
        status.textContent = `${fmtBytes(sent)} / ${fmtBytes(size)}`;
      },
    });
    S.net?.sendToHost({ t: "sync-end", run });
    li.classList.add("done");
    bar.style.width = "100%";
    status.textContent = `Sent to host ✓`;
    if (rec.mode === "memory") {
      downloadBlob(rec.blob, rec.fileName);
      status.textContent = `Sent ✓ (memory copy downloaded)`;
    }
    S.lastOwnRecording = null;
    notify("Your local recording is with the host.", "success");
  } catch (err) {
    li.classList.add("fail");
    status.textContent = "Upload interrupted";
    rec.synced = false;
    notify(`Sending failed: ${err.message}`, "danger");
  } finally {
    uploadInProgress = false;
    els.syncChip.classList.add("hidden");
    els.btnSyncClose.disabled = false;
    showDontClose(false);
  }
}

async function tryUnmuteStage() {
  const v = S.guestStageVideo;
  try {
    await v.play();
    v.muted = false;
  } catch {
    els.stageAudioHint.classList.remove("hidden");
  }
}

// ---- exit / fatal ---------------------------------------------------------

async function handleExit() {
  if (S.busy) return;
  const role = S.role;
  const warning =
    role === "host"
      ? S.showActive
        ? "You're in a recording run. End the show anyway? Guests' own files are saved on their side."
        : "End the show? All guests will be disconnected."
      : S.recActive
        ? "You're recording locally. Leave anyway? Your file is saved first."
        : "Leave the studio?";
  if (!confirm(warning)) return;

  if (role === "host") {
    if (S.showActive) {
      // Graceful: guests hear "host ending", the run closes (their own
      // recorders finalize their files), then this tab reloads.
      S.net?.broadcast({ t: "host-ending", run: S.recRun });
      await stopShow();
    } else {
      S.net?.broadcast({ t: "host-ending" });
    }
    if (S.stageRecActive) {
      try { await S.stageRec.stop(); S.stageRec.release?.(); } catch { /* ignore */ }
    }
  } else if (S.recActive) {
    // Don't abandon the local master on leave — finalize it so the file is
    // saved (and the host is told) before this tab goes away.
    await stopOwnRecording("guest", { silent: true });
  }
  teardownAndReload();
}

function teardownAndReload() {
  try { S.net?.destroy(); } catch { /* ignore */ }
  cleanupMedia();
  stopPreview();
  location.reload();
}

function showFatal(title, message) {
  els.fatalTitle.textContent = title;
  els.fatalMessage.textContent = message;
  els.fatalPanel.classList.remove("hidden");
}

// ---- go ----------------------------------------------------------------

// Module scripts run before DOMContentLoaded, but the callbacks registered
// below only touch elements that already exist (script sits at end of body).
boot();
