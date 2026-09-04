// Media capture helpers.
//
// The PRD's "proxy" recording logic:
//   1. getUserMedia asks for the maximum resolution (up to 4K).
//   2. The stream is cloned.
//   3. The clone is constrained to ~720p/1080p and that *proxy* travels
//      over WebRTC; the original master track is recorded locally.

import { MASTER_LADDER, PROXY, STORAGE_KEYS } from "./config.js";

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
