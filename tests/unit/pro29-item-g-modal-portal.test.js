// pro.29 item G — modal portaling: every overlay dialog renders at
// document.body (structural fix for the pro.27 modal-stacking class), and
// Drawer joins Modal's topmost-Escape registry instead of closing under a
// modal. Run: npx vitest run unit/pro29-item-g-modal-portal.test.js
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => fs.readFileSync(path.resolve(REPO_ROOT, p), "utf-8");

const PORTALED = [
  "src/shared/components/Drawer.js",
  "src/shared/components/Modal.js",
  "src/shared/components/PricingModal.js",
  "src/shared/components/DonateModal.js",
  "src/shared/components/WelcomeModal.js",
  "src/shared/components/ChangelogModal.js",
  "src/shared/components/LanguageSwitcher.js",
  "src/shared/components/Sidebar.js",
  "src/app/(dashboard)/dashboard/cli-tools/components/CoworkToolCard.js",
  "src/app/(dashboard)/dashboard/cli-tools/components/MitmServerCard.js",
  "src/app/(dashboard)/dashboard/cli-tools/components/MitmToolCard.js",
  "src/app/(dashboard)/dashboard/media-providers/[kind]/[id]/components/TtsExampleCard.js",
  "src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.js",
  "src/app/(dashboard)/dashboard/providers/page.js",
];

// Inline `fixed inset-0` that is NOT a modal/dialog (reviewed 2026-11-19):
// backgrounds, the full-screen loader, the mobile-sidebar backdrop (which
// must stay aligned with its slide-over panel), and the Xiaomi cluster
// picker, which renders inside the already-portaled <Modal>.
const ALLOWED_INLINE = [
  "src/app/landing/components/AnimatedBackground.js",
  "src/app/landing/page.js",
  "src/shared/components/Loading.js",
  "src/shared/components/layouts/DashboardLayout.js",
  "src/shared/components/XiaomiMimoAuthModal.js",
];

function jsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

describe("modal portaling", () => {
  it.each(PORTALED)("portals %s to document.body", (p) => {
    const source = read(p);
    expect(source).toContain('from "react-dom"');
    expect(source).toContain("createPortal(");
    expect(source).toContain("document.body");
  });

  it("Modal exports the topmost registry Drawer shares", () => {
    const modal = read("src/shared/components/Modal.js");
    expect(modal).toContain("export function registerTopmostModal");
    expect(modal).toContain("export function isTopmostModal");
    expect(modal).toContain("isTopmostModal(entry)");
  });

  it("Drawer registers in the topmost registry and closes only when topmost", () => {
    const drawer = read("src/shared/components/Drawer.js");
    expect(drawer).toContain("registerTopmostModal(entry)");
    expect(drawer).toContain("isTopmostModal(entry)");
    expect(drawer).toContain("createPortal(");
  });

  it("no inline fixed overlay dialog remains in the portaled files", () => {
    for (const p of PORTALED) {
      const source = read(p);
      // Every remaining `fixed inset-0` overlay in these files is inside a
      // createPortal call — i.e. no `{cond && (<div className="fixed ...`
      // inline render is left.
      expect(source).not.toMatch(/\{\w+ && \(\s*\n?\s*<div className="fixed inset-0/);
    }
  });

  it("every fixed inset-0 overlay in src is either portaled or on the reviewed allow-list", () => {
    const allowed = new Set([...PORTALED, ...ALLOWED_INLINE]);
    const offenders = jsFiles(path.resolve(REPO_ROOT, "src")).filter((f) => {
      const rel = path.relative(REPO_ROOT, f);
      if (allowed.has(rel)) return false;
      return fs.readFileSync(f, "utf-8").includes("fixed inset-0");
    });
    expect(offenders).toEqual([]);
  });
});
