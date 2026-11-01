import { useCallback, useEffect, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type {
  AskEvent,
  Mode,
  Settings,
  SuggestionEvent,
  TranscriptEntry
} from '../../shared/types'
import { audioManager, type LaneState } from './audio'

marked.setOptions({ breaks: true, gfm: true })

function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text) as string)
}

export function App(): React.JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([])
  const [answer, setAnswer] = useState('')
  const [answerState, setAnswerState] = useState<'idle' | 'streaming' | 'error'>('idle')
  const [askError, setAskError] = useState('')
  const [notice, setNotice] = useState('')
  const [suggestion, setSuggestion] = useState<SuggestionEvent | null>(null)
  const [input, setInput] = useState('')
  const [sessionActive, setSessionActive] = useState(false)
  const [audioStatus, setAudioStatus] = useState<LaneState>('off')
  const [audioError, setAudioError] = useState('')
  const [levels, setLevels] = useState<{ them: number; me: number }>({ them: 0, me: 0 })
  const [busyLanes, setBusyLanes] = useState<{ them: boolean; me: boolean }>({ them: false, me: false })

  const answerIdRef = useRef<string | null>(null)
  const transcriptBoxRef = useRef<HTMLDivElement>(null)
  const answerBoxRef = useRef<HTMLDivElement>(null)

  // ---- initial load + subscriptions ----
  useEffect(() => {
    void window.specter.getSettings().then((s) => {
      setSettings(s)
      setExpanded(s.expanded)
    })
    const offs = [
      window.specter.onSettingsChanged((s) => setSettings(s)),
      window.specter.onTranscriptUpdate((u) => {
        if (u.kind === 'cleared') setTranscript([])
        else if (u.entry) setTranscript((t) => [...t, u.entry as TranscriptEntry])
      }),
      window.specter.onSessionChanged((s) => setSessionActive(!!s?.active)),
      window.specter.onAskEvent((e: AskEvent) => {
        if (e.type === 'delta') {
          setAnswerState('streaming')
          // adopt the ask id on the first delta (it can arrive before the invoke resolves)
          if (answerIdRef.current === null) answerIdRef.current = e.id
          setAnswer((a) => (answerIdRef.current === e.id ? a : '') + (e.text ?? ''))
          answerIdRef.current = e.id
        } else if (e.type === 'done') {
          setAnswerState('idle')
        } else if (e.type === 'error') {
          setAnswerState('error')
          setAskError(e.text ?? 'Unknown error')
        } else if (e.type === 'notice') {
          setNotice(e.text ?? '')
        }
      }),
      window.specter.onSuggestion((s) => setSuggestion(s)),
      window.specter.onAudioLevel((l) => {
        setLevels((prev) => (prev[l.role] === l.level ? prev : { ...prev, [l.role]: l.level }))
      }),
      window.specter.onTranscribing((u) => {
        setBusyLanes((prev) => ({ ...prev, [u.role]: u.busy }))
      }),
      window.specter.onShortcut((action) => {
        if (action === 'ask') setInput((v) => v)
        void window.specter.getSession().then(({ session, transcript: t }) => {
          setSessionActive(!!session?.active)
          setTranscript(t)
        })
      }),
      window.specter.onTranscriptUpdate(() => undefined)
    ]
    void window.specter.getSession().then(({ session, transcript: t }) => {
      setSessionActive(!!session?.active)
      setTranscript(t)
    })
    return () => offs.forEach((off) => off())
  }, [])

  // ---- audio lanes (refcounted manager: StrictMode re-runs reuse live lanes) ----
  useEffect(() => {
    if (!settings || !settings.hasApiKey) return
    let released = false
    void audioManager
      .acquire(
        {
          send: (payload) => void window.specter.transcribe(payload),
          onLevel: (role, level) => window.specter.emitAudioLevel(role, level),
          onStatus: (status) => setAudioStatus(status.them),
          onError: (_role, err) => setAudioError(err.message)
        },
        settings.micEnabled
      )
      .then(() => {
        if (released) return
        return window.specter.startSession().then(() => setSessionActive(true))
      })
    return () => {
      released = true
      void audioManager.release()
    }
  }, [settings?.hasApiKey, settings?.micEnabled])

  // ---- smart click-through: ignore mouse except over interactive elements ----
  useEffect(() => {
    let raf = 0
    let lastIgnore: boolean | null = null
    const onMove = (e: MouseEvent): void => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        const el = e.target as HTMLElement | null
        const interactive = !!el?.closest?.('[data-i]')
        if (lastIgnore !== !interactive) {
          lastIgnore = !interactive
          void window.specter.setIgnoreMouse(!interactive)
        }
      })
    }
    window.addEventListener('mousemove', onMove, true)
    return () => {
      window.removeEventListener('mousemove', onMove, true)
      if (raf) cancelAnimationFrame(raf)
      void window.specter.setIgnoreMouse(false)
    }
  }, [])

  // auto-scroll panes
  useEffect(() => {
    transcriptBoxRef.current?.scrollTo({ top: transcriptBoxRef.current.scrollHeight })
  }, [transcript])
  useEffect(() => {
    answerBoxRef.current?.scrollTo({ top: answerBoxRef.current.scrollHeight })
  }, [answer])

  const toggleExpanded = useCallback(async (): Promise<void> => {
    const next = !expanded
    setExpanded(next)
    await window.specter.setExpanded(next)
  }, [expanded])

  const ask = useCallback(
    async (includeScreen: boolean): Promise<void> => {
      if (!settings) return
      const prompt = input.trim()
      if (!prompt && !includeScreen) return
      setAnswer('')
      setAskError('')
      setNotice('')
      setAnswerState('streaming')
      const { id } = await window.specter.ask({
        prompt,
        mode: settings.mode,
        includeScreen,
        includeTranscript: settings.mode === 'meeting' || sessionActive,
        screenshot: undefined
      })
      answerIdRef.current = id
      setInput('')
    },
    [input, settings, sessionActive]
  )

  const captureAndAsk = useCallback(async (): Promise<void> => {
    if (!settings) return
    setAnswer('')
    setAskError('')
    setNotice('')
    setAnswerState('streaming')
    const { dataUrl } = await window.specter.captureScreenshot()
    const { id } = await window.specter.ask({
      prompt: input.trim(),
      mode: settings.mode,
      includeScreen: true,
      includeTranscript: true,
      screenshot: { dataUrl }
    })
    answerIdRef.current = id
    setInput('')
  }, [input, settings])

  const cancel = useCallback(async (): Promise<void> => {
    if (answerIdRef.current) await window.specter.cancelAsk(answerIdRef.current)
    setAnswerState('idle')
  }, [])

  const setMode = async (mode: Mode): Promise<void> => {
    if (!settings) return
    const s = await window.specter.saveSettings({ mode })
    setSettings(s)
  }

  const statusText =
    audioStatus === 'live'
      ? busyLanes.them || busyLanes.me
        ? 'Transcribing…'
        : sessionActive
          ? 'Listening'
          : 'Idle'
      : audioStatus === 'starting'
        ? 'Starting…'
        : audioStatus === 'error'
          ? 'Audio error'
          : settings?.hasApiKey
            ? 'Ready'
            : 'Add API key'

  if (!expanded) {
    return (
      <div className="pill" data-i>
        <div className="pill-drag" />
        <div className={`orb ${audioStatus === 'live' ? 'orb-live' : ''}`}>
          <span className="orb-core" />
          {audioStatus === 'live' && <span className="orb-ring" />}
        </div>
        <span className="pill-status">{statusText}</span>
        <div
          className="pill-meter"
          style={{ ['--level' as never]: String(Math.min(1, levels.them)) } as React.CSSProperties}
        />
        <button className="pbtn" data-i title="Expand (Ctrl+K)" onClick={() => void toggleExpanded()}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M3.5 5.75 8 10.25l4.5-4.5" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" />
          </svg>
        </button>
        {audioError && <span className="pill-err" title={audioError}>!</span>}
      </div>
    )
  }

  return (
    <div className="panel">
      <div className="panel-head" data-i>
        <div className="pill-drag" />
        <div className={`orb ${audioStatus === 'live' ? 'orb-live' : ''}`}>
          <span className="orb-core" />
          {audioStatus === 'live' && <span className="orb-ring" />}
        </div>
        <span className="panel-title">Specter</span>
        <span className={`chip chip-${settings?.mode ?? 'assist'}`}>{settings?.mode ?? 'assist'}</span>
        <span className="spacer" />
        <button className="pbtn" data-i title="Capture screen & ask (uses vision model)" onClick={() => void captureAndAsk()}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
            <rect x="1.5" y="3" width="13" height="9" rx="1.5" />
            <circle cx="8" cy="7.5" r="2.2" />
            <path d="M5.5 12.5 4 14.5M10.5 12.5 12 14.5" strokeLinecap="round" />
          </svg>
        </button>
        <button className="pbtn" data-i title="Collapse (Ctrl+K)" onClick={() => void toggleExpanded()}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M3.5 10.25 8 5.75l4.5 4.5" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {suggestion && (
        <div className="suggestion" data-i>
          <span className="suggestion-tag">live</span>
          <div className="suggestion-text">{suggestion.text}</div>
          <button className="pbtn" data-i onClick={() => setSuggestion(null)}>×</button>
        </div>
      )}

      <div className="panel-body">
        <div className="col transcript-col">
          <div className="col-label">
            Transcript
            {sessionActive && <span className="dot dot-live" title="session active" />}
            <span className="spacer" />
            <button
              className="pbtn"
              data-i
              title="Clear transcript (Ctrl+R)"
              onClick={() => void window.specter.clearTranscript()}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="1.5" fill="none">
                <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8h5.6l.7-8" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <div className="transcript" ref={transcriptBoxRef}>
            {transcript.length === 0 && (
              <div className="empty">Nothing yet. Specter transcribes speech from your system audio (and mic, if enabled) once people start talking.</div>
            )}
            {transcript.map((t) => (
              <div key={t.id} className={`line line-${t.role}`}>
                <span className="line-role">{t.role === 'me' ? 'You' : 'Them'}</span>
                <span className="line-text">{t.text}</span>
              </div>
            ))}
            {(busyLanes.them || busyLanes.me) && <div className="line line-transcribing">…</div>}
          </div>
        </div>

        <div className="col answer-col">
          <div className="col-label">
            Answer
            {answerState === 'streaming' && <span className="dot dot-streaming" />}
            <span className="spacer" />
            {answerState === 'streaming' && (
              <button className="pbtn" data-i onClick={() => void cancel()}>stop</button>
            )}
          </div>
          <div className="answer" ref={answerBoxRef}>
            {notice && <div className="notice">{notice}</div>}
            {answerState === 'error' && <div className="error">{askError}</div>}
            {answer ? (
              <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(answer) }} />
            ) : (
              <div className="empty">
                {settings?.hasApiKey
                  ? 'Ask anything, or press the camera button to let Specter look at your screen.'
                  : 'No Groq API key yet — open the dashboard to add one.'}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="input-row" data-i>
        <input
          data-i
          className="ask-input"
          placeholder="Ask Specter…  (Ctrl+Enter)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void ask(false)
          }}
        />
        <button className="send" data-i title="Send" onClick={() => void ask(false)}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M1.7 8 14 2 9.6 14 7.4 8.9 1.7 8Z" />
          </svg>
        </button>
      </div>

      <div className="panel-foot" data-i>
        {(['assist', 'meeting', 'interview', 'custom'] as Mode[]).map((m) => (
          <button
            key={m}
            className={`mode ${settings?.mode === m ? 'mode-active' : ''}`}
            data-i
            onClick={() => void setMode(m)}
          >
            {m}
          </button>
        ))}
        <span className="spacer" />
        <button className="pbtn" data-i title="Dashboard & settings" onClick={() => void window.specter.openDashboard()}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
            <circle cx="8" cy="8" r="2.4" />
            <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4" strokeLinecap="round" />
          </svg>
        </button>
        <button className="pbtn" data-i title="Hide overlay (Ctrl+\)" onClick={() => void window.specter.hideOverlay()}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M2.5 2.5l11 11M6.7 3.2A6.9 6.9 0 0 1 8 3.1c4 0 6.5 3.3 7 4.9-.3.8-1 2-2.2 3M9.6 9.8a2.3 2.3 0 0 1-3.3-3.2" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  )
}
