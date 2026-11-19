// pro.29 item G — font subsetting: the dashboard ships a subset Material
// Symbols font (~24 KB) instead of the full 3.9 MB package font, with every
// icon actually used in src/ still resolving through its ligature.
// Run: npx vitest run unit/pro29-item-g-font-subset.test.js
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SUBSET = path.resolve(REPO_ROOT, "src/app/fonts/material-symbols-outlined-subset.woff2");
const ORIGINAL = path.resolve(REPO_ROOT, "node_modules/material-symbols/material-symbols-outlined.woff2");

describe("font subset", () => {
  it("ships a woff2 subset far smaller than the full font", () => {
    expect(fs.existsSync(SUBSET)).toBe(true);
    const subset = fs.statSync(SUBSET).size;
    const original = fs.statSync(ORIGINAL).size;
    expect(original).toBeGreaterThan(3_000_000);
    expect(subset).toBeLessThan(100_000);
    expect(subset).toBeLessThan(original / 10);
    expect(fs.readFileSync(SUBSET).subarray(0, 4).toString("latin1")).toBe("wOF2");
  });

  it("layout.js loads the subset CSS, not the full package CSS", () => {
    const layout = fs.readFileSync(path.resolve(REPO_ROOT, "src/app/layout.js"), "utf-8");
    expect(layout).toContain('import "./fonts/material-symbols-outlined-subset.css"');
    expect(layout).not.toContain("material-symbols/outlined.css");
    const css = fs.readFileSync(
      path.resolve(REPO_ROOT, "src/app/fonts/material-symbols-outlined-subset.css"), "utf-8"
    );
    expect(css).toContain("@font-face");
    expect(css).toContain('font-family: "Material Symbols Outlined"');
    expect(css).toContain('url("./material-symbols-outlined-subset.woff2") format("woff2")');
  });

  it("the regeneration script pins only the axes the app never varies", () => {
    const script = fs.readFileSync(
      path.resolve(REPO_ROOT, "scripts/subset-material-symbols.py"), "utf-8"
    );
    expect(script).toContain("--no-layout-closure");
    expect(script).toContain("wght=400");
    expect(script).toContain("GRAD=0");
    expect(script).toContain("opsz=24");
  });

  it("every icon used in src/ has a ligature rule in the shipped subset", () => {
    let hasFontTools = true;
    try {
      execFileSync("python3", ["-c", "import fontTools"], { stdio: "ignore" });
    } catch {
      hasFontTools = false;
    }
    if (!hasFontTools) {
      console.warn("fontTools not installed — skipping subset coverage check");
      return;
    }
    const check = `
import importlib.util
from pathlib import Path
from fontTools.ttLib import TTFont
root = Path(r"${REPO_ROOT}")
spec = importlib.util.spec_from_file_location("subset", root / "scripts/subset-material-symbols.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
used = mod.collect_used_glyphs()
font = TTFont(str(root / "src/app/fonts/material-symbols-outlined-subset.woff2"))
order = set(font.getGlyphOrder())
rules = {}
for lookup in font["GSUB"].table.LookupList.Lookup:
    for st in lookup.SubTable:
        ext = getattr(st, "ExtSubTable", None) or st
        for first, ligset in getattr(ext, "ligatures", {}).items():
            for lig in ligset:
                name = first + "".join("_" if c == "underscore" else ("2" if c == "two" else c) for c in lig.Component)
                rules[name] = lig.LigGlyph
missing = [u for u in used if u not in rules or rules[u] not in order]
assert len(used) > 100, f"collector found too few icons: {len(used)}"
assert not missing, f"icons without a ligature in the subset: {missing}"
print(f"subset covers all {len(used)} used icons")
`;
    const out = execFileSync("python3", ["-c", check], { cwd: REPO_ROOT, encoding: "utf-8" });
    expect(out).toContain("subset covers all");
  });
});
