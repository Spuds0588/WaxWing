# WaxWing — Local Stream Studio

> **🌐 Live studio — [spuds0588.github.io/WaxWing](https://spuds0588.github.io/WaxWing/)** ·
> free, no sign-up, no backend. Open it on a desktop (Chrome/Edge) to start a
> show as the host; send the invite link to guests on any device.

A purely frontend, serverless, peer-to-peer podcasting and live-streaming studio.
Inspired by the *Local Stream Studio* PRD in this repo: the real-time compositing
of a cloud studio, plus the uncompressed local recording fidelity of a desktop
recorder — with **zero backend infrastructure**.

The UI is a minimalist dark theme keyed to the cedar waxwing: warm charcoal
backgrounds, cream plumage strokes, waxwing-yellow accents and waxy-tip red for
recording states. The brand mark is the waxwing illustration recolored to cream
plumage (`public/waxwing-mark.svg`), used inline across the header, home page
and modal, and as the favicon / home-screen icon.

**Chromium desktop (Chrome, Edge, Brave) is required for full functionality.**
Safari/Firefox can join as guests but degrade to in-memory recording, and the
1080p Director's Cut needs Region Capture (Chromium).

## Run it

```bash
bun install
bun run dev        # local dev server (http://localhost:5173)
bun run build      # static build -> dist/ (hostable anywhere, e.g. GitHub Pages)
```

Because the app is 100% static, `dist/` can be dropped on GitHub Pages, Netlify,
or any file host. No server, database, or API keys are involved.

## Testing (consistent mobile coverage)

```bash
bun test           # unit tests (bun's runner, no browser needed)
bun run test:e2e   # Playwright mobile suite: build + chromium + 3 phone profiles
```

The E2E suite runs on **Android-portrait (412×915), iOS-portrait (390×844) and
phone-landscape (844×390)** viewports and fails on any horizontal/vertical
overflow or broken mobile affordance. It covers the guest and host pre-flight
shells *and* a full **live session**: the spec spins up a local PeerJS
signaling server, connects a real host tab to a real guest tab over WebRTC
with fake cameras, brings the stage on air, records a few seconds, stops, and
asserts every screen (session shell, stage, sync modals on both sides) still
fits the phone with zero JS errors.
Playwright's chromium needs system libraries on Linux — CI handles that with
`playwright install --with-deps` (see `.github/workflows/ci.yml`); locally run
`bunx playwright install --with-deps chromium` once.

### Two-browser smoke (`bun run smoke:2tab`)

```bash
bun run smoke:2tab   # real host tab + real phone-shaped guest tab, fake A/V
```

Runs the genuine product flow between **two live tabs**: the desktop host walks
the landing → studio funnel, a mobile guest joins through the invite link, the
host's composited stage reaches the guest and decodes, and a real Record/Stop
round-trip streams the guest's master back over the WebRTC data channel. It
talks to a **local PeerJS signaling server** (so it also runs where external
WebSockets are blocked) and swaps `showDirectoryPicker` for an in-memory twin
of the File System Access handle — everything else is the real media, recorder
and sync code. Needs chromium + system libs as above.

CI (`.github/workflows/ci.yml`) runs typecheck + unit tests + build + the E2E
suite on every push and pull request.

## How it works

### Preflight camera preview
Before you commit to joining, the welcome modal opens a **live, muted camera
preview** so you can see yourself and your framing first — picking a different
camera in the dropdown restarts the preview instantly. It runs at a low
640×480 so it's cheap, and it's stopped the moment you enter the studio (the
real capture then opens at full resolution). If the camera can't start (no
permission yet, no camera), the box says so and joining still works.

### Roles come from the URL
- **Host** — open the app with no parameters. You land on a selling home page;
  hit **Start your studio** to open the preflight, and you get a 6-letter room
  code — your browser becomes the hub. The invite link is your recording
  session; share it to bring guests on stage.
- **Guest** — open `…?room=CODE` (the invite link the host copies). You land
  straight on the join screen and connect to the host's browser over WebRTC.
  No accounts, no installs.

### Mobile guests (supported)
Guests can join from a phone in any modern browser:

- **iOS Safari (≥15)** & **Android Chrome** can watch the stage, talk, and be
  seen — tap **“Tap to hear the show”** once to unlock audio, and the
  **full-screen** button fills the screen. A nudge suggests rotating to
  landscape for the biggest stage.
- **Local guest recording** works on Android Chrome (kept in memory on the
  phone, then synced to the host). iOS Safari can't mux video with
  `MediaRecorder`, so those guests join live but don't record locally — the
  host is told immediately, and the show carries on.
- File System Access / 4K direct-to-disk, the Director's Cut and hosting
  remain desktop-Chromium features per the PRD.

Headsets are recommended for guests so the host's stage mix doesn't loop back
into their microphone.

### Star topology
Guests never connect to each other. The **host** is the star:

```
 Guest ──proxy AV (720p) + data channel──▶ Host ──composited stage stream──▶ Guest
                                          Host ──composited stage stream──▶ Guest 2 …
```

- Signaling: [PeerJS](https://peerjs.com/) free public cloud (SDP handshake only).
- Media + file data never touch a server once connected.

### The "proxy" recording trick
`getUserMedia` asks for the highest resolution the camera offers (up to 4K).
The stream is cloned; the clone is constrained to 1280×720 and is what travels
over WebRTC. The **original** track feeds a local `MediaRecorder`, whose chunks
are streamed straight to disk via the **File System Access API** — hour-long
shows never live in RAM.

### The stage
The host arranges feeds on a 16:9 stage: tiles auto-arrange (solo /
side-by-side / spotlight + stack / 2×2 grid) and can be **dragged** by their
top edge or **resized** from the corner grip. Double-click a tile to snap it
back into the auto layout. The same layout is composited onto a 1920×1080
canvas that becomes the guests' broadcast (name tags baked in) and doubles as
the Director's Cut source when Region Capture isn't available.

### Audio
A Web Audio mixer on the host builds one bus per guest containing every mic
**except that guest's**, so nobody hears their own voice echoed back over the
network. The host monitors only remote voices.

### Recording controls
- **Record** (host): every participant records their own local master
  simultaneously. Guests need no click — the host's broadcast starts them.
- **Stage** (host): the Director's Cut. Uses Region Capture
  (`CropTarget.fromElement` + `track.cropTo`) to record exactly the stage at
  1080p; falls back to the composer canvas.

### Post-show sync
When the host stops the show, each guest streams their high-res local master
back over the RTC **data channel** in 16KB chunks with buffer backpressure.
The host writes every file into the chosen folder as it arrives. A
"keep this tab open" pill and progress bars guard both sides until done.

## Architecture

Vanilla ES modules under `js/` (no framework, no build step in authoring —
Vite is only a dev server / static bundler):

| File            | Responsibility                                   |
| --------------- | ------------------------------------------------ |
| `app.js`        | Orchestration: roles, recording/sync state machines, UI wiring |
| `network.js`    | PeerJS star topology, media + data channels      |
| `stage.js`      | DOM stage, drag/resize, layouts, canvas composer |
| `audio-bus.js`  | Web Audio mixer (master + per-guest, no echo)    |
| `recorder.js`   | MediaRecorder + Director's Cut (CropTarget)      |
| `fs.js`         | File System Access wrapper (memory fallback)     |
| `sync.js`       | Chunked P2P uploader                             |
| `device.js`     | Camera ladder + proxy track downscaling          |
| `config.js`     | Constants                                        |
| `util.js`       | DOM/format helpers                               |

## Roadmap

- **Agentic studio sessions via WebMCP** *(planned)* — expose WaxWing's actions
  as [WebMCP](https://zuplo.com/blog/what-is-webmcp) tools (the W3C-proposed
  **Web Model Context Protocol** for browser-native agent tools) so an AI agent
  working inside the tab can: create a studio session, mint **host & guest magic
  links** for its user, monitor recording state, and organize/download finished
  recordings on the user's behalf. WaxWing stays zero-backend — the WebMCP tool
  layer runs in the same static app.
- **Direct-to-platform streaming** (WHIP/RTMP bridge) and **cloud sync**
  (Drive/OneDrive) per the original PRD's V2/V3 scope.

## License

MIT © Corey Burns
