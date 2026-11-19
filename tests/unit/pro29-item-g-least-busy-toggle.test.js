// pro.29 item G — Profile "Least Busy" routing toggle: mirrors the Sticky
// Random block and is honored by the backend (src/sse/services/auth.js).
// Run: npx vitest run unit/pro29-item-g-least-busy-toggle.test.js
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => fs.readFileSync(path.resolve(REPO_ROOT, p), "utf-8");

describe("Profile Least Busy toggle", () => {
  it("renders a Least Busy block mirroring Sticky Random", () => {
    const page = read("src/app/(dashboard)/dashboard/profile/page.js");
    expect(page).toContain("Least Busy");
    expect(page).toContain(
      "Send each request to the account with the fewest live requests — spreads agent load across farmed keys"
    );
    expect(page).toContain('checked={settings.fallbackStrategy === "least-busy"}');
    expect(page).toContain('onChange={() => updateFallbackStrategy("least-busy")}');
  });

  it("names Least Busy in the Currently summary", () => {
    const page = read("src/app/(dashboard)/dashboard/profile/page.js");
    expect(page).toContain('settings.fallbackStrategy === "least-busy"');
    expect(page).toContain(
      "Currently sending each request to the account with the fewest live requests (Least Busy)"
    );
  });

  it("the backend honors the least-busy strategy the toggle saves", () => {
    expect(read("src/sse/services/auth.js")).toContain('strategy === "least-busy"');
  });
});
