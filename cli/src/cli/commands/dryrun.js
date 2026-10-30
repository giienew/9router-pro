/**
 * `9router dry-run [tool…]` — preview exactly what `9router connect`
 * would write, without writing anything. For each tool it lists the config
 * files (paths()) and the values that would be applied (base URL, model,
 * masked API key). No file is created or modified, no key is printed.
 */

const { TOOLS, TOOL_IDS, resolveTools } = require("./connectTools");

const HELP = `
Usage: 9router dry-run [tool…] [--url <server>] [--model <model>] [--json]

Preview what '9router connect' would write, without writing anything.

  9router dry-run claude --url http://localhost:3000
  9router dry-run --url http://localhost:3000 --model my-combo

Tools: ${TOOL_IDS.join(", ")}, all
`;

async function run(argv) {
  const opts = { tools: [], url: null, model: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") opts.url = argv[++i];
    else if (a === "--model") opts.model = argv[++i];
    else if (a === "--json") opts.json = true;
    else if (a === "-h" || a === "--help") { console.log(HELP); return 0; }
    else if (!a.startsWith("-")) opts.tools.push(a);
    else throw new Error(`Unknown option: ${a}`);
  }
  if (!opts.url) throw new Error("Pass --url <server> (dry-run needs a server to preview against)");

  const tools = opts.tools.length ? resolveTools(opts.tools) : TOOLS;
  const out = tools.map((tool) => {
    let files = [];
    try { files = tool.paths() || []; } catch (err) { files = [`(paths() failed: ${err.message})`]; }
    return {
      id: tool.id,
      name: tool.name,
      files,
      wouldWrite: {
        baseUrl: opts.url,
        model: opts.model || null,
        apiKey: "(your Pro API key — masked in this preview, written in full by connect)",
      },
    };
  });

  if (opts.json) {
    console.log(JSON.stringify({ dryRun: true, tools: out }, null, 2));
  } else {
    console.log("\nDry run — nothing will be written:\n");
    for (const t of out) {
      console.log(`• ${t.name} (${t.id})`);
      for (const f of t.files) console.log(`    file: ${f}`);
      console.log(`    baseUrl: ${t.wouldWrite.baseUrl}`);
      if (t.wouldWrite.model) console.log(`    model: ${t.wouldWrite.model}`);
      console.log(`    apiKey: (masked — written in full only by 'connect')`);
    }
    console.log("\nRun '9router connect <url>' to apply, or re-run dry-run with --model to preview a model.\n");
  }
  return 0;
}

module.exports = { run };
