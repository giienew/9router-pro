// Kiro region-splicing guard (rival-ref sweep 2026-11-19, Go's "Kiro guard
// region splicing"): the stored Kiro region is spliced into amazonaws.com
// hostnames on the inference path (executor) and into the OIDC token
// endpoint on the refresh path. Pro's OAuth flow already asserted the
// region (GHSA-6mwv-4mrm-5p3m), but those two runtime paths did not — an
// unvalidated value like "us-east-1@evil.com" or "us-east-1/x" could
// corrupt the URL or redirect the host. resolveAwsRegion only ever
// returns a valid AWS region or the us-east-1 default.
import { describe, it, expect } from "vitest";
import { resolveAwsRegion, AWS_REGION_PATTERN } from "../../src/lib/oauth/constants/oauth.js";
import { KiroExecutor } from "../../open-sse/executors/kiro.js";

const RUNTIME = "https://runtime.us-east-1.kiro.dev/generateAssistantResponse";
const CODEWHISPERER = "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse";
const Q = "https://q.us-east-1.amazonaws.com/generateAssistantResponse";

describe("resolveAwsRegion", () => {
  it("passes valid AWS regions through (trimmed)", () => {
    expect(resolveAwsRegion("us-east-1")).toBe("us-east-1");
    expect(resolveAwsRegion("eu-west-1")).toBe("eu-west-1");
    expect(resolveAwsRegion("ap-southeast-2")).toBe("ap-southeast-2");
    expect(resolveAwsRegion("  us-west-2  ")).toBe("us-west-2");
  });

  it("falls back to us-east-1 for anything else", () => {
    expect(resolveAwsRegion(undefined)).toBe("us-east-1");
    expect(resolveAwsRegion(null)).toBe("us-east-1");
    expect(resolveAwsRegion("")).toBe("us-east-1");
    expect(resolveAwsRegion("  ")).toBe("us-east-1");
    expect(resolveAwsRegion("US-EAST-1")).toBe("us-east-1");
    expect(resolveAwsRegion("us-east")).toBe("us-east-1");
    expect(resolveAwsRegion("us-east-1@evil.com")).toBe("us-east-1");
    expect(resolveAwsRegion("us-east-1/x")).toBe("us-east-1");
    expect(resolveAwsRegion("us-east-1?x=1")).toBe("us-east-1");
    expect(resolveAwsRegion("us-east-1\n")).toBe("us-east-1");
    expect(resolveAwsRegion(123)).toBe("us-east-1");
  });

  it("uses the same pattern as the OAuth assert", () => {
    expect(AWS_REGION_PATTERN.test("eu-central-1")).toBe(true);
    expect(AWS_REGION_PATTERN.test("us-east-1@evil.com")).toBe(false);
  });
});

describe("KiroExecutor region guard", () => {
  const executor = new KiroExecutor();

  it("keeps a valid non-default region spliced", () => {
    expect(executor.getOrderedBaseUrls({ providerSpecificData: { authMethod: "idc", region: "eu-west-1" } })).toEqual([
      "https://q.eu-west-1.amazonaws.com/generateAssistantResponse",
      "https://codewhisperer.eu-west-1.amazonaws.com/generateAssistantResponse",
      RUNTIME,
    ]);
  });

  it("never splices an invalid stored region into the endpoint", () => {
    for (const bad of ["us-east-1@evil.com", "us-east-1/x", "us-east-1?x=1", "US-EAST-1", "", null, undefined]) {
      const urls = executor.getOrderedBaseUrls({ providerSpecificData: { authMethod: "idc", region: bad } });
      expect(urls).toEqual([Q, CODEWHISPERER, RUNTIME]);
      for (const u of urls) expect(u).not.toContain("evil.com");
    }
  });

  it("treats a missing region as us-east-1", () => {
    expect(executor.getOrderedBaseUrls({ providerSpecificData: { authMethod: "idc" } })).toEqual([Q, CODEWHISPERER, RUNTIME]);
    expect(executor.getOrderedBaseUrls({})).toEqual([Q, CODEWHISPERER, RUNTIME]);
  });
});
