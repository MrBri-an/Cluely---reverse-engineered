// Lists every model ID visible to the stored key. Run: electron scripts/list-models.js
const { app, safeStorage } = require('electron')
const fs = require('fs')
const path = require('path')

app.setPath('userData', path.join(app.getPath('appData'), 'specter'))
app.whenReady().then(async () => {
  try {
    const buf = fs.readFileSync(path.join(app.getPath('userData'), 'specter-key.bin'))
    const key = safeStorage.decryptString(buf)
    const res = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${key}` }
    })
    const data = await res.json()
    for (const m of data.data ?? []) {
      console.log(`${m.id}  | ctx:${m.context_window ?? '?'}  | active:${m.active ?? '?'}`)
    }
  } catch (e) {
    console.error('LIST_FAIL', e.message)
  }
  app.exit(0)
})
