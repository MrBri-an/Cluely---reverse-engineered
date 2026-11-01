# Specter Architecture — reverse-engineered mechanism → implementation map

Source evidence: [`./CLUELY-RE-REPORT.md`](./CLUELY-RE-REPORT.md) (static analysis of the real
Cluely v2.0.199 Windows client, REA Evidence `ev_b748c619fbc4f4bc1eefe8b02ba96cedbc8606aed4d7c86eb4e2bf27765414b8`).
Every row pairs an observed Cluely mechanism with the Specter module that implements it.

```
┌────────────────────────────────  Electron main (all secrets, all OS calls)  ───────────────────────────────┐
│  index.ts      app lifecycle · setDisplayMediaRequestHandler(auto-approve + audio:"loopback") · smoke mode │
│  windows.ts    overlay (pill↔panel) + dashboard + tray · content protection · smart click-through          │
│  shortcuts.ts  global hotkeys, rebind-safe (unregister→register, suppressed while recording)               │
│  capture.ts    desktopCapturer thumbnails, display-aware, ≤1920 px — own windows excluded by protection    │
│  sessions.ts   session store + rolling transcript (Them / You)                                             │
│  groq.ts       streaming chat · vision · STT + the prompt library (Cluely keeps this server-side)          │
│  suggest.ts    smart mode: periodic "is there something worth saying?" gate → SILENT or suggestion         │
│  settings.ts   settings JSON + API key encrypted via safeStorage (DPAPI / Keychain)                        │
└────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
                 │ contextBridge (whitelisted channels only, renderers sandboxed)
        ┌────────┴─────────┐                              ┌──────────────────┐
        │  overlay (ghost) │                              │    dashboard     │
        │  pill ↔ panel    │   audio.ts: loopback lane    │  onboarding/key  │
        │  transcript pane │   1×1 video trick → worklet  │  models/hotkeys  │
        │  streaming answer│   RMS VAD → 16 kHz WAV       │  privacy toggles │
        └──────────────────┘                              └──────────────────┘
```

## Mechanism map

| Cluely (observed) | Specter (implementation) |
|---|---|
| 7 `type:"panel"` windows; pill 163×50 + chat 540 + dashboard 1050×700; `alwaysOnTop`, `frame:false`, `skipTaskbar`, `hasShadow:false`, `transparent`, dynamic `focusable` | One overlay window morphing pill(340×56)↔panel(660×640) + dashboard; same flags in `windows.ts`; dynamic `focusable` honored via `noFocusWhenInvisible` + `showInactive` |
| `setContentProtection(ue(e))` on every state change; `undetectability.enabled` flag file | `settings.invisible` → `setContentProtection` applied on boot, on hotkey (`Ctrl+Shift+I`), on tray toggle; persisted in settings JSON |
| `session.setDisplayMediaRequestHandler` → first screen + `audio:"loopback"` | Identical handler in `main/index.ts` — auto-approves, no picker |
| Renderer `getDisplayMedia({audio:true, video:{1×1 @1fps}})` → stop video tracks → `AudioContext(48k)` → AudioWorklet posts Float32 | `renderer/overlay/audio.ts` `startLane('them')` — same trick, verbatim mechanism |
| macOS: `node-record-lpcm16` (mic) + native `audiotee` (system) → `chat-audio-data` IPC | Windows-native loopback needs no helper; optional mic lane via `getUserMedia` (echo-cancelled); lane architecture accepts future macOS tap |
| `@ricky0123/vad-web` (Silero ONNX, CDN-loaded), `redemptionMs:300`, `preSpeechPadMs:300`, 48k→16k, 20 s max segment | Dependency-free adaptive-RMS VAD (`RmsVad`): noise-floor EMA, 500 ms hangover, 500 ms pre-pad, 280 ms min speech, 20 s cap; tested in `scripts/test-audio-pipeline.mjs` |
| Echo-bleed guard: zero "me" chunks while `themHasVoiceActivity` | Same design intent handled at capture level: mic lane uses echo cancellation; loopback+mic lanes are independent |
| `encodeWAV` (16 kHz mono, 16-bit) → base64 → `orpc.transcription.transcribe` → `api.v2.cluely.com/rpc`, max 4 concurrent | `encodeWav16kMono` → ArrayBuffer via `stt:transcribe` IPC → `groq.transcribeWav` → `api.groq.com/openai/v1/audio/transcriptions` (`whisper-large-v3-turbo`) |
| Rolling transcript entries `{createdAt, relativeMs, role, status}` synced to server | `sessions.ts` keeps the transcript locally (last 500 entries); no server, no sync |
| Ask context: `<screen_use>` block + `- Me:/- Them:` lines newer than last sync | `ipc.ts chat:ask`: `<transcript>` block + `<user_request>`; optional screenshot as `image_url` data URL |
| Quick prompt "Based on what's on my screen, infer and provide me with the best information…" | `assist` mode prompt in `groq.ts MODE_PROMPTS` (+ camera button = capture & ask) |
| AI runs server-side (`backend.assistant-api.com`, vercel-ai-data-stream), prompts/models hidden | Runs client-side on Groq with `stream:true` SSE parsing (`groq.chatStream`); prompts and models are user-editable |
| Hotkeys: `Ctrl+\` toggle, `Ctrl+Enter` ask, `Ctrl+R` clear, `Ctrl+Shift+\` session, arrows move; rebind map | Same defaults plus `Ctrl+K` expand, `Ctrl+Shift+I` invisibility; rebind-safe `shortcuts.ts`, recorded from dashboard |
| Screenshot: display matching chat window, thumbnail ≤1920, PNG, 3 retries | `capture.ts`: display matching overlay, ≤1920 scaling, PNG data URL (retries unnecessary — capture is invoked on demand) |
| Clerk auth, RevenueCat, PostHog, remote renderer host | None — everything local; renderer bundled in the app |

## Design decisions beyond Cluely

1. **BYO Groq key, encrypted at rest.** No accounts, no server dependency, no remote code loading
   (Cluely's renderer is hot-loaded from `renderer.v2.cluely.com`; Specter's is bundled).
2. **Smart mode.** One cheap LLM call decides *whether* to speak (`SILENT` sentinel), avoiding
   token burn and noise — Cluely's client never shows proactive gating.
3. **Zero-dependency VAD.** No CDN scripts (Cluely pulls ONNX+Silero from jsDelivr at runtime);
   works fully offline for capture, uploads only real speech.
4. **Sandboxed renderers.** `contextIsolation: true`, `nodeIntegration: false`, whitelisted
   contextBridge API — the key never enters a renderer process.

## Verification performed

| Check | Result |
|---|---|
| `npm run typecheck` (strict TS, main + web) | pass |
| `npm run build` (main 28.7 kB, preload 2.3 kB, 2 renderer entries) | pass |
| `npm run smoke` (hidden boot → `SPECTER_SMOKE_OK windows=1`) | pass |
| CDP runtime probe of the live overlay (`scripts/verify-cdp.mjs`) | pill renders, status "Add API key", 0 console errors/exceptions |
| Audio DSP test (`scripts/test-audio-pipeline.mjs`) | 1 speech segment from silence→tone→silence; RIFF/WAVE, 16 kHz, mono, 16-bit, 1984 ms |
| Groq network test (invalid key) | all 3 endpoints reached; multipart upload OK; errors map to clean `GroqError 401: Invalid API Key` |
