import { describe, it, expect } from "vitest";
import { resolveEndpoints, ZCODE_APP_VERSION } from "./endpoints.js";

describe("endpoints", () => {
  it("resolves zai endpoints", () => {
    const e = resolveEndpoints("zai");
    expect(e.managementOrigin).toBe("https://api.z.ai");
    expect(e.anthropicBaseUrl).toBe("https://api.z.ai/api/anthropic");
    expect(e.zaiLoginUrl).toBe("https://api.z.ai/api/auth/z/login");
  });

  it("resolves bigmodel endpoints", () => {
    const e = resolveEndpoints("bigmodel");
    expect(e.managementOrigin).toBe("https://bigmodel.cn");
    expect(e.anthropicBaseUrl).toBe("https://open.bigmodel.cn/api/anthropic");
    expect(e.zaiLoginUrl).toBeUndefined();
  });

  it("pins the fingerprint version", () => {
    expect(ZCODE_APP_VERSION).toBe("3.15.1");
  });
});
