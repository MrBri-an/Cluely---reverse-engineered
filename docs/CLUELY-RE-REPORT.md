# Cluely — Reverse Engineering Report

Target: official Windows installer `https://api.v2.cluely.com/desktop-download/win/latest.exe`
(218.3 MB, NSIS, SHA-256 of extracted app root: `693d598837030ef5834967bbaa4342a34a0424b51b8cd0ada90d31d124adcd21`).
Method: static analysis of the NSIS payload → embedded 7z archives → `resources/app.asar` → JavaScript tree,
analyzed with the REA JavaScript analyzer (Evidence ID `ev_b748c619fbc4f4bc1eefe8b02ba96cedbc8606aed4d7c86eb4e2bf27765414b8`;
3,170 relevant files, 2,077 parsed JS modules, 2,996,045 AST nodes, 17,182 findings).
The full 268 MB machine-readable evidence bundle is kept locally and available on request; this report is the complete human-readable record.

Package identity: `cluely-v2` **v2.0.199**, main `dist-electron/main.js` (rolldown-bundled, 544 KB),
preload `dist-electron/preload.mjs` (314 B), renderer bundle in `dist/` (React + TanStack Router).

## 1. What Cluely is, structurally

Electron app with **7 BrowserWindows**, all driven from one main process:

| Window | Size | Role |
|---|---|---|
| Control pill | 163×50 | tiny always-on-top pill, route `/control` |
| Chat overlay | 540×N | the AI answer panel, route `/chat` |
| Dashboard | 1050×700 | settings/billing/sessions |
| Upcoming Meeting | 360×300 | meeting reminder, top-right |
| Meeting notification | 320×400 | notification surface |

Shared window options observed verbatim in `main.js`:

```js
{
  ...ie,                        // common webPreferences
  alwaysOnTop: true, closable: false, focusable: g(e),   // focusable is dynamic!
  frame: false, fullscreenable: false, hasShadow: false,
  hiddenInMissionControl: true, minimizable: false,
  movable: false, resizable: false, skipTaskbar: true,
  show: false, title: "Cluely", transparent: true, type: "panel"
}
```

Every overlay window calls **`setContentProtection(ue(e))`** on every state update — this is the
"undetectability" mechanism. On Windows it maps to `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`,
on macOS to `CGSSetWindowSharingMode`-equivalent. It removes the window from *screen shares,
recordings and screenshots* while it stays visible on the physical display. It is a boolean toggle
(`isInvisible`) — not an injection, no hooking. That's why it defeats Zoom/Meet/Teams sharing but is
detectable by proctoring tools that look for capture-exclusion API usage.

Notable: the overlay's **focusability is dynamic** (`focusable: g(e)`), and a dedicated setting
`noFocusWhenInvisible` exists — the overlay can avoid stealing focus from the app you're working in.

## 2. The renderer is remote

```js
VITE_RENDERER_URL: "https://renderer.v2.cluely.com"
VITE_SERVER_URL:   "https://api.v2.cluely.com"
VITE_WEB_URL:      "https://v2.cluely.com"
```

`main.js` navigates windows via `win.loadURL(new URL('/#' + route, rendererURL))`. The `dist/`
bundle inside the installer is a fallback/dev copy. This means most business logic ships as
bundled JS we could still read statically, but it can be hot-swapped server-side at any time.

Flag files in `userData/../cluely/`: `undetectability.enabled`, `keybindings`, `theme`,
`use_screen.enabled` — the "invisible" toggle is literally a marker file plus
`setContentProtection(true)`.

## 3. Settings schema (zod, verbatim defaults)

```js
{
  didMigrateV1State, didSetOpenAtLogin, finishedOnboarding: false,
  permissions: { microphone|screen|accessibility: unknown|granted|denied }, // Windows: forced "granted"
  isInvisible: false,             // undetectability / content protection
  noFocusWhenInvisible: false,
  isAmbientEnabled: false,
  hideChatHidesControlWindow: false,
  screenUse: "off" | "required" (default "required"),
  smartMode: false,
  theme: system|light|dark,
  revenueCatEntitlements: []
}
```

## 4. Global shortcuts (defaults)

```
toggleVisibility  Ctrl/Cmd + \
ask               Ctrl/Cmd + Enter
clear             Ctrl/Cmd + R
toggleSession     Ctrl/Cmd + Shift + \
moveUp/Down/Left/Right   Ctrl/Cmd + Arrows
scrollUp/Down     Ctrl/Cmd + Shift + Up/Down
```

Registered via `globalShortcut.register(accelerator, handler)` with a rebind map
(unregister old → register new) and suppressed while the user is recording a new hotkey.
Bindings can be overridden through the `keybindings` flag file (mapped from keys like `start_over`).

## 5. Screen awareness (screenshots)

`electron/domains/screenshot.ts` (bundled):

- Picks the display the chat window is on (`screen.getDisplayMatching(chat.getBounds())`),
  else the primary display.
- `desktopCapturer.getSources({ types: ["screen"], thumbnailSize: scaled(bounds) })` where the
  thumbnail size is the full display bounds scaled so the longest side ≤ **1920**.
- Returns `{ data: thumbnail.toPNG(), contentType: "image/png" }`.
- `capture()` retries 3× with 500 ms delay and exposes `isCapturingScreenshot` in shared state.

Because the overlay windows are content-protected, **Cluely's own windows never appear in its own
screenshots** — a neat consequence of `setContentProtection`.

## 6. Audio pipeline (the most interesting part)

Two platform paths converge on one IPC stream:

**macOS (main process):**
- Mic ("me"): `node-record-lpcm16` → `record({ channels: 1, sampleRate: 48000, audioType: "wav" })`,
  its PCM stream is forwarded as chunks.
- System audio ("them"): bundled native helper **`audiotee-0.0.7`** (plus SoX 14.4.2 binaries) with
  `chunkDurationMs: 50` — taps the system output device and streams raw chunks.

**Windows (renderer):** exact recovered code path:

```js
const stream = await navigator.mediaDevices.getDisplayMedia({
  audio: true, video: { frameRate: 1, height: 1, width: 1 }   // 1×1 video only to unlock loopback
});
for (const t of stream.getVideoTracks()) t.stop();            // video discarded immediately
const ctx = new AudioContext({ sampleRate: 48000 });
const src = ctx.createMediaStreamSource(stream);
const mute = ctx.createGain(); mute.gain.value = 0;           // silent sink, avoids echo
// AudioWorklet "WindowsSystemAudioProcessor": posts Float32Array(inputs[0][0]) per 128-frame block
```

Main enables this with `session.setDisplayMediaRequestHandler((req, cb) =>
desktopCapturer.getSources({types:["screen"]}).then(([first]) => cb({ video: first, audio: "loopback" })))`
— auto-approves, no picker, `audio: "loopback"` = Windows WASAPI loopback.

**Convergence (renderer):** both paths feed `onAudioChunk(role, Float32Array)` where
`role ∈ {"me","them"}`. Main→renderer chunks arrive as `chat-audio-data` IPC `{role, chunk}`
(Int16 PCM, converted with `chunk<0 ? v/32768 : v/32767`).

**VAD (fully local):** loads `onnxruntime-web/dist/ort.js` and `@ricky0123/vad-web/dist/bundle.min.js`
from jsDelivr at runtime; `NonRealTimeVAD` with `{ redemptionMs: 300, preSpeechPadMs: 300 }`;
resamples 48 kHz → 16 kHz; a hard timer force-ends any speech segment after **20 s**.
Echo bleed trick: while `themHasVoiceActivity`, incoming **"me" chunks are zeroed out**
(`new Float32Array(t.length)`) so your voice bleeding into the loopback isn't double-transcribed.

**Transcription:** on `SpeechEnd`:
1. Encode the segment as 16 kHz mono 16-bit WAV → **base64** (`btoa` in 32 KB slices).
2. Append `{ createdAt, relativeMs, role, status: "transcribing" }` to session transcript.
3. `orpc.transcription.transcribe({ wavBase64, language })` → POST to `https://api.v2.cluely.com/rpc`
   (oRPC client, `Authorization: Bearer <token>`, `credentials: include`).
4. On success, flip the entry to `status: "ready"` with `text`. Max **4 concurrent** transcriptions.

## 7. The AI backend

The client contains **no model names and no system prompts** — inference is fully server-side:

- Session/transcript sync: an interval PUTs only `status==="ready"` transcript entries to the
  server session (delta-computed against `includesTranscriptUpToCreatedAt` on the last user message).
- Ask/chat: `assistant-ui` + **assistant-cloud** SDK talking to `https://backend.assistant-api.com`:
  `/v1/auth/tokens/anonymous`, `/v1/auth/tokens/refresh`, `/v1/runs/stream` (Agent protocol,
  `vercel-ai-data-stream/v1` response), `/files/attachments/generate-presigned-upload-url` (screenshots
  and audio attachments are uploaded to presigned object storage and referenced from messages).
- Context is assembled client-side per message: a `<screen_use>` block (current preference +
  screen state) plus transcript lines formatted `- Me: …` / `- Them: …` newer than the last synced
  timestamp. Quick prompts observed verbatim:
  - "Based on what's on my screen, infer and provide me with the best information to help me at the current moment."
  - "I'm (the user) in the middle of a conversation, and I'm asking you for help without…"
- The dashboard uses oRPC `/rpc` on `api.v2.cluely.com`; auth via Clerk; billing via RevenueCat +
  Paddle/Stripe; analytics via PostHog. Error class `out_of_free_sessions` exists — usage-gated.

## 8. What this means for a reimplementation

The whole moat is four OS/Electron primitives + one orchestration pattern:

1. `setContentProtection(true)` — invisible to capture (Windows WDA_EXCLUDEFROMCAPTURE).
2. `type:"panel"` + `alwaysOnTop` + `skipTaskbar` + `transparent` + frameless + dynamic `focusable`.
3. `setDisplayMediaRequestHandler` + `audio:"loopback"` + 1×1-video `getDisplayMedia` + AudioWorklet
   for system audio without a bot in the meeting.
4. Local VAD → WAV segments → server STT; transcript deltas + screenshots as message context;
   streaming agent responses.

Everything else (Clerk, RevenueCat, PostHog, remote renderer) is commercial plumbing, not mechanism.

**Unknowns / limits of this analysis:** server-side prompts, model IDs, rate limits, and the exact
assistant-cloud agent config are not recoverable from the client (static analysis only; no runtime
traffic was captured). The macOS `audiotee` binary was inventoried but not disassembled (native Mach-O;
static JS analysis covers its IPC contract: 48 kHz, 50 ms chunks, role "them").
