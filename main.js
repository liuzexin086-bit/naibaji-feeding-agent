const { app, BrowserWindow } = require('electron')
const path = require('path')
const { startBackend } = require('./backend/src/server')

let backendHandle = null

async function createWindow() {
  if (!backendHandle) {
    backendHandle = await startBackend({ dataDir: path.join(app.getPath('userData'), 'data') })
  }

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    title: '奶爸机 — 超早期断奶数据采集',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  win.loadFile(path.join(__dirname, 'index.html'), {
    query: { api: backendHandle.url },
  })
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', async () => {
  if (backendHandle && backendHandle.close) {
    await backendHandle.close()
    backendHandle = null
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})
