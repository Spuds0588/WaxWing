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
  savedDeviceIds,
  rememberDeviceIds,
  stopStream,
} from "./device.js";
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
  "hostControls", "btnResetLayout", "btnStageRec", "btnRecord", "btnRecordLabel",
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
  "orientHint",
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
  masterStream: null,
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
      `You're joining studio ${S.room}. You'll watch the host's stage live, while your ` +
      `own camera records locally on your machine at full quality — nothing you record ` +
      `travels over the internet until you choose to send it.`;
    els.btnEnterLabel.textContent = "Join live studio";
  } else {
    els.roleBlurb.textContent =
      "You're the host. Guests connect straight to your browser over WebRTC — no accounts, no servers. " +
      "Pick a name, choose your gear, and share the room code once you're on stage.";
    els.btnEnterLabel.textContent = "Enter the studio";
  }

  renderCaps();
  els.recModeLabel.textContent = pickMimeType() || "unavailable";

  // Wire static UI.
  els.btnEnter.addEventListener("click", handleEnter);
  els.btnRefreshDevices.addEventListener("click", () => populateDeviceSelects().then(startCameraPreview));
  els.camSelect.addEventListener("change", startCameraPreview);
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
    if (S.recActive || S.stageRecActive || (S.sync && !S.sync.done) || uploadInProgress) {
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
  } else {
    navigator.mediaDevices
      ?.getUserMedia({ audio: true, video: true })
      .then(async (st) => {
        st.getTracks().forEach((t) => t.stop());
        await populateDeviceSelects();
        startCameraPreview();
      })
      .catch(async () => {
        await populateDeviceSelects();
        startCameraPreview();
      });
  }

  updateFolderLabel();
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
  S.busy = true;
  setEnterState("Starting cameras…", true);

  try {
    const camId = els.camSelect.value;
    const micId = els.micSelect.value;
    const { stream, quality } = await openMasterStream({
      camId,
      micId,
      onAttempt: (ladder) => setEnterState(`Requesting ${ladder.label} camera…`, true),
    });
    rememberDeviceIds(camId, micId);
    S.masterStream = stream;
    S.quality = quality;
    S.proxyVideoTrack = S.role === "guest" ? makeProxyVideoTrack(stream) : null;

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

    els.qualityNote.textContent =
      `Local capture ${quality} · P2P link 1280×720 · ${pickMimeType() || "webm"}`;
    if (S.role === "host") {
      els.capQualityLabel.textContent = quality;
      els.sidebar.classList.remove("hidden");
      els.btnExitLabel.textContent = "End show";
    } else {
      els.btnResetLayout.hidden = true;
      els.btnStageRec.hidden = true;
      els.btnRecord.hidden = true;
      els.btnExitLabel.textContent = "Leave";
    }
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
      S.stage.addParticipant({ key: "self", label: S.name, isSelf: true });
      S.stage.setStream("self", S.masterStream);
    }

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
      S.stage.addParticipant({ key: e.key, label: e.name });
      makeGuestRow(e.key, e.name);
      S.bus.ensureGuestBus(e.key);
      setGuestCountUI();
      updateComposerNeed();
      // Late joiners during a show start recording right away.
      if (S.recActive) S.net.sendToGuest(e.key, { t: "rec-start", run: S.recRun });
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
    case "guest-remove":
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

function hostOnData(key, msg) {
  if (!msg || typeof msg !== "object") return;
  switch (msg.t) {
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
  if (S.busy) return;
  if (S.recActive) await stopOwnRecording("host");
  else await startOwnRecording("host");
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

async function startOwnRecording(role, { run } = {}) {
  S.busy = true;
  try {
    if (role === "host") {
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
    }
    try {
      await S.bus?.start();
    } catch { /* audio needs another gesture; recording still works */ }

    if (!run) S.recRun = String(Date.now());
    else S.recRun = run;
    if (role === "guest" && !fs.hasDir()) {
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
  els.recChip.classList.remove("hidden");
  els.recRowSelf.dataset.state = "recording";
  els.recRowSelf.querySelector(".rec-state").textContent = "Recording";
  startRecTimers();
  showDontClose(true);
  updateComposerNeed();

  if (role === "host" && S.net) {
    S.lastBroadcastRun = S.recRun;
    S.recAcked = new Set(); // guests that already told us they can't record
    S.net.broadcast({ t: "rec-start", run: S.recRun });
  }
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

    if (role === "guest") {
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
      return;
    }

    // Host role: broadcast stop, wait for guests to finish, then sync.
    if (S.net && run) {
      S.net.broadcast({ t: "rec-stop", run });
      // Guests that already acked ("finished" or "can't record") aren't waited on.
      const guestKeys = [...S.net.guests.keys()].filter((k) => !S.recAcked?.has(k));
      if (guestKeys.length) {
        S.pendingRecAcks = new Set(guestKeys);
        els.recRowSelf.querySelector(".rec-state").textContent = "Waiting for guests…";
        await waitForGuestAcks();
        await startSyncRound(run);
      }
    }
    if (res.mode === "memory") {
      notify("Recording kept in memory — downloading the copy now.", "warn");
      downloadBlob(res.blob, res.fileName);
    }
    // Keep the tab-open reminder while a sync round is still streaming.
    if (!S.sync || S.sync.done) showDontClose(false);
    els.recRowSelf.querySelector(".rec-state").textContent = "Saved locally";
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
    showDontClose(Boolean(S.stageRecActive) || (S.sync && !S.sync.done));
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
  document.title = `● REC ${els.recTime.textContent} · WaxWing`;
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
  els.dontCloseText.textContent = S.recActive
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

  // Self-view pip.
  els.guestSelf.classList.remove("hidden");
  els.guestSelfVideo.srcObject = S.masterStream;

  // The stage video fills the 16:9 frame.
  const video = el("video", { class: "stage-video-fill", autoplay: "", playsinline: "" });
  els.stage.append(video);
  S.guestStageVideo = video;

  setPill("busy", "Connecting to host…");
  S.net = new Network({ displayName: S.name, onEvent: guestEvents });
  try {
    await S.net.join({ roomCode: S.room });
    const outStream = S.proxyVideoTrack
      ? new MediaStream([S.proxyVideoTrack, ...S.masterStream.getAudioTracks()])
      : S.masterStream;
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
      ? S.recActive
        ? "You're recording. End the show anyway? Guests' local files will be saved on their side."
        : "End the show? All guests will be disconnected."
      : "Leave the studio?";
  if (!confirm(warning)) return;

  if (S.recActive) {
    if (role === "host") {
      // Graceful: stop local, broadcast stop + sync quickly, then reload.
      S.net?.broadcast({ t: "host-ending", run: S.recRun });
      await stopOwnRecording("host");
    } else {
      if (S.recActive) {
        // Don't abandon the local master on leave — finalize it so the file
        // is saved (and the host is told) before this tab goes away.
        await stopOwnRecording("guest", { silent: true });
      } else {
        S.net?.sendToHost({ t: "rec-done", run: S.recRun, name: "", size: 0 });
      }
    }
  } else if (role === "host") {
    S.net?.broadcast({ t: "host-ending" });
  }
  if (S.stageRecActive && role === "host") {
    try { await S.stageRec.stop(); S.stageRec.release?.(); } catch { /* ignore */ }
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
