import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MODAL_PATH = path.resolve(REPO_ROOT, "src/shared/components/WelcomeModal.js");
const LAYOUT_PATH = path.resolve(REPO_ROOT, "src/shared/components/layouts/DashboardLayout.js");

function read(p) {
  return fs.readFileSync(p, "utf-8");
}

describe("WelcomeModal content", () => {
  it("names 9Router Pro Mod Edition powered by Gienetic", () => {
    const source = read(MODAL_PATH);
    expect(source).toContain("9Router Pro");
    expect(source).toContain("Mod Edition");
    expect(source).toContain("powered by");
    expect(source).toContain("Gienetic");
  });

  it("thanks Allah SWT, KRYZEN TEAM, komunitas Telegram, decolua, and loyal users", () => {
    const source = read(MODAL_PATH);
    for (const name of [
      "Allah SWT",
      "KRYZEN TEAM",
      "Komunitas Telegram",
      "decolua",
      "pembuat 9Router original",
      "pengguna setia",
    ]) {
      expect(source).toContain(name);
    }
  });

  it("invites suggestions/reports and asks for a GitHub star + sharing", () => {
    const source = read(MODAL_PATH);
    expect(source).toContain("Saran dan laporan");
    expect(source).toContain("Kenyamanan");
    expect(source).toContain("Star di");
    expect(source).toContain("GitHub");
    expect(source).toContain("bagikan 9Router Pro");
    expect(source).toContain("grup, komunitas");
  });

  it("promises continued improvement for optimal use", () => {
    const source = read(MODAL_PATH);
    expect(source).toContain("terus meningkatkan 9Router Pro semaksimal mungkin");
    expect(source).toContain("lebih optimal");
  });

  it("links Donasi (DonateModal), Telegram, and the GitHub repo", () => {
    const source = read(MODAL_PATH);
    expect(source).toContain("DonateModal");
    expect(source).toContain("Donasi");
    expect(source).toContain("https://t.me/Gieneticc");
    expect(source).toContain("GITHUB_CONFIG.repoUrl");
    expect(source).toContain("Star GitHub");
    expect(source).toContain("Mulai Menggunakan");
  });

  it("shows the Pro logo at the top", () => {
    const source = read(MODAL_PATH);
    expect(source).toContain('src="/logo-pro-v3.png"');
  });

  it("exports a versioned storage key and the Telegram URL", () => {
    const source = read(MODAL_PATH);
    expect(source).toContain('WELCOME_STORAGE_KEY = "9router-pro-welcome-v1"');
    expect(source).toContain('TELEGRAM_URL = "https://t.me/Gieneticc"');
  });
});

describe("WelcomeModal wiring (DashboardLayout)", () => {
  it("mounts the modal and shows it once via localStorage", () => {
    const source = read(LAYOUT_PATH);
    expect(source).toContain("WelcomeModal");
    expect(source).toContain("WELCOME_STORAGE_KEY");
    expect(source).toContain("localStorage.getItem(WELCOME_STORAGE_KEY)");
    expect(source).toContain("localStorage.setItem(WELCOME_STORAGE_KEY");
    expect(source).toContain("<WelcomeModal isOpen={welcomeOpen} onClose={closeWelcome} />");
  });
});
