// File System Access API wrapper (PRD §2.3 / Phase 4).
//
// Chrome/Edge on desktop only: recordings are streamed straight to a folder
// the user picks, so hour-long 4K shows never live in RAM. Anywhere the
// API is missing we degrade to an in-memory Blob sink (with loud warnings),
// which is what the PRD specifies as the Safari/Firefox fallback.

import { STORAGE_KEYS } from "./config.js";
import { notify } from "./util.js";

export const fsSupported = typeof window !== "undefined" && "showDirectoryPicker" in window;

const state = { dirHandle: null };

export function hasDir() {
  return state.dirHandle !== null;
}

export function dirName() {
  return state.dirHandle?.name || null;
}

export async function permissionStatus(handle, mode = "readwrite") {
  try {
    if (!handle) return "denied";
    return await handle.queryPermission({ mode });
  } catch {
    return "prompt";
  }
}

async function requestPermission(handle, mode = "readwrite") {
  try {
    return await handle.requestPermission({ mode });
  } catch {
    return "denied";
  }
}

// Show the picker (must be called from a user gesture) and store the choice.
export async function chooseDefaultDir({ quiet = false } = {}) {
  if (!fsSupported) {
    notify(
      "This browser can't write straight to disk — recordings will be kept in memory and downloaded when they stop.",
      "danger",
      8000,
    );
    return null;
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite", startIn: "videos" });
    const perm = await requestPermission(handle);
    if (perm !== "granted") {
      notify("Folder permission was not granted.", "danger");
      return null;
    }
    state.dirHandle = handle;
    try {
      localStorage.setItem(STORAGE_KEYS.folder, handle.name);
    } catch {
      /* ignore */
    }
    if (!quiet) notify(`Recording folder: ${handle.name}`);
    return handle;
  } catch (err) {
    if (err?.name !== "AbortError") notify(`Could not open folder: ${err.message}`, "danger");
    return null;
  }
}

// Can we write to the chosen folder right now (possibly re-requesting
// permission)? `hasGesture` tells us whether a prompt is even allowed.
export async function ensureDirUsable({ hasGesture }) {
  if (!state.dirHandle) return false;
  const status = await permissionStatus(state.dirHandle);
  if (status === "granted") return true;
  if (status === "prompt" && hasGesture) {
    const perm = await requestPermission(state.dirHandle);
    return perm === "granted";
  }
  return false;
}

async function openWritable(fileName) {
  const handle = await state.dirHandle.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable();
  return { handle, writable };
}

/**
 * A recording sink writes MediaRecorder chunks somewhere durable.
 * mode === "fs"      -> FileSystemWritableFileStream (direct to SSD)
 * mode === "memory"  -> Blob parts in RAM (fallback)
 *
 * close() resolves with { blob, fileName, mode } where blob is a File
 * (fs mode) or Blob (memory) that can be sliced for P2P sync.
 */
export async function createRecordingSink(fileName) {
  if (fsSupported && state.dirHandle && (await ensureDirUsable({ hasGesture: false }))) {
    const { handle, writable } = await openWritable(fileName);
    let pending = Promise.resolve();
    return {
      mode: "fs",
      fileName,
      write(chunk) {
        pending = pending.then(() => writable.write(chunk));
        return pending;
      },
      async close() {
        await pending;
        await writable.close();
        const file = await handle.getFile();
        return { blob: file, fileName, mode: "fs", dirName: state.dirHandle.name };
      },
    };
  }
  const parts = [];
  return {
    mode: "memory",
    fileName,
    write(chunk) {
      parts.push(chunk);
      return Promise.resolve();
    },
    async close() {
      const blob = new Blob(parts, { type: "video/webm" });
      return { blob, fileName, mode: "memory", dirName: null };
    },
  };
}

// Host-side sink for files a guest streams over after the show.
export async function openGuestBackupSink(fileName) {
  return createRecordingSink(fileName);
}
