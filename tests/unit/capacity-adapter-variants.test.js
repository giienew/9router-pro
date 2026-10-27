import { describe, it, expect, vi } from "vitest";
import {
  augmentModelsWithCapacityAdapter,
  withCapacityAdapterStripping,
} from "../../open-sse/services/capacityAdapter.js";

// Capacity pools may hold variants (bare custom names). A variant carries no
// caps of its own, so it is judged by its backing model through a resolver
// supplied by the caller; without one, a bare name keeps the old behavior
// (generic caps: no vision) and never enters a capability pool.
const visionSettings = {
  capacityAdapter: {
    vision: { enabled: true, roundRobin: false, models: ["my-variant"] },
  },
};

const toVision = (m) => (m === "my-variant" ? "openai/gpt-4o" : null);
const toTextOnly = (m) => (m === "my-variant" ? "openai/gpt-3.5-turbo" : null);

describe("capacity adapter with variant pool models", () => {
  it("prepends a variant whose backing model satisfies the capability", () => {
    const out = augmentModelsWithCapacityAdapter(
      ["openai/gpt-3.5-turbo"],
      ["vision"],
      visionSettings,
      toVision,
    );
    expect(out).toEqual(["my-variant", "openai/gpt-3.5-turbo"]);
  });

  it("drops the bare variant without a resolver (old behavior preserved)", () => {
    const out = augmentModelsWithCapacityAdapter(
      ["openai/gpt-3.5-turbo"],
      ["vision"],
      visionSettings,
    );
    expect(out).toEqual(["openai/gpt-3.5-turbo"]);
  });

  it("drops a variant whose backing model lacks the capability", () => {
    const out = augmentModelsWithCapacityAdapter(
      ["openai/gpt-3.5-turbo"],
      ["vision"],
      visionSettings,
      toTextOnly,
    );
    expect(out).toEqual(["openai/gpt-3.5-turbo"]);
  });

  it("leaves models untouched when the original already satisfies the cap", () => {
    const out = augmentModelsWithCapacityAdapter(
      ["openai/gpt-4o"],
      ["vision"],
      visionSettings,
      toVision,
    );
    expect(out).toEqual(["openai/gpt-4o"]);
  });

  it("stripping trims by the backing model's window, not the generic default", () => {
    // Adapter stripping always keeps head + tail, but the head shrinks
    // further when the window is small: ~300k chars of history exceed the
    // gpt-3.5-turbo budget (~52k) yet fit the generic bare-name budget
    // (~640k), so only the resolved path drops a head turn.
    const filler = "x".repeat(10000);
    const messages = [{ role: "system", content: "sys" }];
    for (let i = 0; i < 30; i++) {
      messages.push({ role: i % 2 ? "user" : "assistant", content: filler });
    }
    messages.push({ role: "user", content: "final question" });
    const seen = [];
    const handler = vi.fn((body) => { seen.push(body); return "ok"; });

    const wrapped = withCapacityAdapterStripping(handler, ["my-variant"], toTextOnly);
    wrapped({ messages: [...messages] }, "my-variant");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(seen[0].messages.at(-1).content).toBe("final question");

    const unwrapped = withCapacityAdapterStripping(handler, ["my-variant"]);
    handler.mockClear();
    unwrapped({ messages: [...messages] }, "my-variant");
    expect(seen[1].messages.at(-1).content).toBe("final question");
    expect(seen[0].messages.length).toBeLessThan(seen[1].messages.length);
  });
});
