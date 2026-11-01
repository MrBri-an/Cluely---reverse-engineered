import { useEffect, useState } from 'react'
import type { ModelInfo, Settings, ShortcutAction } from '../../shared/types'

const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
  toggleVisibility: 'Show / hide overlay',
  toggleExpanded: 'Expand / collapse panel',
  ask: 'Focus ask box',
  clear: 'Clear transcript',
  toggleSession: 'Start / stop session',
  toggleInvisible: 'Toggle invisibility',
  moveUp: 'Move overlay up',
  moveDown: 'Move overlay down',
  moveLeft: 'Move overlay left',
  moveRight: 'Move overlay right'
}

type Tab = 'setup' | 'behavior' | 'models' | 'hotkeys' | 'about'

export function App(): React.JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [tab, setTab] = useState<Tab>('setup')
  const [keyInput, setKeyInput] = useState('')
  const [keyStatus, setKeyStatus] = useState('')
  const [models, setModels] = useState<ModelInfo[]>([])
  const [recording, setRecording] = useState<ShortcutAction | null>(null)
  const [audioLevel, setAudioLevel] = useState(0)

  useEffect(() => {
    void window.specter.getSettings().then(setSettings)
    void window.specter.listModels().then(setModels)
    const off = window.specter.onAudioLevel((l) => setAudioLevel(l.level))
    const offSettings = window.specter.onSettingsChanged(setSettings)
    return () => {
      off()
      offSettings()
    }
  }, [])

  const save = async (patch: Partial<Settings>): Promise<void> => {
    const s = await window.specter.saveSettings(patch)
    setSettings(s)
  }

  const connectKey = async (): Promise<void> => {
    setKeyStatus('Validating…')
    const res = await window.specter.setApiKey(keyInput.trim())
    if (res.ok) {
      setKeyStatus('✓ Connected to Groq')
      setKeyInput('')
      setModels(res.models ?? [])
      const s = await window.specter.getSettings()
      setSettings(s)
    } else {
      setKeyStatus(`✕ ${res.error ?? 'Failed'}`)
    }
  }

  const startRecordingShortcut = async (action: ShortcutAction): Promise<void> => {
    setRecording(action)
    await window.specter.validateKey().catch(() => undefined) // no-op warmup
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      if (e.key === 'Escape') {
        setRecording(null)
        window.removeEventListener('keydown', onKey, true)
        return
      }
      const parts: string[] = []
      if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl')
      if (e.altKey) parts.push('Alt')
      if (e.shiftKey) parts.push('Shift')
      const key = e.key.length === 1 ? e.key.toUpperCase() : e.key
      if (!['Control', 'Meta', 'Alt', 'Shift'].includes(e.key)) {
        parts.push(key)
        void save({ shortcuts: { ...settings!.shortcuts, [action]: parts.join('+') } })
        setRecording(null)
        window.removeEventListener('keydown', onKey, true)
      }
    }
    window.addEventListener('keydown', onKey, true)
  }

  if (!settings) return <div className="loading">Loading…</div>

  const groqModels = models.filter((m) => /llama|whisper|qwen|kimi|gpt-oss|gemma|mixtral|deepseek/i.test(m.id))

  return (
    <div className="dash">
      <aside className="side">
        <div className="brand">
          <div className="brand-orb" />
          <div>
            <div className="brand-name">Specter</div>
            <div className="brand-sub">invisible AI overlay · Groq</div>
          </div>
        </div>
        <nav>
          {(
            [
              ['setup', 'Setup'],
              ['behavior', 'Behavior'],
              ['models', 'Models'],
              ['hotkeys', 'Hotkeys'],
              ['about', 'How it works']
            ] as Array<[Tab, string]>
          ).map(([id, label]) => (
            <button key={id} className={`nav-btn ${tab === id ? 'nav-active' : ''}`} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="side-foot">
          <div className={`key-state ${settings.hasApiKey ? 'key-ok' : 'key-bad'}`}>
            {settings.hasApiKey ? '● Groq connected' : '○ No API key'}
          </div>
          <button className="quit" onClick={() => void window.specter.quitApp()}>
            Quit Specter
          </button>
        </div>
      </aside>

      <main className="content">
        {tab === 'setup' && (
          <section>
            <h1>Connect Groq</h1>
            <p className="lead">
              Specter is bring-your-own-key. Create a free key at{' '}
              <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer">
                console.groq.com/keys
              </a>{' '}
              — it is stored encrypted with your OS credential vault and never leaves this machine except to call Groq.
            </p>
            <div className="card">
              <div className="row">
                <input
                  className="text-input"
                  type="password"
                  placeholder="gsk_..."
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void connectKey()}
                />
                <button className="primary" onClick={() => void connectKey()}>
                  Connect
                </button>
              </div>
              {keyStatus && <div className="status-line">{keyStatus}</div>}
              {settings.hasApiKey && (
                <div className="row" style={{ marginTop: 10 }}>
                  <button
                    className="ghost"
                    onClick={async () => {
                      setKeyStatus('Validating…')
                      const res = await window.specter.validateKey()
                      setKeyStatus(res.ok ? '✓ Key works' : `✕ ${res.error}`)
                      if (res.ok) setModels(res.models ?? [])
                    }}
                  >
                    Test key
                  </button>
                  <button className="ghost danger" onClick={() => void window.specter.clearApiKey()}>
                    Remove key
                  </button>
                </div>
              )}
            </div>

            <h2>Live check</h2>
            <p className="lead">This meters the system audio Specter hears (loopback). Play something out loud to see it move.</p>
            <div className="card meter-card">
              <div className="meter">
                <div className="meter-fill" style={{ width: `${Math.round(audioLevel * 100)}%` }} />
              </div>
              <span className="meter-label">system audio</span>
            </div>
          </section>
        )}

        {tab === 'behavior' && (
          <section>
            <h1>Behavior</h1>
            <div className="card">
              <Toggle
                label="Invisible to screen share"
                hint="Content protection — Specter is excluded from screen captures, recordings and shares (Zoom, Meet, Teams). Off = visible to everyone, useful for demos."
                value={settings.invisible}
                onChange={(v) => void save({ invisible: v })}
              />
              <Toggle
                label="Never steal focus when invisible"
                hint="Overlay shows without activating, so your typing keeps flowing into the app underneath."
                value={settings.noFocusWhenInvisible}
                onChange={(v) => void save({ noFocusWhenInvisible: v })}
              />
              <Toggle
                label="Capture my microphone too"
                hint="Adds your voice as 'You' lines. The system loopback already captures everyone else."
                value={settings.micEnabled}
                onChange={(v) => void save({ micEnabled: v })}
              />
              <Toggle
                label="Smart suggestions (proactive)"
                hint="Periodically reads the transcript — plus the screen if set to 'always' below — and posts a suggestion only when it matters. Costs a few tokens per check."
                value={settings.autoSuggest}
                onChange={(v) => void save({ autoSuggest: v })}
              />
              {settings.autoSuggest && (
                <label className="sub-field">
                  Check interval: {settings.autoSuggestIntervalSec}s
                  <input
                    type="range"
                    min={10}
                    max={120}
                    step={5}
                    value={settings.autoSuggestIntervalSec}
                    onChange={(e) => void save({ autoSuggestIntervalSec: Number(e.target.value) })}
                  />
                </label>
              )}
            </div>

            <div className="card">
              <div className="field">
                <span>Screen awareness</span>
                <select
                  value={settings.screenUse}
                  onChange={(e) => void save({ screenUse: e.target.value as Settings['screenUse'] })}
                >
                  <option value="off">Off — text and audio only</option>
                  <option value="auto">Auto — capture when you press the camera button</option>
                  <option value="always">Always — attach a screenshot to every smart check</option>
                </select>
              </div>
              <label className="field col-field">
                <span>Custom mode prompt (used when mode = custom)</span>
                <textarea
                  rows={4}
                  value={settings.customPrompt}
                  placeholder="You are Specter, a discreet assistant. …"
                  onChange={(e) => void save({ customPrompt: e.target.value })}
                />
              </label>
            </div>
          </section>
        )}

        {tab === 'models' && (
          <section>
            <h1>Models</h1>
            <p className="lead">Defaults are tuned for speed on Groq. Pick from the models your key can see.</p>
            <div className="card">
              {(
                [
                  ['chat', 'Text / reasoning'],
                  ['fast', 'Fast lane (smart-suggest gate)'],
                  ['vision', 'Screen understanding (multimodal)'],
                  ['stt', 'Speech-to-text']
                ] as Array<[keyof Settings['models'], string]>
              ).map(([slot, label]) => (
                <div className="field" key={slot}>
                  <span>{label}</span>
                  <select
                    value={settings.models[slot]}
                    onChange={(e) => void save({ models: { ...settings.models, [slot]: e.target.value } })}
                  >
                    {(groqModels.length ? groqModels : [{ id: settings.models[slot] }]).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.id}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
              {!settings.hasApiKey && <p className="status-line">Connect a key on the Setup tab to list models.</p>}
            </div>
          </section>
        )}

        {tab === 'hotkeys' && (
          <section>
            <h1>Global hotkeys</h1>
            <p className="lead">Work system-wide, in any app. Click a binding, then press the new combination (Esc cancels).</p>
            <div className="card">
              {(Object.keys(SHORTCUT_LABELS) as ShortcutAction[]).map((action) => (
                <div className="hotkey-row" key={action}>
                  <span>{SHORTCUT_LABELS[action]}</span>
                  <button
                    className={`kbd ${recording === action ? 'kbd-rec' : ''}`}
                    onClick={() => void startRecordingShortcut(action)}
                  >
                    {recording === action ? 'press keys…' : settings.shortcuts[action]}
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {tab === 'about' && (
          <section>
            <h1>How Specter works</h1>
            <div className="card prose">
              <p>
                <b>Invisible overlay.</b> The panel is a frameless, always-on-top, transparent window with
                content protection enabled — the OS removes it from every screen capture, share and
                recording while it stays on your display. It only appears to you.
              </p>
              <p>
                <b>Hears the meeting without joining it.</b> System loopback audio (WASAPI on Windows) is
                tapped directly — no bot, no participant. Voice activity segmentation runs locally; only
                actual speech segments are sent to Groq's Whisper for transcription.
              </p>
              <p>
                <b>Sees your screen on demand.</b> Screenshots are taken from the display the overlay is
                on; the overlay never appears in its own screenshots.
              </p>
              <p>
                <b>Your models, your keys.</b> Streaming chat, vision and speech-to-text all run on Groq
                with your API key — stored encrypted via the OS credential vault, used only from the main
                process.
              </p>
              <p className="dim">
                Architecture reverse-engineered from Cluely v2.0.199 (Windows build) — see the RE report
                bundled with this project for the full evidence trail.
              </p>
            </div>
          </section>
        )}
      </main>
    </div>
  )
}

function Toggle(props: { label: string; hint: string; value: boolean; onChange: (v: boolean) => void }): React.JSX.Element {
  return (
    <label className="toggle-row">
      <div>
        <div className="toggle-label">{props.label}</div>
        <div className="toggle-hint">{props.hint}</div>
      </div>
      <span
        className={`switch ${props.value ? 'on' : ''}`}
        onClick={(e) => {
          e.preventDefault()
          props.onChange(!props.value)
        }}
      >
        <span className="knob" />
      </span>
    </label>
  )
}
