// pro.29 item G — proxy-pool status filter: GET /api/proxy-pools?status=
// narrows to active / inactive / failed pools while activeCount/failedCount
// stay global, and the pools page offers the filter next to search.
// Run: npx vitest run unit/pro29-item-g-proxy-pool-status-filter.test.js
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => fs.readFileSync(path.resolve(REPO_ROOT, p), "utf-8");

vi.mock("@/models", () => ({
  createProxyPool: vi.fn(),
  getProviderConnections: vi.fn(),
  getProxyPools: vi.fn(),
}));

import { GET } from "../../src/app/api/proxy-pools/route.js";
import { getProxyPools, getProviderConnections } from "@/models";

const mockedGetPools = vi.mocked(getProxyPools);
const mockedGetConns = vi.mocked(getProviderConnections);

const POOLS = [
  { id: "pool-active-ok", isActive: true, testStatus: "ok" },
  { id: "pool-active-failed", isActive: true, testStatus: "error" },
  { id: "pool-inactive-ok", isActive: false, testStatus: "ok" },
  { id: "pool-inactive-failed", isActive: false, testStatus: "error" },
];

async function getJson(url) {
  const res = await GET(new Request(url));
  expect(res.status).toBe(200);
  return res.json();
}

describe("GET /api/proxy-pools?status=", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetPools.mockResolvedValue(POOLS);
  });

  it("status=active returns only active pools, counts stay global", async () => {
    const body = await getJson("http://localhost/api/proxy-pools?page=1&pageSize=50&status=active");
    expect(body.proxyPools.map((p) => p.id)).toEqual(["pool-active-ok", "pool-active-failed"]);
    expect(body.total).toBe(2);
    expect(body.activeCount).toBe(2);
    expect(body.failedCount).toBe(2);
    expect(mockedGetConns).not.toHaveBeenCalled();
  });

  it("status=inactive returns only inactive pools", async () => {
    const body = await getJson("http://localhost/api/proxy-pools?page=1&pageSize=50&status=inactive");
    expect(body.proxyPools.map((p) => p.id)).toEqual(["pool-inactive-ok", "pool-inactive-failed"]);
    expect(body.total).toBe(2);
    expect(body.activeCount).toBe(2);
    expect(body.failedCount).toBe(2);
  });

  it("status=failed returns only error pools", async () => {
    const body = await getJson("http://localhost/api/proxy-pools?page=1&pageSize=50&status=failed");
    expect(body.proxyPools.map((p) => p.id)).toEqual(["pool-active-failed", "pool-inactive-failed"]);
    expect(body.total).toBe(2);
    expect(body.activeCount).toBe(2);
    expect(body.failedCount).toBe(2);
  });

  it("no status (or an unknown one) returns everything", async () => {
    const all = await getJson("http://localhost/api/proxy-pools?page=1&pageSize=50");
    expect(all.total).toBe(4);
    const bogus = await getJson("http://localhost/api/proxy-pools?page=1&pageSize=50&status=bogus");
    expect(bogus.total).toBe(4);
  });

  it("the pools page offers the filter and sends it to the API", () => {
    const page = read("src/app/(dashboard)/dashboard/proxy-pools/page.js");
    expect(page).toContain("statusFilter");
    expect(page).toContain('{ value: "active", label: "Active" }');
    expect(page).toContain('{ value: "inactive", label: "Inactive" }');
    expect(page).toContain('{ value: "failed", label: "Failed" }');
    expect(page).toContain('params.set("status", statusFilter)');
    expect(page).toContain("SegmentedControl");
  });
});
