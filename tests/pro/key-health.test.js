// 9Router Pro — Key Health tests: connection health classification (pure).
import assert from "node:assert";
import { classifyConnectionHealth } from "@/lib/db/repos/connectionsRepo.js";

const NOW = Date.parse("2026-10-21T00:00:00Z");
const future = new Date(NOW + 3600e3).toISOString();
const past = new Date(NOW - 3600e3).toISOString();

describe("classifyConnectionHealth", () => {
  it("disabled wins over everything", () => {
    assert.equal(classifyConnectionHealth({ isActive: false, testStatus: "active" }, NOW), "disabled");
    assert.equal(classifyConnectionHealth({ isActive: false, rateLimitedUntil: future }, NOW), "disabled");
  });

  it("cooldown via rate limit or model lock in the future", () => {
    assert.equal(classifyConnectionHealth({ isActive: true, rateLimitedUntil: future }, NOW), "cooldown");
    assert.equal(classifyConnectionHealth({ isActive: true, "modelLock_gpt-x": future }, NOW), "cooldown");
    assert.equal(classifyConnectionHealth({ isActive: true, rateLimitedUntil: past, testStatus: "active" }, NOW), "active");
    assert.equal(classifyConnectionHealth({ isActive: true, "modelLock_gpt-x": past, testStatus: "active" }, NOW), "active");
  });

  it("recorded failures map to unavailable / error", () => {
    assert.equal(classifyConnectionHealth({ isActive: true, testStatus: "unavailable" }, NOW), "unavailable");
    assert.equal(classifyConnectionHealth({ isActive: true, testStatus: "error", lastError: "401" }, NOW), "error");
    assert.equal(classifyConnectionHealth({ isActive: true, lastError: "boom" }, NOW), "error");
  });

  it("active with a soft-warning lastError stays active", () => {
    assert.equal(classifyConnectionHealth({ isActive: true, testStatus: "active", lastError: "402 spending limit" }, NOW), "active");
  });

  it("untested connections are unknown", () => {
    assert.equal(classifyConnectionHealth({ isActive: true }, NOW), "unknown");
    assert.equal(classifyConnectionHealth({}, NOW), "unknown");
    assert.equal(classifyConnectionHealth(null, NOW), "unknown");
  });
});
