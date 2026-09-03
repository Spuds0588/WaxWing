
# Local Stream Studio (V1) - Local HD + P2P Broadcaster

A purely frontend, serverless, peer-to-peer podcasting and live-streaming studio. Designed to run entirely in the browser via GitHub Pages, it combines the real-time compositing of StreamYard with the uncompressed local recording fidelity of Riverside—all with zero backend infrastructure.

---

## Part 1: Product Requirements Document (PRD)

### 1.1 Problem Statement
Cloud-based recording studios (StreamYard, Riverside) require expensive monthly subscriptions, enforce platform lock-in, and rely heavily on backend SFUs (Selective Forwarding Units) which introduce latency and server costs. Podcasters and streamers need a frictionless, high-fidelity recording solution that they can own and operate for free.

### 1.2 Core Value Proposition
* **Zero Backend:** Hosted entirely on GitHub Pages (static HTML/CSS/JS).
* **Frictionless Entry:** Magic link URLs for guests; no logins required.
* **Pristine Quality:** Records raw 4K camera feeds locally to disk, bypassing internet bandwidth bottlenecks.
* **Host Control:** A browser-based OBS-style draggable stage for instant "Director's Cut" recordings.

### 1.3 Target Audience
Video podcasters, indie live streamers, and content creators who want multi-track HD recording without paying for a SaaS subscription.

### 1.4 Core Features (V1 Scope)
1. **Host-as-Hub Networking:** Supports up to 4 participants (1 Host, 3 Guests) via a P2P Star Topology.
2. **Proxy Video Workflow:** Streams lightweight 720p/1080p video for zero-latency live communication, while simultaneously recording full 4K to the local hard drive.
3. **Draggable DOM Stage:** A 16:9 CSS Grid container where the Host can drag, drop, and resize participant feeds and overlays.
4. **Director's Cut Recording:** Captures the customized DOM layout natively using the Region Capture API (1080p max).
5. **Direct-to-Disk Backup:** Utilizes the File System Access API to stream large 4K video files directly to SSD, preventing RAM crashes.
6. **Post-Show P2P Sync:** Automatically transfers high-res local guest files to the Host over WebRTC Data Channels when recording stops.

### 1.5 Out of Scope (V2 / V3)
* Google Drive / OneDrive API integrations (V2).
* Direct-to-Platform streaming via WHIP or RTMP bridges (V3).
* Support for Safari / iOS local HD recording (Apple blocks the required File System APIs).

---

## Part 2: Implementation Guide

### 2.1 Technology Stack
* **Hosting:** GitHub Pages
* **Framework:** Vanilla JavaScript (ES6 Modules). *YAGNI: No React, no Webpack, no build step.*
* **Styling:** CSS3 (CSS Grid, Flexbox, CSS Variables).
* **Signaling:** [PeerJS](https://peerjs.com/) (using their free public cloud tier for initial WebRTC SDP handshake).

### 2.2 Network Architecture: Star Topology
We are building a browser-based SFU. 
* **The Host** creates the room (`?room=HOST_ID`). 
* **The Guests** connect *only* to the Host. 
* The Host receives all Guest streams and sends back a composited "Stage" stream so Guests can see the show.
* *Why:* Prevents a 4-person mesh network from requiring 12 concurrent HD connections, which would melt standard CPUs.

### 2.3 Browser API Dependencies
This application heavily leverages bleeding-edge browser APIs. **Chromium (Chrome, Edge, Brave) on Desktop is strictly required for full functionality.**

| Feature | Browser API | Fallback for Safari/Firefox |
| :--- | :--- | :--- |
| Local HD Recording | `showSaveFilePicker()` (File System Access) | In-memory `Blob` array (risks crashing on long shows). |
| A/V Capture | `navigator.mediaDevices.getUserMedia()` | Supported natively. |
| Stage Screen Record | `navigator.mediaDevices.getDisplayMedia()` + `CropTarget` | Full-screen record (requires manual cropping later). |
| P2P Data & Video | `RTCPeerConnection` / `RTCDataChannel` | Supported natively. |

### 2.4 The "Proxy" Recording Logic
To support 4K without crashing the browser:
1. `getUserMedia` requests maximum resolution (up to 4K).
2. The stream is cloned. 
3. **Stream A (Live Proxy):** WebRTC tracks are constrained to 720p/1080p and sent to the Host.
4. **Stream B (Local Master):** Natively passed into `MediaRecorder` at max resolution, utilizing hardware encoders, and chunked directly to the local disk via a `FileSystemWritableFileStream`.

---

## Part 3: Developer Task List

### Phase 1: Project Setup & Core Shell
- [ ] Initialize Git repo and set up `index.html`, `style.css`, and `/js` directory (Modules: `app.js`, `network.js`, `stage.js`, `recorder.js`).
- [ ] Build the UI shell: Header (Controls), Main (16:9 Stage Area), Sidebar (Hidden participant list / Settings).
- [ ] Implement URL parameter parsing to determine user role (`Host` if no param, `Guest` if `?room=xyz`).
- [ ] Hook up `getUserMedia` for initial webcam/mic access with device selection dropdowns.

### Phase 2: WebRTC & Networking (Star Topology)
- [ ] Import PeerJS via CDN.
- [ ] **Host Logic:** Generate a fixed UUID, connect to PeerJS, and listen for incoming connections.
- [ ] **Guest Logic:** Read the `?room=` ID from the URL, connect to PeerJS, and initiate a call to the Host.
- [ ] Implement the stream cloning logic: downscale the outgoing WebRTC track to 720p for bandwidth management.
- [ ] Map incoming Remote Streams to hidden `<video>` elements in the DOM for audio playback and stage injection.

### Phase 3: The DOM Stage & Scene Builder
- [ ] Create the `.stage-container` CSS Grid.
- [ ] Implement a template system (e.g., CSS classes for `.layout-side-by-side`, `.layout-grid`).
- [ ] Build the Drag & Drop module: Allow the Host to apply `position: absolute` to participant video wrappers to break them out of the grid.
- [ ] Add basic styling overlays (Name tags based on WebRTC peer data, simple lower-thirds).

### Phase 4: The Recording Engine (The Hard Part)
- [ ] Implement the `File System Access API` wrapper. Prompt the user for a save directory *before* the show starts.
- [ ] **Track 1 (Guests & Host):** Hook up `MediaRecorder` to the raw, uncompressed 4K `getUserMedia` track. Write chunks to disk every 1000ms.
- [ ] **Track 2 (Host Only):** Implement `getDisplayMedia()` targeting the current browser tab.
- [ ] Apply the Region Capture API (`CropTarget.fromElement`) to limit the Host's screen record strictly to the `.stage-container` div.
- [ ] Create the "Stop Recording" event chain (close file handles gracefully).

### Phase 5: P2P File Sync & Polish
- [ ] Instantiate `RTCDataChannel` between Host and Guests during the initial WebRTC handshake.
- [ ] Create the post-show sync logic: When Host clicks "Stop", send a Data Channel signal to Guests.
- [ ] On Guest side: Read the local WebM/MP4 file using the File API, chunk it into 16KB ArrayBuffers, and stream it over the Data Channel to the Host.
- [ ] On Host side: Receive chunks, assemble via File System Access API into the Host's "Guest_Backups" folder.
- [ ] Implement the "Do Not Close Tab" warning UI with a file transfer progress bar.
- [ ] Test gracefully handling network drops and Safari degradation fallbacks.
```

