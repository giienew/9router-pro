import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { NextResponse } from "next/server";
import pkg from "../../../../../package.json" with { type: "json" };
import { requireDashboardAuth } from "@/lib/admin/requireAdmin.js";
import { findPm2Target } from "@/lib/admin/maintenance.js";

export const dynamic = "force-dynamic";

function getDisk() {
  try {
    const out = execFileSync("df", ["-k", "/"], { encoding: "utf8", timeout: 5000 });
    const parts = out.trim().split("\n").pop().trim().split(/\s+/);
    const totalKb = Number(parts[1]);
    const usedKb = Number(parts[2]);
    const availKb = Number(parts[3]);
    if (!Number.isFinite(totalKb) || !totalKb) return null;
    return { totalBytes: totalKb * 1024, usedBytes: usedKb * 1024, availBytes: availKb * 1024 };
  } catch {
    return null;
  }
}

function getBuildId() {
  try {
    return fs.readFileSync(path.join(process.cwd(), ".next", "BUILD_ID"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

// GET /api/admin/system — read-only system status card: memory, disk,
// uptime, PM2 status, live BUILD_ID + version. No action is taken here.
export async function GET() {
  try {
    if (!(await requireDashboardAuth())) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const pm2 = await findPm2Target();
    return NextResponse.json({
      version: pkg?.version || null,
      buildId: getBuildId(),
      uptimeSec: Math.floor(os.uptime()),
      appUptimeSec: Math.floor(process.uptime()),
      memory: {
        totalBytes: os.totalmem(),
        freeBytes: os.freemem(),
        rssBytes: process.memoryUsage().rss,
        heapUsedBytes: process.memoryUsage().heapUsed,
      },
      disk: getDisk(),
      load: os.loadavg(),
      cpuCores: (os.cpus() || []).length || null,
      platform: `${os.platform()} ${os.arch()}`,
      pm2: {
        available: pm2.available,
        target: pm2.target,
        processes: pm2.processes || [],
        error: pm2.error || null,
      },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e?.message || "failed" }, { status: 500 });
  }
}
