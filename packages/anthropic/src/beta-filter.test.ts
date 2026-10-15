import { describe, it, expect } from "vitest";
import { filterAnthropicBeta, ALLOWED_UPSTREAM_BETAS } from "./beta-filter.js";

describe("beta filter", () => {
  it("removes beta names not on the upstream whitelist", () => {
    const out = filterAnthropicBeta({
      "anthropic-beta": "interleaved-thinking-2025,unknown-feature-x",
    });
    const allowed = (out["anthropic-beta"] ?? "").split(",").filter(Boolean);
    expect(allowed.every((b) => ALLOWED_UPSTREAM_BETAS.has(b))).toBe(true);
  });
  it("drops the header entirely when no beta is allowed", () => {
    const out = filterAnthropicBeta({ "anthropic-beta": "unknown-feature-x" });
    expect(out["anthropic-beta"]).toBeUndefined();
  });
});
