// Electron main (Phase 4b) — mirrors the hello-pear-electron shape:
//   renderer <-> preload (window.terrace) <-> THIS main <-> worker.
//
// Deviation from hello-pear-electron (documented in README): the worker is a Node fork,
// not a pear-runtime Bare worker, because the assembled core needs Node (WDK + ethers +
// QVAC client). QVAC still runs its own Bare worker internally. The worker is spawned with
// the system `node` (execPath) so it gets Node >= 22.17 that QVAC requires.

const { app, BrowserWindow, ipcMain } = require('electron')
const { fork } = require('node:child_process')
const path = require('node:path')

const WORKER = path.join(__dirname, '..', 'worker', 'terrace-worker.mjs')
const NODE = process.env.TERRACE_NODE || 'node' // must be >= 22.17 for QVAC

let win = null
let worker = null

function startWorker () {
  worker = fork(WORKER, [], {
    execPath: NODE,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env }
  })
  worker.on('message', (m) => { if (win && !win.isDestroyed()) win.webContents.send('terrace:event', m) })
  worker.stderr.on('data', (d) => {
    const s = d.toString()
    if (!/Downloading|downloading|QVACRegistryClient/.test(s)) process.stderr.write('[worker] ' + s)
  })
  worker.on('exit', (code) => { if (win && !win.isDestroyed()) win.webContents.send('terrace:event', { evt: 'error', msg: 'worker exited ' + code }) })
}

function createWindow () {
  win = new BrowserWindow({
    width: 1040,
    height: 760,
    title: 'Terrace',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
}

// renderer -> worker
ipcMain.handle('terrace:cmd', (_e, msg) => { worker?.send(msg); return true })

app.whenReady().then(() => {
  startWorker()
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { worker?.kill(); if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', () => worker?.kill())
