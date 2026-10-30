/**
 * `9router setup` — guided first-run wizard. Asks for the server port and
 * (optionally) a dashboard password, shows the EXACT file content that
 * would be written (password masked in the preview), and writes .env.local
 * in the current directory only after confirmation. Refuses to overwrite
 * an existing .env.local without --force. Never prints the password.
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const HELP = `
Usage: 9router setup [--force] [--port <n>]

Guided first-run setup: port + dashboard password, previewed before writing.

  9router setup               # interactive wizard
  9router setup --port 20127  # skip the port question
  9router setup --force       # overwrite an existing .env.local
`;

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, (a) => resolve(a.trim())));
}

// Masked prompt: echoes '*' per keystroke (raw mode), restores on done.
function askSecret(rl, question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    stdout.write(question);
    let value = "";
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    const onData = (chunk) => {
      const s = chunk.toString("utf8");
      for (const ch of s) {
        if (ch === "\r" || ch === "\n") {
          stdout.write("\n");
          if (stdin.isTTY) stdin.setRawMode(!!wasRaw);
          stdin.pause();
          stdin.removeListener("data", onData);
          resolve(value);
          return;
        }
        if (ch === "\u0003") { // Ctrl-C
          if (stdin.isTTY) stdin.setRawMode(!!wasRaw);
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") {
          if (value.length) { value = value.slice(0, -1); stdout.write("\b \b"); }
        } else if (ch >= " ") {
          value += ch;
          stdout.write("*");
        }
      }
    };
    stdin.on("data", onData);
    rl.pause();
  });
}

async function run(argv) {
  const opts = { force: false, port: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force") opts.force = true;
    else if (a === "--port") {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) throw new Error("Invalid --port value");
      opts.port = v;
    } else if (a === "-h" || a === "--help") { console.log(HELP); return 0; }
    else throw new Error(`Unknown option: ${a}`);
  }

  const target = path.join(process.cwd(), ".env.local");
  if (fs.existsSync(target) && !opts.force) {
    console.error(`❌ ${target} already exists. Re-run with --force to overwrite, or delete it first.`);
    return 1;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("\n9Router Pro setup — guided wizard (nothing is written until you confirm).\n");
  let port = opts.port;
  if (!port) {
    const answer = await ask(rl, "Server port [3000]: ");
    port = answer ? Number(answer) : 3000;
    if (!Number.isFinite(port) || port <= 0) { rl.close(); throw new Error("Invalid port"); }
  }
  const password = await askSecret(rl, "Dashboard password (empty = keep the built-in default, change it later from the dashboard): ");
  rl.close();

  const lines = [`PORT=${port}`];
  if (password) lines.push(`INITIAL_PASSWORD=<your password, as typed>`);
  const content = lines.join("\n") + "\n";
  const realContent = [`PORT=${port}`, ...(password ? [`INITIAL_PASSWORD=${password}`] : [])].join("\n") + "\n";

  console.log("\nThis is exactly what will be written to .env.local (password masked here):\n");
  console.log("---");
  console.log(content.trim());
  console.log("---");

  const confirmRl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const confirm = await ask(confirmRl, "Write this file? [y/N]: ");
  confirmRl.close();
  if (confirm.toLowerCase() !== "y" && confirm.toLowerCase() !== "yes") {
    console.log("Aborted — nothing was written.");
    return 0;
  }
  fs.writeFileSync(target, realContent, { mode: 0o600 });
  console.log(`\n✅ Wrote ${target} (owner-only permissions).`);
  console.log("Next: start the server, then run `9router doctor` to verify, and `9router dry-run --url http://localhost:" + port + "` before wiring CLI tools.");
  return 0;
}

module.exports = { run };
