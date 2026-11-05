// Guards the M-3 dashboard reader: errorText tolerates the old string
// shape and the new { error: { code, message } } shape, and never renders
// "[object Object]".
import { describe, it, expect } from "vitest";
import { errorText } from "../../src/shared/utils/errorText.js";

describe("errorText", () => {
  it("reads the new object shape", () => {
    expect(errorText({ error: { code: "mitm_start_failed", message: "Failed to start MITM server" } }, "Fallback"))
      .toBe("Failed to start MITM server");
  });

  it("reads the old string shape", () => {
    expect(errorText({ error: "Failed to start MITM server" }, "Fallback"))
      .toBe("Failed to start MITM server");
  });

  it("falls back when there is no error", () => {
    expect(errorText({}, "Fallback")).toBe("Fallback");
    expect(errorText(null, "Fallback")).toBe("Fallback");
    expect(errorText({ error: { code: "x_failed" } }, "Fallback")).toBe("Fallback");
  });

  it("falls back on an empty message and never renders [object Object]", () => {
    expect(errorText({ error: { code: "x_failed", message: "" } }, "Fallback")).toBe("Fallback");
    const rendered = errorText({ error: { code: "x_failed", message: "Boom" } }, "Fallback");
    expect(rendered).not.toContain("[object Object]");
  });
});
