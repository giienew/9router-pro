# 9Router Pro — regenerate the subset Material Symbols font.
#
# Scans src/ for every icon name actually rendered (ligature text inside
# .material-symbols-outlined spans + any quoted string that names a glyph),
# then subsets node_modules/material-symbols/material-symbols-outlined.woff2
# down to those glyphs + the a-z/0-9/_ letters the ligatures are built from.
#
# Why --no-layout-closure: with closure on, every ligature rule whose
# components are a-z/0-9/_ pulls its glyph in, so the "subset" stays ~3.8 MB.
# With it off, GSUB is pruned to rules fully inside the kept set, and the
# result is ~150 KB. The rlig feature (not liga) carries the ligatures, so
# --layout-features='*' must stay, or GSUB is dropped entirely.
#
# Then pin wght/GRAD/opsz with varLib.instancer: the only two
# font-variation-settings declarations in the app (globals.css) are
# wght 400 / GRAD 0 / opsz 24, differing only in FILL 0/1 — so instancing
# those three axes is exactly equivalent here and drops the subset to ~24 KB.
# FILL stays a live axis (sidebar active icons + pinned combos use fill-1).
#
# Requires: pip install fonttools brotli
# Run: python3 scripts/subset-material-symbols.py
# Output: src/app/fonts/material-symbols-outlined-subset.woff2
# (imported by src/app/layout.js; the full package stays in package.json
# as the subset source — do not remove it.)
import re
import subprocess
import sys
from pathlib import Path

from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
SRC_FONT = ROOT / "node_modules/material-symbols/material-symbols-outlined.woff2"
OUT = ROOT / "src/app/fonts/material-symbols-outlined-subset.woff2"

SPAN_RE = re.compile(r"material-symbols-outlined[^>]*>(.*?)</span>", re.S)
# STR_RE pairs EITHER quote as opener/closer, so an apostrophe in prose
# ("don't" in a comment or JSX text) swallows the next real icon string
# and desyncs the pairing for the rest of the file — that is how
# monitor_heart (Admin System status card) went missing from the subset.
# Scan double- and single-quoted strings separately so an apostrophe can
# never swallow a double-quoted icon name.
DQ_RE = re.compile(r'"([^"]+)"')
SQ_RE = re.compile(r"'([^']+)'")
# Icon names travel as component props (Card icon="…", Button icon="…")
# and object fields (icon: "…") — match those directly, immune to any
# quote desync elsewhere in the file.
ICON_PROP_RE = re.compile(r"""icon\s*[:=]\s*["']([^"']+)["']""")
BT_RE = re.compile(r"`([^`$]+)`")


def collect_used_glyphs():
    font = TTFont(str(SRC_FONT))
    base = {g for g in font.getGlyphOrder() if not g.endswith(".fill")}
    # Ligature rules (rlig): only names with a rule can ever render.
    rules = set()
    for lookup in font["GSUB"].table.LookupList.Lookup:
        for st in lookup.SubTable:
            ext = getattr(st, "ExtSubTable", None) or st
            for first, ligset in getattr(ext, "ligatures", {}).items():
                for lig in ligset:
                    rules.add(first + "".join(
                        "_" if c == "underscore" else ("2" if c == "two" else c)
                        for c in lig.Component
                    ))
    used = set()
    for p in sorted((ROOT / "src").rglob("*.js")):
        t = p.read_text(errors="ignore")
        for m in SPAN_RE.finditer(t):
            inner = m.group(1)
            for s in DQ_RE.findall(inner) + SQ_RE.findall(inner):
                if s in base:
                    used.add(s)
            txt = re.sub(r"\{[^}]*\}", " ", inner).strip()
            if txt in base:
                used.add(txt)
        for s in ICON_PROP_RE.findall(t):
            if s in base:
                used.add(s)
        for s in DQ_RE.findall(t) + SQ_RE.findall(t):
            if s in base:
                used.add(s)
        for s in BT_RE.findall(t):
            if s in base:
                used.add(s)
    # Drop string literals that merely collide with a glyph name but have
    # no ligature rule (e.g. single letters, "period") — they are not icons.
    return sorted(u for u in used if u in rules)


def main():
    if not SRC_FONT.exists():
        print(f"missing source font: {SRC_FONT} (run npm install)", file=sys.stderr)
        return 1
    glyphs = collect_used_glyphs()
    print(f"used icons: {len(glyphs)}")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        sys.executable, "-m", "fontTools.subset", str(SRC_FONT),
        f"--output-file={OUT}",
        "--flavor=woff2",
        f"--glyphs={' '.join(glyphs)}",
        "--unicodes=U+0061-007A,U+0030-0039,U+005F",
        "--layout-features=*",
        "--no-layout-closure",
        "--no-hinting",
    ]
    subprocess.run(cmd, check=True)
    # Pin the three axes the app never varies (see header comment); keep FILL.
    subprocess.run([
        sys.executable, "-m", "fontTools.varLib.instancer", str(OUT),
        "wght=400", "GRAD=0", "opsz=24", "-o", str(OUT),
    ], check=True)
    orig = SRC_FONT.stat().st_size
    new = OUT.stat().st_size
    print(f"subset: {OUT.relative_to(ROOT)} {new} bytes (was {orig}, "
          f"{100.0 * new / orig:.1f}%)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
