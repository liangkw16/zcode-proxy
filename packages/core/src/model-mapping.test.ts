import { describe, it, expect } from "vitest";
import { createModelMapping } from "./model-mapping.js";

describe("model mapping", () => {
  const m = createModelMapping();
  it("maps opus/sonnet to GLM-5.3", () => {
    expect(m.map("claude-opus-4-1")).toBe("GLM-5.3");
    expect(m.map("claude-sonnet-4-5")).toBe("GLM-5.3");
  });
  it("maps haiku to GLM-5.3-Flash", () => {
    expect(m.map("claude-haiku-4-5")).toBe("GLM-5.3-Flash");
  });
  it("preserves explicit GLM names", () => {
    expect(m.map("GLM-5.3")).toBe("GLM-5.3");
    expect(m.map("GLM-5.3-Flash")).toBe("GLM-5.3-Flash");
  });
  it("falls back to GLM-5.3 for unknown names", () => {
    expect(m.map("something-else")).toBe("GLM-5.3");
  });
  it("honors custom overrides", () => {
    const custom = createModelMapping({ "^my-fast$": "GLM-5.3-Flash" });
    expect(custom.map("my-fast")).toBe("GLM-5.3-Flash");
  });
});
