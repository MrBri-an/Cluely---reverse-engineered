import { contextBridge, ipcRenderer } from 'electron'
import type { SpecterApi } from '../shared/types'

const EVENT_CHANNELS = [
  'transcript:update',
  'transcript:transcribing',
  'session:changed',
  'chat:askEvent',
  'chat:cleared',
  'chat:askEventX',
  'suggest:new',
  'settings:changed',
  'audio:level',
  'shortcut',
  'overlay:visibility'
] as const

function on(channel: (typeof EVENT_CHANNELS)[number], cb: (payload: unknown) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: unknown): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.off(channel, listener)
}

const api: SpecterApi = {
  onTranscriptUpdate: (cb) => on('transcript:update', cb as never),
  onTranscribing: (cb) => on('transcript:transcribing', cb as never),
  onAskEvent: (cb) => on('chat:askEvent', cb as never),
  onSuggestion: (cb) => on('suggest:new', cb as never),
  onSettingsChanged: (cb) => on('settings:changed', cb as never),
  onSessionChanged: (cb) => on('session:changed', cb as never),
  onAudioLevel: (cb) => on('audio:level', cb as never),
  onShortcut: (cb) => on('shortcut', cb as never),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  setApiKey: (key) => ipcRenderer.invoke('key:set', key),
  clearApiKey: () => ipcRenderer.invoke('key:clear'),
  validateKey: () => ipcRenderer.invoke('key:validate'),
  listModels: () => ipcRenderer.invoke('models:list'),

  getSession: () => ipcRenderer.invoke('session:get'),
  startSession: () => ipcRenderer.invoke('session:start'),
  endSession: () => ipcRenderer.invoke('session:end'),
  clearTranscript: () => ipcRenderer.invoke('transcript:clear'),

  ask: (req) => ipcRenderer.invoke('chat:ask', req),
  cancelAsk: (id) => ipcRenderer.invoke('chat:cancel', id),

  setExpanded: (expanded) => ipcRenderer.invoke('overlay:setExpanded', expanded),
  moveBy: (dx, dy) => ipcRenderer.invoke('overlay:moveBy', dx, dy),
  setIgnoreMouse: (ignore) => ipcRenderer.invoke('overlay:setIgnoreMouse', ignore),
  hideOverlay: () => ipcRenderer.invoke('overlay:hide'),
  showOverlay: () => ipcRenderer.invoke('overlay:show'),
  openDashboard: () => ipcRenderer.invoke('app:openDashboard'),
  quitApp: () => ipcRenderer.invoke('app:quit'),

  captureScreenshot: () => ipcRenderer.invoke('screen:capture'),
  transcribe: (req) => ipcRenderer.invoke('stt:transcribe', req),
  emitAudioLevel: (role, level) => ipcRenderer.send('audio:level', { role, level }),

  platform: process.platform
}

contextBridge.exposeInMainWorld('specter', api)

export type { SpecterApi }
