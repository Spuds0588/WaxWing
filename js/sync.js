// Post-show P2P file sync (PRD Phase 5).
//
// When the host stops the show each guest streams the high-res local master
// back over the RTC data channel in 16KB chunks while a progress bar keeps
// everyone honest about not closing the tab.

import { SYNC } from "./config.js";

/**
 * Send a Blob/File to the host in 16KB chunks with backpressure.
 *
 * @param {object} opts
 * @param {(bytes: Uint8Array) => void} opts.send       raw chunk sender
 * @param {() => number} opts.buffered                  current dc bufferedAmount
 * @param {() => Promise<void>} opts.waitLow            resolves when buffer drains
 * @param {Blob | File} opts.blob
 * @param {(p: { sent: number, size: number }) => void} [opts.onProgress]
 */
export async function uploadBlob({ send, buffered, waitLow, blob, onProgress }) {
  const size = blob.size;
  const { chunkSize, highWaterMark } = SYNC;
  let sent = 0;

  while (sent < size) {
    const end = Math.min(size, sent + chunkSize);
    const part = blob.slice(sent, end);
    const bytes = new Uint8Array(await part.arrayBuffer());
    send(bytes);
    sent = end;
    onProgress?.({ sent, size });
    // Keep a ceiling on the pending buffer so a big file doesn't blow RAM:
    // pause sending whenever the data channel is backed up.
    if (buffered() > highWaterMark) await waitLow();
  }
  return sent;
}
