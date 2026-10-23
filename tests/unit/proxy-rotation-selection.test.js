import { describe, it, expect, vi } from "vitest";

vi.mock("@/models", () => ({
  getProxyPoolById: vi.fn(),
  getProxyPools: vi.fn(async () => []),
}));

import { resolveRotationPoolIds } from "@/lib/network/connectionProxy";

const pools = [
  { id: "a", proxyUrl: "http://a:1" },
  { id: "b", proxyUrl: "http://b:2" },
  { id: "c", proxyUrl: "" },
  { id: "d", proxyUrl: "http://d:4" },
];

describe("resolveRotationPoolIds", () => {
  it("returns every usable pool when no selection is saved", () => {
    expect(resolveRotationPoolIds(pools, undefined)).toEqual(["a", "b", "d"]);
    expect(resolveRotationPoolIds(pools, [])).toEqual(["a", "b", "d"]);
  });

  it("restricts rotation to the selected subset", () => {
    expect(resolveRotationPoolIds(pools, ["d", "a"])).toEqual(["a", "d"]);
  });

  it("drops selected ids that are gone or unusable", () => {
    expect(resolveRotationPoolIds(pools, ["c", "zzz", "b"])).toEqual(["b"]);
  });

  it("handles empty inputs", () => {
    expect(resolveRotationPoolIds([], ["a"])).toEqual([]);
    expect(resolveRotationPoolIds(null, null)).toEqual([]);
  });
});
