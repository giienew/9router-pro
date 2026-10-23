// Plain-words log helpers (9Router Pro): log lines are read by operators,
// so durations must be human ("1.3s", not "1300ms") and statuses must say
// what they mean ("402 quota exhausted", not a bare number plus raw body).
import { describe, expect, it } from "vitest";
import { fmtDuration, fmtCount, describeStatus } from "../../src/sse/utils/logger.js";

describe("fmtDuration", () => {
  it("keeps sub-second durations in ms", () => {
    expect(fmtDuration(731)).toBe("731ms");
    expect(fmtDuration(0)).toBe("0ms");
  });

  it("renders seconds with one decimal", () => {
    expect(fmtDuration(1300)).toBe("1.3s");
    expect(fmtDuration(45000)).toBe("45.0s");
  });

  it("renders minutes as m ss", () => {
    expect(fmtDuration(125000)).toBe("2m 05s");
  });
});

describe("fmtCount", () => {
  it("adds thousands separators", () => {
    expect(fmtCount(45231)).toBe("45,231");
    expect(fmtCount(87)).toBe("87");
  });
});

describe("describeStatus", () => {
  it("names the statuses operators actually meet", () => {
    expect(describeStatus(401)).toBe("key rejected");
    expect(describeStatus(402)).toBe("quota exhausted");
    expect(describeStatus(403)).toBe("access denied");
    expect(describeStatus(429)).toBe("rate limited");
    expect(describeStatus(502)).toBe("upstream error");
  });

  it("stays silent for unknown statuses", () => {
    expect(describeStatus(200)).toBe("");
    expect(describeStatus(418)).toBe("");
    expect(describeStatus(undefined)).toBe("");
  });
});
