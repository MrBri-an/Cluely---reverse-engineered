# Specter 👻

An **invisible, always-on-top AI overlay** that sees what's on your screen and hears your meetings — powered entirely by **Groq** with your own API key. No subscription, no bot in the meeting, nothing in the cloud but the model calls you make.

The architecture was reverse-engineered from the real Cluely Windows client (v2.0.199) — see [`docs/CLUELY-RE-REPORT.md`](docs/CLUELY-RE-REPORT.md) for the full evidence trail. Specter re-implements the mechanisms (capture-exclusion overlay, loopback audio, local VAD → STT, screen-aware prompting) and replaces Cluely's closed backend with **Groq** (streaming Llama, multimodal Llama-4 vision, Whisper STT).

---

## Features

| Capability | How |
|---|---|
| **Invisible to screen share** | `setContentProtection(true)` → `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` on Windows / capture-exclusion on macOS. The overlay is visible to you, absent from Zoom/Meet/Teams shares, recordings and screenshots. Toggle any time (tray menu or `Ctrl+Shift+I`). |
| **Always-on-top ghost panel** | Frameless, transparent, skip-taskbar, `screen-saver` z-level, smart click-through (passes clicks through except over the panel's own controls), never steals focus. |
| **Hears meetings without joining** | Windows WASAPI loopback via `getDisplayMedia` + `setDisplayMediaRequestHandler(audio: "loopback")` — the same 1×1-video trick Cluely uses. No bot, no meeting participant. |
| **Local voice-activity detection** | Adaptive-RMS VAD (noise-floor tracking, 500 ms hangover, 500 ms pre-pad, 20 s cap) segments speech locally; **only actual speech** is uploaded. |
| **Real-time transcript** | Speech segments → 16 kHz WAV → Groq `whisper-large-v3-turbo` → rolling `Them`/`You` transcript. |
| **Screen understanding** | One-keystroke capture of the display the overlay is on → Groq multimodal (`llama-4-scout`) → "answer what's on my screen". |
| **Streaming answers** | Groq chat completions with `stream: true`, markdown-rendered live. |
| **Smart suggestions (beyond Cluely)** | Optional proactive mode: periodically reads transcript (+screen) and answers only when it matters — one cheap call, `SILENT` otherwise. |
| **4 modes** | `assist` (infer my need from screen), `meeting` (live copilot bullets), `interview` (first-person spoken answers only), `custom` (your prompt). |
| **BYO key, private by design** | Groq key stored OS-encrypted (`safeStorage`/DPAPI), used only in the main process. Renderers are sandboxed with context isolation; no telemetry, no remote-renderer, no server. |

## Quick start

```bash
cd specter
npm install
npm run dev        # development with HMR
```

1. The dashboard opens on first run → paste a free key from [console.groq.com/keys](https://console.groq.com/keys) → **Connect**.
2. The pill appears at the top-center of your screen. Click ⌄ to expand.
3. Start talking in any meeting — the transcript fills up, answers stream in.

Production build & run:

```bash
npm run build
npm start          # electron-vite preview (packaged-style)
```

## Hotkeys (defaults, all rebindable)

| Action | Keys |
|---|---|
| Show / hide overlay | `Ctrl+\` |
| Expand / collapse panel | `Ctrl+K` |
| Focus ask box | `Ctrl+Enter` |
| Clear transcript | `Ctrl+R` |
| Start / stop session | `Ctrl+Shift+\` |
| Toggle invisibility | `Ctrl+Shift+I` |
| Move overlay | `Ctrl+Arrows` |

## Project layout

```
src/
  main/            Electron main process (all secrets & OS calls live here)
    index.ts       lifecycle, display-media handler, smoke mode
    windows.ts     stealth overlay + dashboard + tray
    shortcuts.ts   global hotkeys (rebind-safe)
    capture.ts     desktopCapturer screenshots (≤1920 px, display-aware)
    groq.ts        Groq client: streaming chat, vision, STT + prompt library
    sessions.ts    session & transcript store
    suggest.ts     smart-mode proactive suggestions
    settings.ts    settings + encrypted API key
    ipc.ts         typed IPC surface
  preload/         contextBridge API (whitelisted channels only)
  renderer/
    overlay/       the ghost UI (pill ↔ panel, transcript, streaming answer, modes)
    dashboard/     onboarding, key setup, models, hotkeys, privacy
  shared/types.ts  one source of truth for IPC types
```

## Verification

```bash
npm run typecheck   # strict TS over main+preload+renderer
npm run smoke       # builds, launches headless, waits for SPECTER_SMOKE_OK
```

## Honest limitations

- **Audio capture is Windows-first.** Loopback via `getDisplayMedia` is a Windows feature; on macOS you'd tap system audio with a virtual device (BlackHole) or a helper like Cluely's `audiotee` — the lane architecture is ready for it, mic capture already works everywhere.
- **VAD is energy-based.** Cluely ships Silero (ONNX). Adaptive-RMS handles normal meeting conditions; swapping in Silero via `@ricky0123/vad-web` is a drop-in upgrade if you need it.
- **Respect the room.** Capture-exclusion hides the overlay from *software* sharing — it does not make cheating undetectable to proctoring software, cameras, or other humans. This project exists to study the architecture; use it for notes, accessibility, and meeting copiloting.
