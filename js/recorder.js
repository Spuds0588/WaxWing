// Recording engine (PRD Phase 4).
//
// * Local masters: MediaRecorder on the raw getUserMedia stream, chunks
//   flushed to disk ~every second via the File System Access sink.
// * Director's Cut (host only): Region Capture (CropTarget.fromElement +
//   track.cropTo) on a tab capture of the stage, falling back to the live
//   stage-composer canvas when CropTarget isn't available yet.

import { LOCAL_RECORD, STAGE } from "./config.js";
import { fileStamp, safeName } from "./util.js";
import { createRecordingSink } from "./fs.js";

const CANDIDATES = [
  'video/webm;codecs="vp9,opus"',
  'video/webm;codecs="vp8,opus"',
  "video/webm",
];

export function pickMimeType() {
  if (typeof MediaRecorder === "undefined") return null;
  for (const mime of CANDIDATES) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return "";
}

// True when the browser can actually mux a video recording. iOS Safari
// exposes MediaRecorder but supports no video container, so local HD
// recording silently degrades to "guest joins, nothing recorded".
export function canRecordVideo() {
  return Boolean(pickMimeType());
}

export const recorderSupported = typeof MediaRecorder !== "undefined";
export const cropSupported =
  typeof window !== "undefined" &&
  typeof CropTarget !== "undefined" &&
  typeof MediaStreamTrack !== "undefined" &&
  typeof MediaStreamTrack.prototype.cropTo === "function";

/**
 * Records `stream` to a durable sink. start() returns a controller with
 * stop() -> Promise<{ blob, fileName, mode, dirName }>.
 */
export async function startRecording({ stream, fileName, bitsPerSecond }) {
  const mimeType = pickMimeType();
  if (!recorderSupported || !mimeType) {
    throw new Error("MediaRecorder is not available in this browser.");
  }
  const sink = await createRecordingSink(fileName);
  const options = { mimeType };
  if (bitsPerSecond) options.videoBitsPerSecond = bitsPerSecond;

  const recorder = new MediaRecorder(stream, options);
  let writing = Promise.resolve();
  let stopResolve = null;
  let failed = null;
  const stopped = new Promise((r) => (stopResolve = r));

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) {
      writing = writing.then(() => sink.write(e.data)).catch((err) => (failed = err));
    }
  };
  recorder.onerror = (e) => {
    failed = e.error || new Error("MediaRecorder error");
    stopResolve();
  };
  recorder.onstop = () => stopResolve();

  try {
    recorder.start(LOCAL_RECORD.timesliceMs);
  } catch (err) {
    await sink.close();
    throw err;
  }

  return {
    state: "recording",
    stop: async () => {
      if (recorder.state !== "inactive") recorder.stop();
      await stopped;
      await writing.catch(() => {});
      if (failed) throw failed;
      return sink.close();
    },
    cancel: async () => {
      if (recorder.state !== "inactive") {
        recorder.ondataavailable = null;
        recorder.stop();
      }
      await stopped;
      await sink.close();
    },
  };
}

export function localFileName(displayName, stamp = new Date()) {
  return `${safeName(displayName)}-local-${fileStamp(stamp)}.webm`;
}

export function stageFileName(stamp = new Date()) {
  return `Stage-DirectorsCut-${fileStamp(stamp)}.webm`;
}

/**
 * Host "Director's Cut": records just the .stage container.
 * Primary path: Region Capture of the live tab (real DOM, 1080p).
 * Fallback: the stage composer canvas stream (same pixels, baked names).
 */
export async function startStageRecording({ stageElement, canvasTrack, audioStream, fileName, onMode }) {
  const videoBitsPerSecond = STAGE.bitsPerSecond;
  let sourceStream;

  if (cropSupported) {
    let displayStream = null;
    try {
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          displaySurface: "browser",
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 },
        },
        audio: false,
      });
      const videoTrack = displayStream.getVideoTracks()[0];
      const cropTarget = await CropTarget.fromElement(stageElement);
      await videoTrack.cropTo(cropTarget);
      const audioTracks = audioStream ? audioStream.getAudioTracks() : [];
      sourceStream = new MediaStream([videoTrack, ...audioTracks]);
      if (onMode) onMode("tab-crop");
    } catch (err) {
      // End the share if the crop failed (e.g. the user picked another tab).
      displayStream?.getTracks().forEach((t) => t.stop());
      if (err?.name === "NotAllowedError" || err?.name === "AbortError") {
        const e = new Error("Stage recording was cancelled.");
        e.cancelled = true;
        throw e;
      }
      // CropTarget exists but the capture failed — drop to canvas mode.
      sourceStream = null;
    }
  }

  if (!sourceStream) {
    if (!canvasTrack) {
      const e = new Error("No capture source available for the Director's Cut.");
      e.cancelled = true;
      throw e;
    }
    const audioTracks = audioStream ? audioStream.getAudioTracks() : [];
    sourceStream = new MediaStream([canvasTrack, ...audioTracks]);
    if (onMode) onMode("canvas");
  }

  const controller = await startRecording({
    stream: sourceStream,
    fileName,
    bitsPerSecond: videoBitsPerSecond,
  });

  // Keep the "stop sharing" affordance sane: stopping the recording also
  // ends the tab share (DOM-mode shares are otherwise ended by the browser
  // chrome when the user clicks "Stop sharing").
  const extraTracks = sourceStream
    .getVideoTracks()
    .filter((t) => t.getSettings().displaySurface);

  return {
    ...controller,
    get capturedTab() {
      return extraTracks.length > 0;
    },
    release() {
      extraTracks.forEach((t) => t.stop());
    },
  };
}
