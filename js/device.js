// Media capture helpers.
//
// The PRD's "proxy" recording logic:
//   1. getUserMedia asks for the maximum resolution (up to 4K).
//   2. The stream is cloned.
//   3. The clone is constrained to ~720p/1080p and that *proxy* travels
//      over WebRTC; the original master track is recorded locally.

import { MASTER_LADDER, PROXY, SCREEN, STORAGE_KEYS } from "./config.js";

export async function listDevices() {
  const all = await navigator.mediaDevices.enumerateDevices();
  const cams = all.filter((d) => d.kind === "videoinput");
  const mics = all.filter((d) => d.kind === "audioinput");
  return { cams, mics };
}

function videoConstraintsFor(camId, ladder) {
  return {
    deviceId: camId ? { exact: camId } : undefined,
    width: { ideal: ladder.width },
    height: { ideal: ladder.height },
    frameRate: { ideal: 30 },
  };
}

function audioConstraints(micId) {
  return {
    deviceId: micId ? { exact: micId } : undefined,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
}

/**
 * Opens the participant's local master stream for the media they enabled:
 *   wantVideo+wantAudio -> the 4K->720p ladder (the "proxy" master)
 *   wantVideo only      -> same ladder, no mic
 *   wantAudio only      -> mic at default quality
 *   neither             -> an empty stream (listener-only participant)
 */
export async function openMasterStream({ camId, micId, onAttempt, wantVideo = true, wantAudio = true }) {
  if (!wantVideo && !wantAudio) {
    return { stream: new MediaStream(), quality: "none", ladder: "none" };
  }
  // wantAudio-only tries once with no ladder; wantVideo walks 4K->720p.
  const ladder = wantVideo ? MASTER_LADDER : [{ width: 0, height: 0, label: "audio" }];
  let lastError = null;
  for (const step of ladder) {
    try {
      if (onAttempt && step.label !== "audio") onAttempt(step);
      const stream = await navigator.mediaDevices.getUserMedia({
        video: wantVideo ? videoConstraintsFor(camId, step) : false,
        audio: wantAudio ? audioConstraints(micId) : false,
      });
      const video = stream.getVideoTracks()[0];
      const settings = video?.getSettings() || {};
      const label = settings.width ? `${settings.width}×${settings.height}` : step.label;
      return { stream, quality: label, ladder: step.label };
    } catch (err) {
      lastError = err;
    }
  }
  const what =
    wantVideo && wantAudio
      ? "your camera and microphone"
      : wantVideo
        ? "your camera"
        : "your microphone";
  const err = new Error(
    `Could not open ${what}. Check that it's plugged in and that this site has ` +
      "camera/microphone permission.",
  );
  err.cause = lastError;
  throw err;
}

// Downscale a clone of the master video track for the live P2P link.
export function makeProxyVideoTrack(masterStream) {
  const masterTrack = masterStream.getVideoTracks()[0];
  if (!masterTrack) return null;
  const clone = masterTrack.clone();
  clone.applyConstraints(PROXY.video).catch(() => {});
  return clone;
}

// ---- screen sharing ------------------------------------------------------

// getDisplayMedia drives a native picker (tab / window / screen). It is not
// available everywhere yet — notably iOS Safari — so callers should check
// screenShareSupported() and hide the control rather than fail at click.
export function screenShareSupported() {
  return (
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getDisplayMedia)
  );
}

/**
 * Opens the OS screen/window/tab picker. audio:true offers tab audio when
 * the user picks a tab that has it (Chrome shows the checkbox); captures of
 * a full screen or a window simply carry no audio track, which is fine.
 * Cancels surface as an Error with .cancelled === true (NotAllowedError /
 * AbortError), so the UI can silently revert instead of alarming.
 */
export async function openScreenShare() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: SCREEN.video,
      audio: true,
    });
  } catch (err) {
    if (err?.name === "NotAllowedError" || err?.name === "AbortError") {
      const e = new Error("Screen share cancelled.");
      e.cancelled = true;
      e.cause = err;
      throw e;
    }
    throw err;
  }
  return stream;
}

// A screen share travels as its own video stream (separate from the camera
// proxy), downscaled for the link like the camera proxy is.
export function makeScreenProxyTrack(stream) {
  const track = stream?.getVideoTracks()[0];
  if (!track) return null;
  const clone = track.clone();
  clone.applyConstraints(SCREEN.proxy).catch(() => {});
  return clone;
}

export function rememberDeviceIds(camId, micId) {
  try {
    if (camId) localStorage.setItem(STORAGE_KEYS.cam, camId);
    if (micId) localStorage.setItem(STORAGE_KEYS.mic, micId);
  } catch {
    /* private mode */
  }
}

export function savedDeviceIds() {
  try {
    return {
      cam: localStorage.getItem(STORAGE_KEYS.cam) || "",
      mic: localStorage.getItem(STORAGE_KEYS.mic) || "",
    };
  } catch {
    return { cam: "", mic: "" };
  }
}

export async function stopStream(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}
