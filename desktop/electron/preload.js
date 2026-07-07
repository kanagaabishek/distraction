// Preload — the only bridge exposed to the renderer. No Node access leaks in.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('terrace', {
  // renderer -> worker
  send: (msg) => ipcRenderer.invoke('terrace:cmd', msg),
  // worker -> renderer
  onEvent: (cb) => {
    const h = (_e, m) => cb(m)
    ipcRenderer.on('terrace:event', h)
    return () => ipcRenderer.removeListener('terrace:event', h)
  }
})
