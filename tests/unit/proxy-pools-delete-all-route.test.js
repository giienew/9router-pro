// Guards POST /api/proxy-pools/delete-all and the idsOnly+includeUsage
// bound-connection count on GET /api/proxy-pools (the delete-all confirm
// dialog reads its counts from that query, without downloading pool rows).
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db/repos/proxyPoolsRepo", () => ({
  deleteAllProxyPools: vi.fn(),
}));
vi.mock("@/models", () => ({
  createProxyPool: vi.fn(),
  getProviderConnections: vi.fn(),
  getProxyPools: vi.fn(),
}));

import { POST } from "../../src/app/api/proxy-pools/delete-all/route.js";
import { GET } from "../../src/app/api/proxy-pools/route.js";
import { deleteAllProxyPools } from "@/lib/db/repos/proxyPoolsRepo";
import { getProxyPools, getProviderConnections } from "@/models";
import { __resetDashboardThrottle } from "@/lib/auth/dashboardThrottle.js";

const mockedDeleteAll = vi.mocked(deleteAllProxyPools);
const mockedGetPools = vi.mocked(getProxyPools);
const mockedGetConns = vi.mocked(getProviderConnections);

function postDeleteAll() {
  return POST(
    new Request("http://localhost/api/proxy-pools/delete-all", { method: "POST" })
  );
}

describe("POST /api/proxy-pools/delete-all", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetDashboardThrottle();
  });

  it("returns the deleted-pool and unpinned-connection counts", async () => {
    mockedDeleteAll.mockResolvedValue({ deletedPools: 2200, unpinnedConnections: 29181 });
    const res = await postDeleteAll();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deletedPools: 2200, unpinnedConnections: 29181 });
    expect(mockedDeleteAll).toHaveBeenCalledTimes(1);
  });

  it("is throttled like the other dashboard bulk deletes", async () => {
    mockedDeleteAll.mockResolvedValue({ deletedPools: 0, unpinnedConnections: 0 });
    for (let i = 0; i < 5; i++) {
      expect((await postDeleteAll()).status).toBe(200);
    }
    const blocked = await postDeleteAll();
    expect(blocked.status).toBe(429);
    expect(mockedDeleteAll).toHaveBeenCalledTimes(5);
  });
});

describe("GET /api/proxy-pools?idsOnly=1&includeUsage=true", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports total pools plus the bound-connection count, without rows", async () => {
    mockedGetPools.mockResolvedValue([{ id: "pool-a" }, { id: "pool-b" }]);
    mockedGetConns.mockResolvedValue([
      { providerSpecificData: { proxyPoolId: "pool-a" } },
      { providerSpecificData: { proxyPoolId: "pool-a" } },
      { providerSpecificData: { proxyPoolId: "pool-b" } },
      { providerSpecificData: { proxyPoolId: null } },
      { providerSpecificData: {} },
    ]);
    const res = await GET(
      new Request("http://localhost/api/proxy-pools?idsOnly=true&includeUsage=true")
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ids: ["pool-a", "pool-b"], total: 2, boundConnectionCount: 3 });
  });

  it("omits boundConnectionCount when includeUsage is not requested", async () => {
    mockedGetPools.mockResolvedValue([{ id: "pool-a" }]);
    const res = await GET(new Request("http://localhost/api/proxy-pools?idsOnly=true"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ids: ["pool-a"], total: 1 });
    expect(mockedGetConns).not.toHaveBeenCalled();
  });
});
