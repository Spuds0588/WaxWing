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

function constraintsFor(camId, micId, ladder) {
  return {
    video: {
      deviceId: camId ? { exact: camId } : undefined,
      width: { ideal: ladder.width },
      height: { ideal: ladder.height },
      frameRate: { ideal: 30 },
    },
    audio: {
      deviceId: micId ? { exact: micId } : undefined,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  };
}

// Walk the quality ladder: try 4K first, degrade gracefully down to 720p.
export async function openMasterStream({ camId, micId, onAttempt }) {
  let lastError = null;
  for (const ladder of MASTER_LADDER) {
    try {
      if (onAttempt) onAttempt(ladder);
      const stream = await navigator.mediaDevices.getUserMedia(
        constraintsFor(camId, micId, ladder),
      );
      const video = stream.getVideoTracks()[0];
      const settings = video?.getSettings() || {};
      const label = settings.width ? `${settings.width}×${settings.height}` : ladder.label;
      return { stream, quality: label, ladder: ladder.label };
    } catch (err) {
      lastError = err;
    }
  }
  const err = new Error(
    "Could not open your camera and microphone. Check that they are plugged in " +
      "and that this site has camera/microphone permission.",
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
