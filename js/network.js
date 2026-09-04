// Networking (PRD Phase 2 — "we are building a browser-based SFU").
//
// Star topology: guests connect ONLY to the host.
//   Guest -> Host : one MediaCall carrying the guest's downscaled proxy AV
//                   + one DataConnection (control / post-show file sync).
//   Host -> Guest : a per-guest MediaCall carrying the live composited
//                   stage (canvas video + mixed audio minus that guest).
//
// Signaling rides PeerJS's free public cloud (no backend to run).
//
// Data channel framing: protocol messages are JSON strings; file chunks are
// raw binary (Uint8Array). Receivers set binaryType = "arraybuffer".

import Peer from "peerjs";

// Re-exported for convenience; the implementation lives in util.js so it
// can be unit-tested without pulling in the PeerJS browser runtime.
export { randomRoomCode } from "./util.js";

const isBinary = (data) =>
  data instanceof ArrayBuffer || ArrayBuffer.isView(data) || data instanceof Blob;

export class Network {
  /**
   * @param {object} opts
   * @param {string} opts.displayName
   * @param {(event: object) => void} opts.onEvent
   */
  constructor({ displayName, onEvent }) {
    this.displayName = displayName;
    this.onEvent = onEvent;
    this.role = null; // "host" | "guest"
    this.room = null;
    this.peer = null;
    this.hostDc = null; // guest side
    this.guests = new Map(); // host side: peerId -> { key, name, dc, inCall, outStageCall }
    this.stageStreamFor = null; // host: (guestKey) => MediaStream
    this.destroyed = false;
  }

  emit(event) {
    if (!this.destroyed) this.onEvent(event);
  }

  // ---- lifecycle -------------------------------------------------------

  async host({ roomCode }) {
    this.role = "host";
    this.room = roomCode;
    await this.initPeer(roomCode);
  }

  async join({ roomCode }) {
    this.role = "guest";
    this.room = roomCode;
    await this.initPeer(); // random id
    // initPeer() resolves from the same single 'open' event PeerJS emits, so
    // by the time we resume the peer may already be open — only wait for a
    // fresh event if it isn't.
    if (this.peer.id) return;
    await new Promise((resolve) => {
      const tryOpen = () => {
        this.peer.off("open", tryOpen);
        resolve();
      };
      this.peer.on("open", tryOpen);
    });
  }

  initPeer(id) {
    return new Promise((resolve, reject) => {
      // Signaling defaults to PeerJS's free public cloud. Tests (see
      // scripts/smoke-2tab.mjs) may point at a local signaling server by
      // injecting window.__WW_PEER__ = { host, port, path, secure } before
      // this module loads.
      const override = (typeof window !== "undefined" && window.__WW_PEER__) || {};
      const peer = new Peer(id, { debug: 0, ...override });
      this.peer = peer;

      peer.on("open", () => {
        this.emit({ type: "peer-state", state: "online", id: peer.id });
        resolve();
      });
      peer.on("disconnected", () => {
        this.emit({ type: "peer-state", state: "disconnected" });
      });
      peer.on("close", () => {
        this.emit({ type: "peer-state", state: "closed" });
      });
      peer.on("error", (err) => {
        const code = err?.type || "network";
        if (code === "unavailable-id" || code === "unavailable") {
          this.emit({ type: "fatal", code: "room-taken", message: "That room code is already in use." });
        } else if (code === "peer-unavailable") {
          // Host: a guest dropped before its data channel closed — the dc
          // close event removes it. Guest: the host room is gone.
          if (this.role === "guest") {
            this.emit({ type: "fatal", code: "host-gone", message: "The host room is no longer available." });
          }
        } else if (code === "network" || code === "server-error" || code === "socket-error") {
          this.emit({ type: "peer-state", state: "error", detail: err.message });
        } else if (this.role === "guest" || this.role === null) {
          this.emit({ type: "fatal", code, message: err.message || "Connection error." });
        }
        // Surface the original error (with .type/.code preserved) so
        // callers awaiting host()/join() can branch on it.
        const wrapped = err instanceof Error ? err : new Error(String(err?.message || code));
        if (!wrapped.code) wrapped.code = code;
        if (!wrapped.type) wrapped.type = code;
        reject(wrapped);
      });

      // Incoming data connections + media calls must be handled for BOTH roles:
      //   host:  receives guest dc + guest proxy media call
      //   guest: receives host's stage call (and any dc the host opens)
      peer.on("connection", (dc) => this.onDataConnection(dc));
      peer.on("call", (call) => this.onIncomingCall(call));
    });
  }

  // ---- host: guest bookkeeping -----------------------------------------

  ensureGuest(peerId, meta = {}) {
    let guest = this.guests.get(peerId);
    if (!guest) {
      guest = { key: peerId, name: meta.name || "Guest", dc: null, inCall: null, outStageCall: null };
      this.guests.set(peerId, guest);
      this.emit({ type: "guest-add", key: peerId, name: guest.name });
    } else if (meta.name && guest.name === "Guest") {
      guest.name = meta.name;
      this.emit({ type: "guest-meta", key: peerId, name: guest.name });
    }
    return guest;
  }

  forgetGuest(peerId) {
    const guest = this.guests.get(peerId);
    if (!guest) return;
    this.guests.delete(peerId);
    this.emit({ type: "guest-remove", key: peerId, name: guest.name });
  }

  onDataConnection(dc) {
    const meta = dc.metadata || {};
    if (this.role === "host") {
      const guest = this.ensureGuest(dc.peer, meta);
      guest.dc = dc;
      this.wireDataChannel(dc, dc.peer);
      dc.on("open", () => {
        dc.binaryType = "arraybuffer";
        // Dial the stage broadcast once the guest is reachable.
        this.refreshGuestStageCall(dc.peer);
      });
    } else {
      this.hostDc = dc;
      this.wireDataChannel(dc, null);
    }
    dc.on("close", () => {
      if (this.role === "host") this.forgetGuest(dc.peer);
      else this.emit({ type: "host-dc-closed" });
    });
  }

  wireDataChannel(dc, peerId) {
    dc.on("open", () => {
      dc.binaryType = "arraybuffer";
      this.emit({ type: "dc-open", key: peerId });
    });
    dc.on("data", async (data) => {
      if (isBinary(data)) {
        let bytes;
        if (data instanceof Blob) bytes = new Uint8Array(await data.arrayBuffer());
        else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
        else bytes = data;
        this.emit({ type: "binary", key: peerId, chunk: bytes });
      } else {
        let msg = data;
        if (typeof data === "string") {
          try {
            msg = JSON.parse(data);
          } catch {
            msg = { raw: data };
          }
        }
        this.emit({ type: "data", key: peerId, msg });
      }
    });
  }

  /** Guest role: dial the host with our proxy AV + a data channel. */
  dialHost(proxyStream) {
    if (this.role !== "guest" || !this.peer?.id) return;
    const dc = this.peer.connect(this.room, {
      metadata: { name: this.displayName, kind: "guest" },
    });
    this.hostDc = dc;
    this.wireDataChannel(dc, null);
    dc.on("close", () => this.emit({ type: "host-dc-closed" }));

    const call = this.peer.call(this.room, proxyStream, {
      metadata: { name: this.displayName, kind: "media" },
    });
    call.on("error", () => {
      if (!this.destroyed) {
        this.emit({ type: "fatal", code: "host-gone", message: "The host room is no longer available." });
      }
    });
  }

  /** Host role: politely eject a guest (room full). */
  rejectGuest(key, reason) {
    const guest = this.guests.get(key);
    if (!guest) return;
    try {
      if (guest.dc?.open) guest.dc.send(JSON.stringify({ t: reason || "show-full" }));
      guest.dc?.close();
      guest.inCall?.close();
      guest.outStageCall?.close();
    } catch {
      /* ignore */
    }
    this.forgetGuest(key);
  }

  onIncomingCall(call) {
    const meta = call.metadata || {};
    if (this.role === "host") {
      const guest = this.ensureGuest(call.peer, meta);
      guest.inCall = call;
      // Host doesn't add a stream here: guests are seen through the stage,
      // and the host's mic flows into the stage mix instead.
      call.answer();
      call.on("stream", (stream) => {
        this.emit({ type: "guest-media", key: call.peer, stream });
      });
      call.on("close", () => this.forgetGuest(call.peer));
    } else {
      // Host -> guest stage call.
      call.answer();
      call.on("stream", (stream) => {
        this.emit({ type: "stage-media", stream });
      });
    }
  }

  // ---- host: stage broadcast -------------------------------------------

  /**
   * @param {(guestKey: string) => MediaStream} streamFor
   *  Called right before dialing so the stream contains the freshest
   *  canvas track and per-guest audio bus.
   */
  setStageStreamProvider(streamFor) {
    this.stageStreamFor = streamFor;
  }

  refreshGuestStageCall(guestKey) {
    if (this.role !== "host" || !this.stageStreamFor) return;
    const guest = this.guests.get(guestKey);
    if (!guest) return;
    const old = guest.outStageCall;
    if (old) {
      guest.outStageCall = null;
      try {
        old.close();
      } catch {
        /* already closed */
      }
    }
    try {
      const stream = this.stageStreamFor(guestKey);
      guest.outStageCall = this.peer.call(guestKey, stream, {
        metadata: { name: this.displayName, kind: "stage" },
      });
      guest.outStageCall.on("error", () => this.forgetGuest(guestKey));
    } catch {
      /* peer not ready; retried on next refresh */
    }
  }

  refreshAllStageCalls() {
    if (this.role !== "host") return;
    for (const key of this.guests.keys()) this.refreshGuestStageCall(key);
  }

  // ---- messaging -------------------------------------------------------

  sendToGuest(key, msg) {
    const dc = this.guests.get(key)?.dc;
    if (dc?.open) dc.send(typeof msg === "string" ? msg : JSON.stringify(msg));
  }

  sendBinaryToGuest(key, bytes) {
    const dc = this.guests.get(key)?.dc;
    if (dc?.open) dc.send(bytes);
  }

  broadcast(msg) {
    for (const key of this.guests.keys()) this.sendToGuest(key, msg);
  }

  sendToHost(msg) {
    if (this.hostDc?.open) this.hostDc.send(typeof msg === "string" ? msg : JSON.stringify(msg));
  }

  sendBinaryToHost(bytes) {
    if (this.hostDc?.open) this.hostDc.send(bytes);
  }

  hostBufferedAmount() {
    const raw = this.hostDc?.dataChannel || this.hostDc?._dc || null;
    return raw?.bufferedAmount ?? 0;
  }

  waitHostLowWater() {
    const raw = this.hostDc?.dataChannel || this.hostDc?._dc || null;
    if (!raw || raw.bufferedAmount < 4 * 1024 * 1024) return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => {
        if (!raw || raw.bufferedAmount < 4 * 1024 * 1024) {
          raw?.removeEventListener("bufferedamountlow", check);
          resolve();
        }
      };
      raw.addEventListener("bufferedamountlow", check);
      setTimeout(check, 250);
    });
  }

  guestCount() {
    return this.guests.size;
  }

  guestList() {
    return [...this.guests.values()].map((g) => ({ key: g.key, name: g.name }));
  }

  destroy() {
    this.destroyed = true;
    for (const guest of this.guests.values()) {
      try {
        guest.dc?.close();
      } catch {}
      try {
        guest.inCall?.close();
      } catch {}
      try {
        guest.outStageCall?.close();
      } catch {}
    }
    try {
      this.hostDc?.close();
    } catch {}
    try {
      this.peer?.destroy();
    } catch {}
  }
}
