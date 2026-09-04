// Host-side audio mixer (Web Audio API).
//
// The stage stream guests receive must not contain their own voice
// (that would echo back at them over the network). So the host keeps:
//   - a master bus  = every participant's mic   (monitoring + Director's Cut)
//   - one bus per guest = every mic EXCEPT that guest's (stage out-call)
//
// Buses are rebuilt whenever a participant joins/leaves or swaps devices.
// The network layer is told to refresh per-guest stage calls afterwards,
// because WebRTC audio tracks can't be swapped in without renegotiation
// that PeerJS doesn't support — we simply re-dial each guest's stage call.

export class AudioBus {
  constructor() {
    this.ctx = null;
    this.sources = new Map(); // key -> { node, stream }
    this.masterDest = null;
    this.guestDests = new Map(); // guest key -> MediaStreamAudioDestinationNode
    this.monitorGain = null; // remote-only feed to the host's speakers
    this.refreshListener = null;
  }

  async start() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) throw new Error("Web Audio is not supported here.");
      this.ctx = new Ctx({ latencyHint: "interactive" });
    }
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  setRefreshListener(fn) {
    this.refreshListener = fn;
  }

  hasSource(key) {
    return this.sources.has(key);
  }

  addSource(key, stream) {
    const audioTrack = stream?.getAudioTracks()[0];
    if (!audioTrack || this.sources.has(key)) return;
    if (!this.ctx) return; // host must call start() first (user gesture)
    const node = this.ctx.createMediaStreamSource(stream);
    this.sources.set(key, { node, stream });
    this.rebuild();
  }

  removeSource(key) {
    const entry = this.sources.get(key);
    if (!entry) return;
    entry.node.disconnect();
    this.sources.delete(key);
    this.rebuild();
  }

  // Rebuild master + all per-guest buses from the current source set.
  rebuild() {
    if (!this.ctx) return;
    const keys = [...this.sources.keys()];

    // Tear down previous destination nodes so nothing leaks audio.
    if (this.masterDest) this.masterDest.disconnect();
    for (const dest of this.guestDests.values()) {
      if (dest) dest.disconnect();
    }

    // Master bus: every mic (Director's Cut / monitoring source of truth).
    this.masterDest = this.ctx.createMediaStreamDestination();
    for (const key of keys) this.sources.get(key).node.connect(this.masterDest);

    // Speakers: only *remote* voices, so the host doesn't hear themselves
    // delayed through the mixer. Guests' mics fan out to both buses.
    if (!this.monitorGain) {
      this.monitorGain = this.ctx.createGain();
      this.monitorGain.connect(this.ctx.destination);
    }
    for (const key of keys) {
      if (key !== "self") this.sources.get(key).node.connect(this.monitorGain);
    }

    // Per-guest buses: everything except that guest (no self-echo).
    for (const guestKey of this.guestDests.keys()) {
      const dest = this.ctx.createMediaStreamDestination();
      for (const key of keys) {
        if (key !== guestKey) this.sources.get(key).node.connect(dest);
      }
      this.guestDests.set(guestKey, dest);
    }

    // In-flight stage calls carry stale audio; ask the network to re-dial.
    if (this.refreshListener) this.refreshListener();
  }

  ensureGuestBus(guestKey) {
    if (this.guestDests.has(guestKey)) return;
    this.guestDests.set(guestKey, null);
    this.rebuild();
  }

  removeGuestBus(guestKey) {
    this.guestDests.delete(guestKey);
    this.rebuild();
  }

  masterStream() {
    return this.masterDest?.stream || new MediaStream();
  }

  guestBusStream(guestKey) {
    this.ensureGuestBus(guestKey);
    return this.guestDests.get(guestKey).stream;
  }
}
