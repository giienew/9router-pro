// Plain-words log helpers (9Router Pro): log lines are read by operators,
// so durations must be human ("1.3s", not "1300ms") and statuses must say
// what they mean ("402 quota exhausted", not a bare number plus raw body).
import { describe, expect, it } from "vitest";
import { fmtDuration, fmtCount, describeStatus, plainErrorDetail } from "../../src/sse/utils/logger.js";

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

describe("plainErrorDetail", () => {
  it("extracts the human message from an upstream JSON body", () => {
    const raw = '[402]: {"error":{"code":"insufficient_quota","message":"available tokens exhausted","type":"invalid_request_error"}}';
    expect(plainErrorDetail(raw)).toBe("available tokens exhausted");
  });

  it("extracts the message even when the body was truncated mid-sentence", () => {
    const raw = '[429]: {"error":{"code":"model_concurrency","message":"This model is at concurrency capacity. Paid accounts are admit…';
    expect(plainErrorDetail(raw)).toBe("This model is at concurrency capacity. Paid accounts are admit…");
  });

  it("strips the [NNN]: prefix from plain-text errors", () => {
    expect(plainErrorDetail("[400]: context length exceeded")).toBe("context length exceeded");
  });

  it("leaves ordinary sentences untouched", () => {
    expect(plainErrorDetail("Request aborted")).toBe("Request aborted");
  });

  it("returns empty for empty input and caps long text", () => {
    expect(plainErrorDetail("")).toBe("");
    expect(plainErrorDetail(null)).toBe("");
    expect(plainErrorDetail("x".repeat(150)).length).toBe(101);
  });
});
