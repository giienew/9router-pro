// Electron shell (R15, thin wrapper only) — NOT a native build pipeline.
// Reuses the existing start path: it spawns `node custom-server.js`
// (the same entry `npm start` uses) and opens the dashboard in a window.
// Build/packaging (electron-builder config, signing, auto-update) is
// deliberately out of scope for this run — see docs/rival-packaging.md.
// To try it: npm i -D electron && node -e "require('electron')" —
// this file is the main entry (package.json electron.main is NOT wired
// up, so nothing changes for npm/PM2/Docker installs).
// eslint-disable-next-line no-undef
const { app, BrowserWindow } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");

const PORT = Number(process.env.PORT) || 20127;
const ROOT = path.join(__dirname, "..", "..");
let server = null;
let win = null;

function startServer() {
  return new Promise((resolve) => {
    server = spawn(process.execPath, ["custom-server.js", "--port", String(PORT)], {
      cwd: ROOT, stdio: "ignore", detached: false,
    });
    // Poll the health endpoint instead of a fixed sleep.
    const deadline = Date.now() + 30000;
    const tick = () => {
      fetch(`http://127.0.0.1:${PORT}/api/health`)
        .then((r) => (r.ok ? resolve(true) : Date.now() > deadline ? resolve(false) : setTimeout(tick, 250)))
        .catch(() => (Date.now() > deadline ? resolve(false) : setTimeout(tick, 250)));
    };
    tick();
  });
}

async function createWindow() {
  await startServer();
  win = new BrowserWindow({
    width: 1280, height: 860,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(`http://127.0.0.1:${PORT}/dashboard/endpoint`);
  win.on("closed", () => { win = null; });
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  if (server) server.kill();
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", () => { if (server) server.kill(); });
