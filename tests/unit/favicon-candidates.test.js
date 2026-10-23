// Favicon auto-detection (9Router Pro): candidates come from the
// provider's API base URL — origin first, parent domain second;
// local/IP/invalid inputs get none.
import { describe, expect, it } from "vitest";
import { getFaviconCandidates } from "../../src/shared/utils/providerIcon.js";

describe("getFaviconCandidates", () => {
  it("returns origin then parent domain for an api subdomain", () => {
    expect(getFaviconCandidates("https://api.gonka-api.org/v1")).toEqual([
      "https://api.gonka-api.org/favicon.ico",
      "https://gonka-api.org/favicon.ico",
    ]);
  });

  it("returns only the origin for an apex host", () => {
    expect(getFaviconCandidates("https://openrouter.ai/api/v1")).toEqual([
      "https://openrouter.ai/favicon.ico",
    ]);
  });

  it("keeps the scheme and strips paths, ports stay with the origin", () => {
    expect(getFaviconCandidates("http://api.example.com:8080/v1/chat")).toEqual([
      "http://api.example.com/favicon.ico",
      "http://example.com/favicon.ico",
    ]);
  });

  it("returns none for localhost and IP hosts", () => {
    expect(getFaviconCandidates("http://localhost:11434/v1")).toEqual([]);
    expect(getFaviconCandidates("http://127.0.0.1:1234/v1")).toEqual([]);
    expect(getFaviconCandidates("http://192.168.1.10:8080/v1")).toEqual([]);
  });

  it("returns none for invalid or missing input", () => {
    expect(getFaviconCandidates("")).toEqual([]);
    expect(getFaviconCandidates(null)).toEqual([]);
    expect(getFaviconCandidates(undefined)).toEqual([]);
    expect(getFaviconCandidates("not a url")).toEqual([]);
    expect(getFaviconCandidates("ftp://example.com/v1")).toEqual([]);
  });
});
