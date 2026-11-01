// Launches the built app in smoke mode (windows created but never shown),
// waits for the SPECTER_SMOKE_OK marker, then exits.
const { spawn } = require('child_process')
const path = require('path')

const electronPath = require('electron')
const appRoot = path.resolve(__dirname, '..')

const child = spawn(electronPath, [path.join(appRoot, 'out/main/index.js')], {
  env: { ...process.env, SPECTER_SMOKE: '1', ELECTRON_ENABLE_LOGGING: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
})

let out = ''
let settled = false
const timer = setTimeout(() => {
  if (!settled) {
    settled = true
    console.error('SMOKE_FAIL: timeout, output so far:\n' + out)
    child.kill()
    process.exit(1)
  }
}, 45000)

const onData = (d) => {
  out += d.toString()
  process.stdout.write(d)
  if (out.includes('SPECTER_SMOKE_OK') && !settled) {
    settled = true
    clearTimeout(timer)
    setTimeout(() => {
      child.kill()
      process.exit(0)
    }, 300)
  }
}

child.stdout.on('data', onData)
child.stderr.on('data', onData)
child.on('exit', (code) => {
  if (!settled) {
    settled = true
    clearTimeout(timer)
    console.error(`SMOKE_FAIL: exited early with code ${code}`)
    process.exit(1)
  }
})
