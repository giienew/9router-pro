#!/usr/bin/env node

const { spawn, exec, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const https = require("https");
const os = require("os");

// Server-readiness probe, port cleanup, and restart budget live in
// testable modules — cli.js must never re-implement them inline, so the
// readiness result cannot silently go unchecked again (Pro issue #1).
const { waitServerReady, serverNotReadyLines } = require("./src/cli/utils/readiness");
const { killProcessOnPort } = require("./src/cli/utils/portCleanup");
const { createRestartBudget } = require("./src/cli/utils/restartBudget");

// Native spinner - no external dependency
function createSpinner(text) {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  let interval = null;
  let currentText = text;
  return {
    start() {
      if (process.stdout.isTTY) {
        process.stdout.write(`\r${frames[0]} ${currentText}`);
        interval = setInterval(() => {
          process.stdout.write(`\r${frames[i++ % frames.length]} ${currentText}`);
        }, 80);
      }
      return this;
    },
    stop() {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      if (process.stdout.isTTY) {
        process.stdout.write("\r\x1b[K");
      }
    },
    succeed(msg) {
      this.stop();
      console.log(`✅ ${msg}`);
    },
    fail(msg) {
      this.stop();
      console.log(`❌ ${msg}`);
    }
  };
}

const pkg = require("./package.json");
const { ensureSqliteRuntime, buildEnvWithRuntime } = require("./hooks/sqliteRuntime");
const { ensureTrayRuntime } = require("./hooks/trayRuntime");
const args = process.argv.slice(2);

// Subcommands (`9router xai video …`) run against an already-running gateway
// and bypass the launcher flow (no runtime self-heal, no server spawn).
if (args[0] === "xai" && args[1] === "video") {
  const { run } = require("./src/cli/commands/xaiVideo");
  run(args.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`❌ ${err?.message || err}`);
      process.exit(1);
    });
  return;
}

// `9router connect <url>` configures local CLI tools against a remote server, and
// `9router show` prints what they're currently set to — no local server, no
// runtime deps. Usable via `npx 9router …`. `doctor`/`setup`/`dry-run` are
// the same class: local-only diagnostics and previews, no server spawn.
if (args[0] === "connect" || args[0] === "show" || args[0] === "doctor" || args[0] === "setup" || args[0] === "dry-run") {
  const file = args[0] === "show" ? "./src/cli/commands/show"
    : args[0] === "connect" ? "./src/cli/commands/connect"
    : args[0] === "doctor" ? "./src/cli/commands/doctor"
    : args[0] === "setup" ? "./src/cli/commands/setup"
    : "./src/cli/commands/dryrun";
  const { run } = require(file);
  run(args.slice(1))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`❌ ${err?.message || err}`);
      process.exit(1);
    });
  return;
}

// Self-heal SQLite runtime deps (sql.js + better-sqlite3) into ~/.9router/runtime
// so the server can resolve them via NODE_PATH. Best-effort — sql.js is required,
// better-sqlite3 is optional. Logs to stderr only on failure.
try { ensureSqliteRuntime({ silent: true }); } catch {}

// Self-heal tray runtime (systray for macOS/Linux only). Windows skipped.
try { ensureTrayRuntime({ silent: true }); } catch {}

// Configuration constants
const APP_NAME = pkg.name; // Use from package.json
const INSTALL_CMD_LATEST = `npm i -g ${APP_NAME}@latest --prefer-online`;

const DEFAULT_PORT = 20127;
const DEFAULT_HOST = "0.0.0.0";

// First non-internal IPv4 — the address remote peers actually reach when bound to 0.0.0.0.
function getLanIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === "IPv4" && !i.internal) return i.address;
    }
  }
  return null;
}

// Local URL stays "localhost"; warn separately when bound to all interfaces (network-exposed).
function getDisplayHost() {
  return host === DEFAULT_HOST ? "localhost" : host;
}
const MAX_PORT_ATTEMPTS = 10;
// Identifiers for killAllAppProcesses - only kill 9router specifically
const PROCESS_IDENTIFIERS = [
  '9router'  // Only package name - avoid killing other apps
];

// Parse arguments
let port = DEFAULT_PORT;
let host = DEFAULT_HOST;
let noBrowser = false;
let skipUpdate = false;
let showLog = false;
let trayMode = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port" || args[i] === "-p") {
    port = parseInt(args[i + 1], 10) || DEFAULT_PORT;
    i++;
  } else if (args[i] === "--host" || args[i] === "-H") {
    host = args[i + 1] || DEFAULT_HOST;
    i++;
  } else if (args[i] === "--no-browser" || args[i] === "-n") {
    noBrowser = true;
  } else if (args[i] === "--log" || args[i] === "-l") {
    showLog = true;
  } else if (args[i] === "--skip-update") {
    skipUpdate = true;
  } else if (args[i] === "--tray" || args[i] === "-t") {
    trayMode = true;
    process.env.TRAY_MODE = "1";
  } else if (args[i] === "--help" || args[i] === "-h") {
    console.log(`
Usage: ${APP_NAME} [options]

Options:
  -p, --port <port>   Port to run the server (default: ${DEFAULT_PORT})
  -H, --host <host>   Host to bind (default: ${DEFAULT_HOST})
  -n, --no-browser    Don't open browser automatically
  -l, --log           Show server logs (default: hidden)
  -t, --tray          Run in system tray mode (background)
  --skip-update       Skip auto-update check
  -h, --help          Show this help message
  -v, --version       Show version

Commands:
  connect <server-url> Configure Claude Code for a remote 9router server
                      (npx 9router connect http://host:20127 — no install needed)
  show [tool…]        Show each CLI tool's current 9router config and models
                      (e.g. 9router show claude)
  doctor [--port n]   Diagnose this install (Node, port, config, server health)
  setup [--port n]    Guided first-run wizard (port + password, previewed first)
  dry-run --url <u>   Preview what 'connect' would write, without writing
  xai video --prompt "..." --output video.mp4
                      Generate a Grok Imagine video via the running gateway
                      (see: ${APP_NAME} xai video --help)
`);
    process.exit(0);
  } else if (args[i] === "--version" || args[i] === "-v") {
    console.log(pkg.version);
    process.exit(0);
  }
}

// Auto-relaunch after update: detached process has no TTY → fallback to tray
if (skipUpdate && !trayMode && !process.stdin.isTTY) {
  trayMode = true;
  process.env.TRAY_MODE = "1";
}

// Always use Node.js runtime with absolute path
const RUNTIME = process.execPath;

// Compare semver versions: returns 1 if a > b, -1 if a < b, 0 if equal
function compareVersions(a, b) {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (partsA[i] > partsB[i]) return 1;
    if (partsA[i] < partsB[i]) return -1;
  }
  return 0;
}

// Get app data dir (matches app/src/lib/dataDir.js convention)
function getAppDataDir() {
  return process.platform === "win32"
    ? path.join(process.env.APPDATA || "", "9router")
    : path.join(os.homedir(), ".9router");
}

// Kill PID from file (best-effort, removes file after)
function killByPidFile(pidFile) {
  try {
    if (!fs.existsSync(pidFile)) return;
    const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
    if (!pid) return;
    try {
      if (process.platform === "win32") {
        execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore", windowsHide: true, timeout: 3000 });
      } else {
        process.kill(pid, "SIGKILL");
      }
    } catch { }
    try { fs.unlinkSync(pidFile); } catch { }
  } catch { }
}

// Kill tunnel processes (cloudflared/tailscale) by their PID files
function killTunnelByPidFile() {
  const tunnelDir = path.join(getAppDataDir(), "tunnel");
  killByPidFile(path.join(tunnelDir, "cloudflared.pid"));
  killByPidFile(path.join(tunnelDir, "tailscale.pid"));
}

// Kill cloudflared whose --url targets this app's port (covers stale PID file case)
function killCloudflaredByAppPort(appPort) {
  if (!appPort) return [];
  const portMatchers = [`localhost:${appPort}`, `127.0.0.1:${appPort}`];
  const pids = [];
  try {
    if (process.platform === "win32") {
      const psCmd = `powershell -NonInteractive -WindowStyle Hidden -Command "Get-WmiObject Win32_Process -Filter 'Name=\\"cloudflared.exe\\"' | Select-Object ProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation"`;
      const output = execSync(psCmd, { encoding: "utf8", windowsHide: true, timeout: 5000 });
      const lines = output.split("\n").slice(1).filter(l => l.trim());
      lines.forEach(line => {
        if (portMatchers.some(m => line.includes(m))) {
          const match = line.match(/^"(\d+)"/);
          if (match && match[1]) pids.push(match[1]);
        }
      });
    } else {
      const output = execSync("ps -eo pid,command 2>/dev/null", { encoding: "utf8", timeout: 5000 });
      output.split("\n").forEach(line => {
        if (line.includes("cloudflared") && portMatchers.some(m => line.includes(m))) {
          const parts = line.trim().split(/\s+/);
          const pid = parts[0];
          if (pid && !isNaN(pid)) pids.push(pid);
        }
      });
    }
  } catch { }
  return pids;
}

// Kill all 9router processes
function killAllAppProcesses(appPort) {
  return new Promise((resolve) => {
    try {
      // Background: MITM + tunnel/cloudflared run on separate ports/processes —
      // killing them doesn't free the app port, so don't block the critical path.
      // Server-side MITM manager has stale-lock recovery and starts deferred (~3s).
      setImmediate(() => {
        try { killProxyByPidFile(); } catch {}
        try { killTunnelByPidFile(); } catch {}
        try { killCloudflaredByAppPort(appPort); } catch {}
      });

      const platform = process.platform;
      let pids = [];

      if (platform === "win32") {
        // Windows: use WMI to get full CommandLine (tasklist /V doesn't include it)
        try {
          const psCmd = `powershell -NonInteractive -WindowStyle Hidden -Command "Get-WmiObject Win32_Process -Filter 'Name=\\"node.exe\\"' | Select-Object ProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation"`;
          const output = execSync(psCmd, {
            encoding: "utf8",
            windowsHide: true,
            timeout: 5000
          });
          const lines = output.split("\n").slice(1).filter(l => l.trim());
          lines.forEach(line => {
            // Whitelist: real node process running 9router/cli.js, or next-server.
            // Avoids killing editors/grep/strace/cursor that just have "9router" in cmdline.
            const cmd = line.toLowerCase();
            const isAppProcess =
              (cmd.includes("node") && cmd.includes("9router") && (cmd.includes("cli.js") || cmd.includes("\\9router") || cmd.includes("/9router")))
              || cmd.includes("next-server");
            if (isAppProcess) {
              const match = line.match(/^"(\d+)"/);
              if (match && match[1] && match[1] !== process.pid.toString()) {
                pids.push(match[1]);
              }
            }
          });
        } catch (e) {
          // No processes found or error - continue
        }
      } else {
        // macOS/Linux: use ps to find all matching processes
        try {
          const output = execSync('ps aux 2>/dev/null', {
            encoding: 'utf8',
            timeout: 5000
          });
          const lines = output.split('\n');

          lines.forEach(line => {
            // Whitelist: real node process running 9router/cli.js, or next-server.
            // Avoids killing grep/strace/editors/cursor that incidentally match "9router".
            const cmd = line.toLowerCase();
            const isAppProcess =
              (cmd.includes("node") && cmd.includes("9router") && (cmd.includes("cli.js") || cmd.includes("/9router")))
              || cmd.includes("next-server");
            if (isAppProcess) {
              const parts = line.trim().split(/\s+/);
              const pid = parts[1];
              if (pid && !isNaN(pid) && pid !== process.pid.toString()) {
                pids.push(pid);
              }
            }
          });
        } catch (e) {
          // No processes found or error - continue
        }
      }

      // Kill all found processes
      if (pids.length > 0) {
        pids.forEach(pid => {
          try {
            if (platform === "win32") {
              execSync(`taskkill /F /PID ${pid} 2>nul`, { stdio: 'ignore', shell: true, windowsHide: true, timeout: 3000 });
            } else {
              execSync(`kill -9 ${pid} 2>/dev/null`, { stdio: 'ignore', timeout: 3000 });
            }
          } catch (err) {
            // Process already dead or can't kill - continue
          }
        });

        // Wait for processes to fully terminate
        setTimeout(() => resolve(), 1000);
      } else {
        resolve();
      }
    } catch (err) {
      // Silent fail - continue anyway
      resolve();
    }
  });
}

// Sleep helper using SharedArrayBuffer wait (sync, no busy-loop)
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* ignore */ }
}

// Wait until process dies or timeout reached
function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return true; }
    sleepSync(100);
  }
  return false;
}

// Kill MIT server by PID file (runs privileged, needs special handling)
// Sends SIGTERM first so MIT can clean up host entries before dying.
function killProxyByPidFile() {
  try {
    const pidFile = path.join(getAppDataDir(), "mitm", ".mitm.pid");
    if (!fs.existsSync(pidFile)) return;
    const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
    if (!pid) return;

    if (process.platform === "win32") {
      // Graceful first (lets server cleanup hosts), then force
      try { execSync(`taskkill /T /PID ${pid}`, { stdio: "ignore", windowsHide: true, timeout: 2000 }); } catch { }
      if (!waitForExit(pid, 1500)) {
        try { execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore", windowsHide: true, timeout: 3000 }); } catch { }
      }
      // Last-resort: PowerShell Stop-Process (sometimes succeeds where taskkill fails on admin processes)
      if (!waitForExit(pid, 500)) {
        try { execSync(`powershell -NonInteractive -WindowStyle Hidden -Command "Stop-Process -Id ${pid} -Force"`, { stdio: "ignore", windowsHide: true, timeout: 3000 }); } catch { }
      }
    } else {
      // SIGTERM via cached sudo token first
      try { execSync(`sudo -n kill -TERM ${pid} 2>/dev/null`, { stdio: "ignore", timeout: 2000 }); }
      catch { try { process.kill(pid, "SIGTERM"); } catch { } }
      if (!waitForExit(pid, 1500)) {
        try { execSync(`sudo -n kill -9 ${pid} 2>/dev/null`, { stdio: "ignore", timeout: 2000 }); }
        catch { try { process.kill(pid, "SIGKILL"); } catch { } }
      }
    }
    try { fs.unlinkSync(pidFile); } catch { }
  } catch { }
}

// Detect if running in restricted environment (Codespaces, Docker)
function isRestrictedEnvironment() {
  // Check for Codespaces
  if (process.env.CODESPACES === "true" || process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN) {
    return "GitHub Codespaces";
  }

  // Check for Docker
  if (fs.existsSync("/.dockerenv") || (fs.existsSync("/proc/1/cgroup") && fs.readFileSync("/proc/1/cgroup", "utf8").includes("docker"))) {
    return "Docker";
  }

  return null;
}

// Check if new version available, return latest version or null
function checkForUpdate() {
  return new Promise((resolve) => {
    if (skipUpdate) {
      resolve(null);
      return;
    }

    const spinner = createSpinner("Checking for updates...").start();
    let resolved = false;

    const safetyTimeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        spinner.stop();
        resolve(null);
      }
    }, 8000);

    const done = (version) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(safetyTimeout);
      spinner.stop();
      resolve(version);
    };

    const req = https.get(`https://registry.npmjs.org/${pkg.name}/latest`, { timeout: 3000 }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const latest = JSON.parse(data);
          if (latest.version && compareVersions(latest.version, pkg.version) > 0) {
            done(latest.version);
          } else {
            done(null);
          }
        } catch (e) {
          done(null);
        }
      });
    });

    req.on("error", () => done(null));
    req.on("timeout", () => { req.destroy(); done(null); });
  });
}

// Open browser
function openBrowser(url) {
  const platform = process.platform;
  let cmd;

  if (platform === "darwin") {
    cmd = `open "${url}"`;
  } else if (platform === "win32") {
    cmd = `start "" "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }

  exec(cmd, { windowsHide: true }, (err) => {
    if (err) {
      console.log(`Open browser manually: ${url}`);
    }
  });
}

// Find standalone server. Prefer the CLI-bundled app/ build (pack:cli
// flow), but fall back to the root pack's .next/standalone build — that
// build ships in every root npm install, while cli/app only exists when
// the CLI bundle was built separately. Without the fallback a clean
// root-pack install could start the CLI but never serve. Prefer
// custom-server.js (injects real socket IP) when present in either dir.
function resolveServerEntry() {
  const candidates = [
    path.join(__dirname, "app"),
    path.join(__dirname, "..", ".next", "standalone"),
  ];
  for (const dir of candidates) {
    const custom = path.join(dir, "custom-server.js");
    if (fs.existsSync(custom)) return { dir, serverPath: custom };
    const server = path.join(dir, "server.js");
    if (fs.existsSync(server)) return { dir, serverPath: server };
  }
  return null;
}
const serverEntry = resolveServerEntry();
if (!serverEntry) {
  console.error("Error: Standalone build not found.");
  console.error("Reinstall 9router-pro (npm i -g 9router-pro) or build the CLI bundle first (npm run build inside cli/).");
  process.exit(1);
}
const standaloneDir = serverEntry.dir;
const serverPath = serverEntry.serverPath;

// Start server immediately; run update check in parallel (not on the critical path).
const updatePromise = checkForUpdate();
killAllAppProcesses(port)
  .then(() => killProcessOnPort(port))
  .then(() => startServer(updatePromise));

// Show interface selection menu
async function showInterfaceMenu(latestVersion) {
  const { selectMenu } = require("./src/cli/utils/input");
  const { clearScreen } = require("./src/cli/utils/display");
  const { getEndpoint } = require("./src/cli/utils/endpoint");

  clearScreen();

  const displayHost = getDisplayHost();

  // Detect tunnel/local mode for server URL display
  let serverUrl;
  try {
    const { endpoint, tunnelEnabled } = await getEndpoint(port);
    serverUrl = tunnelEnabled ? endpoint.replace(/\/v1$/, "") : `http://${displayHost}:${port}`;
  } catch (e) {
    serverUrl = `http://${displayHost}:${port}`;
  }

  const subtitle = `🚀 Server: \x1b[32m${serverUrl}\x1b[0m`;

  const menuItems = [];

  if (latestVersion) {
    menuItems.push({ label: `Update to v${latestVersion} (current: v${pkg.version})`, icon: "⬆" });
  }

  menuItems.push(
    { label: "Web UI (Open in Browser)", icon: "🌐" },
    { label: "Terminal UI (Interactive CLI)", icon: "💻" },
    { label: "Hide to Tray (Background)", icon: "🔔" },
    { label: "Exit", icon: "🚪" }
  );

  const selected = await selectMenu(`Choose Interface (v${pkg.version})`, menuItems, 0, subtitle);

  const offset = latestVersion ? 1 : 0;

  if (latestVersion && selected === 0) return "update";
  if (selected === offset) return "web";
  if (selected === offset + 1) return "terminal";
  if (selected === offset + 2) return "hide";
  return "exit";
}

const MAX_RESTARTS = 2;
const RESTART_RESET_MS = 30000; // Reset counter if alive > 30s

function startServer(updatePromise) {
  // Accept either a Promise (parallel update check) or a resolved value.
  const latestVersionPromise = Promise.resolve(updatePromise);
  const displayHost = getDisplayHost();
  const url = `http://${displayHost}:${port}/dashboard`;
  // Surface real network exposure when bound to all interfaces (default 0.0.0.0).
  if (host === DEFAULT_HOST) {
    const lanIp = getLanIp();
    if (lanIp) console.log(`\x1b[33m⚠ Network-exposed: reachable at http://${lanIp}:${port} (bound 0.0.0.0). Use --host 127.0.0.1 for local-only.\x1b[0m`);
  }

  // Restart budget: a permanently crashing server reaches a visible
  // terminal state instead of respawning forever (see tryRestart).
  const restartBudget = createRestartBudget({ maxRestarts: MAX_RESTARTS, resetMs: RESTART_RESET_MS });
  let serverStartTime = Date.now();

  const CRASH_LOG_LINES = 50;
  let crashLog = [];

  function spawnServer() {
    serverStartTime = Date.now();
    crashLog = [];
    const child = spawn(RUNTIME, ["--dns-result-order=ipv4first", "--max-old-space-size=6144", serverPath], {
      cwd: standaloneDir,
      stdio: showLog ? "inherit" : ["ignore", "ignore", "pipe"],
      detached: true,
      windowsHide: true,
      env: {
        ...buildEnvWithRuntime(process.env),
        PORT: port.toString(),
        HOSTNAME: host
      }
    });
    if (!showLog && child.stderr) {
      child.stderr.on("data", (data) => {
        const lines = data.toString().split("\n").filter(Boolean);
        crashLog.push(...lines);
        if (crashLog.length > CRASH_LOG_LINES) crashLog = crashLog.slice(-CRASH_LOG_LINES);
      });
    }
    return child;
  }

  let server = spawnServer();

  // Attach crash/close handling here, not at the end of startServer: the
  // tray branch returns early, so a call at the end would never run in
  // tray mode — the mode most users actually run — and a crashing server
  // would sit dead with no restart and no message at all.
  attachServerEvents();

  // Cleanup function - force kill server process
  let isCleaningUp = false;
  function cleanup() {
    if (isCleaningUp) return;
    isCleaningUp = true;
    try {
      // Kill tray if running
      try {
        const { killTray } = require("./src/cli/tray/tray");
        killTray();
      } catch (e) { }
      // Kill MIT server (privileged process) via PID file
      killProxyByPidFile();
      // Kill cloudflared/tailscale via PID file (only this app's tunnel)
      killTunnelByPidFile();
      // Kill server process directly
      if (server.pid) {
        process.kill(server.pid, "SIGKILL");
      }
      // Also try to kill process group
      process.kill(-server.pid, "SIGKILL");
    } catch (e) { }
  }

  // Suppress all errors during shutdown (systray lib throws JSON parse errors)
  let isShuttingDown = false;
  process.on("uncaughtException", (err) => {
    if (isShuttingDown) return;
    console.error("Error:", err.message);
  });

  // Handle all exit scenarios
  process.on("SIGINT", () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log("\nExiting...");
    cleanup();
    setTimeout(() => process.exit(0), 100);
  });
  process.on("SIGTERM", () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    cleanup();
    setTimeout(() => process.exit(0), 100);
  });
  process.on("SIGHUP", () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    cleanup();
    setTimeout(() => process.exit(0), 100);
  });

  // Initialize tray icon (runs alongside TUI)
  const initTrayIcon = () => {
    try {
      const { initTray } = require("./src/cli/tray/tray");
      initTray({
        port,
        onQuit: () => {
          isShuttingDown = true;
          console.log("\n👋 Shutting down from tray...");
          cleanup();
          setTimeout(() => process.exit(0), 100);
        },
        onOpenDashboard: () => openBrowser(url)
      });
    } catch (err) {
      // Tray not available - continue without it
    }
  };

  // Tray-only mode: no TUI, just tray icon
  if (trayMode) {
    // Ignore SIGHUP so macOS terminal close doesn't kill the background tray process
    process.removeAllListeners("SIGHUP");
    process.on("SIGHUP", () => {});

    console.log(`\n🚀 ${pkg.name} v${pkg.version}`);
    console.log(`Server: http://${displayHost}:${port}`);

    waitServerReady(port).then((ready) => {
      if (!ready) {
        // Never claim "running" when nothing is listening: the tray menu
        // itself says "Server is running", so do not init it — print the
        // failure plainly and exit instead.
        serverNotReadyLines(port).forEach((line) => console.error(line));
        isShuttingDown = true;
        cleanup();
        process.exit(1);
        return;
      }
      initTrayIcon();
      console.log("\n💡 Router is now running in system tray. Close this terminal if you want.");
      console.log("   Right-click tray icon to open dashboard or quit.\n");
    });

    return;
  }

  // Wait for server to be ready, then show interface menu loop + tray.
  // If it never comes up, say so and exit — the menu's "Server: <url>"
  // subtitle would otherwise claim a dead server is up.
  waitServerReady(port).then(async (ready) => {
    if (!ready) {
      serverNotReadyLines(port).forEach((line) => console.error(line));
      isShuttingDown = true;
      cleanup();
      process.exit(1);
      return;
    }
    // Resolve parallel update check (already running); don't block server start on it.
    const latestVersion = await latestVersionPromise;
    // Start tray icon alongside TUI
    initTrayIcon();

    try {
      while (true) {
        const choice = await showInterfaceMenu(latestVersion);

        if (choice === "update") {
          isShuttingDown = true;
          const { clearScreen } = require("./src/cli/utils/display");
          clearScreen();
          console.log(`\n⬆  Update v${pkg.version} → v${latestVersion}\n`);
          console.log(`Run this after exit:\n`);
          console.log(`   \x1b[33m${INSTALL_CMD_LATEST}\x1b[0m\n`);
          cleanup();
          await killAllAppProcesses(port);
          await killProcessOnPort(port);
          setTimeout(() => process.exit(0), 200);
          return;
        } else if (choice === "web") {
          openBrowser(url);
          // Wait for user to come back
          const { pause } = require("./src/cli/utils/input");
          await pause("\nPress Enter to go back to menu...");
        } else if (choice === "terminal") {
          // Start Terminal UI - it will return when user selects Back
          const { startTerminalUI } = require("./src/cli/terminalUI");
          await startTerminalUI(port);
          // Loop continues, show menu again
        } else if (choice === "hide") {
          const { clearScreen } = require("./src/cli/utils/display");
          clearScreen();

          // Enable auto startup on OS boot
          try {
            const { enableAutoStart } = require("./src/cli/tray/autostart");
            enableAutoStart(__filename);
          } catch (e) { }

          if (process.platform === "darwin") {
            // macOS: keep current process alive — spawning a detached child puts
            // it outside the login session so NSStatusItem silently fails.
            process.removeAllListeners("SIGHUP");
            process.on("SIGHUP", () => {});

            console.log(`\n⏳ Switching to tray mode... (icon already visible in menu bar)`);
            console.log(`🔔 9Router is running in tray (PID: ${process.pid})`);
            console.log(`   Server: http://${displayHost}:${port}`);
            console.log(`\n💡 You can close this terminal. Right-click tray icon to quit.\n`);

            // Tray already init'd at startup — just keep event loop alive.
            return;
          }

          // Windows/Linux: spawn detached bgProcess (systray works fine in child)
          console.log(`\n⏳ Starting background process... (tray icon will appear in ~3s)`);

          const bgProcess = spawn(process.execPath, ["--dns-result-order=ipv4first", __filename, "--tray", "--skip-update", "-p", port.toString()], {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
            env: { ...process.env }
          });
          bgProcess.unref();

          // cleanup() kills server so bgProcess can claim the port fresh.
          // The child prints its own failure if its server never comes up,
          // but its stdio is discarded — so verify readiness here before
          // claiming "running": the parent is the only voice the user hears.
          cleanup();
          const bgReady = await waitServerReady(port);
          if (!bgReady) {
            serverNotReadyLines(port).forEach((line) => console.error(line));
            process.exit(1);
          }

          console.log(`🔔 9Router is now running in background (PID: ${bgProcess.pid})`);
          console.log(`   Server: http://${displayHost}:${port}`);
          console.log(`\n💡 You can close this terminal. Right-click tray icon to quit.\n`);

          process.exit(0);
        } else if (choice === "exit") {
          isShuttingDown = true;
          console.log("\nExiting...");
          cleanup();
          setTimeout(() => process.exit(0), 100);
        }
      }
    } catch (err) {
      console.error("Error:", err.message);
      cleanup();
      process.exit(1);
    }
  });

  function attachServerEvents() {
    server.on("error", (err) => {
      console.error("Failed to start server:", err.message);
      if (!isShuttingDown) tryRestart();
      else { cleanup(); process.exit(1); }
    });

    server.on("close", (code) => {
      if (isShuttingDown || code === 0) {
        process.exit(code || 0);
        return;
      }
      tryRestart(code);
    });
  }

  function tryRestart(code) {
    const aliveMs = Date.now() - serverStartTime;
    const decision = restartBudget.recordCrash(aliveMs);

    if (decision.action === "terminal") {
      // The server keeps crashing even after the MITM-disable reset: stop
      // respawning and say so plainly instead of looping forever while the
      // CLI claims to be running.
      console.error(`\n❌ Server keeps crashing — stopped respawning. The router is NOT running.`);
      if (crashLog.length) {
        console.error("\n--- Last server output ---");
        crashLog.forEach(l => console.error(l));
        console.error("--- End server output ---\n");
      } else {
        console.error("   (No server output was captured; rerun with --log to see it.)");
      }
      console.error(`   Diagnose it with: 9router-pro doctor --port ${port}`);
      console.error(`   Then free the port if something stale holds it: fuser -k ${port}/tcp`);
      isShuttingDown = true;
      cleanup();
      process.exit(1);
      return;
    }

    if (decision.action === "mitm-reset") {
      console.error(`\n⚠️  Server crashed ${MAX_RESTARTS} times. Disabling MIT and restarting...`);
      try {
        const dbPath = path.join(os.homedir(), process.platform === "win32" ? path.join("AppData", "Roaming", "9router", "db.json") : path.join(".9router", "db.json"));
        if (fs.existsSync(dbPath)) {
          const db = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
          if (db.settings) db.settings.mitmEnabled = false;
          fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
        }
      } catch { /* best effort */ }
      server = spawnServer();
      attachServerEvents();
      return;
    }

    const delay = decision.delayMs;
    console.error(`\n⚠️  Server exited (code=${code ?? "unknown"}). Restarting in ${delay / 1000}s... (${decision.attempt}/${MAX_RESTARTS})`);
    if (crashLog.length) {
      console.error("\n--- Server crash log ---");
      crashLog.forEach(l => console.error(l));
      console.error("--- End crash log ---\n");
    }

    setTimeout(() => {
      server = spawnServer();
      attachServerEvents();
    }, delay);
  }
}
