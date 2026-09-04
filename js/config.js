// WaxWing — Local Stream Studio. Shared app configuration.
// PRD v1: max 4 participants (1 host + 3 guests), proxy live video at
// 720p/1080p while recording full-res locally, WebRTC star topology.

export const APP = {
  name: "WaxWing",
  tagline: "Local Stream Studio",
  maxGuests: 3, // 1 host + 3 guests = 4 total
  maxParticipants: 4,
  roomCodeLength: 6,
};

// Proxy stream: what actually travels over the WebRTC link.
export const PROXY = {
  video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: 24 },
};

// Master capture ladder: ask for 4K, fall back gracefully.
export const MASTER_LADDER = [
  { width: 3840, height: 2160, label: "4K" },
  { width: 1920, height: 1080, label: "1080p" },
  { width: 1280, height: 720, label: "720p" },
];

// The host stage composer canvas (also the Director's-Cut fallback source).
export const STAGE = {
  width: 1920,
  height: 1080,
  fps: 30,
  bitsPerSecond: 8_000_000,
  padding: 0.012, // normalized gap between tiles
};

export const LOCAL_RECORD = {
  bitsPerSecond: 16_000_000, // headroom for 4K masters
  timesliceMs: 1000, // flush a chunk to disk every second
};

// Post-show P2P file sync over the data channel.
export const SYNC = {
  chunkSize: 16 * 1024, // 16KB chunks per the PRD
  highWaterMark: 4 * 1024 * 1024, // pause sending above this buffer
};

export const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no ambiguous chars

export const STORAGE_KEYS = {
  name: "ww.displayName",
  cam: "ww.cameraId",
  mic: "ww.micId",
  folder: "ww.folderName",
  optVideo: "ww.optVideo",
  optMic: "ww.optMic",
  optSave: "ww.optSave",
};
