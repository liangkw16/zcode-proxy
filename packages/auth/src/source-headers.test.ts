import { describe, it, expect } from "vitest";
import { buildSourceHeaders } from "./source-headers.js";

const base = {
  appVersion: "3.15.1",
  platform: "darwin",
  arch: "arm64",
  osRelease: "24.1.0",
  deviceMid: "MID123",
  clientLanguage: "zh-CN",
  clientTimezone: "Asia/Shanghai",
};

describe("buildSourceHeaders", () => {
  it("builds the full zcode fingerprint", () => {
    const h = buildSourceHeaders({ ...base, sourceTitle: "cli" });
    expect(h["User-Agent"]).toBe("ZCode/3.15.1");
    expect(h["HTTP-Referer"]).toBe("https://zcode.z.ai");
    expect(h["X-Title"]).toBe("Z Code@cli");
    expect(h["X-ZCode-App-Version"]).toBe("3.15.1");
    expect(h["X-Platform"]).toBe("darwin-arm64");
    expect(h["X-Os-Category"]).toBe("macos");
    expect(h["X-Os-Version"]).toBe("24.1.0");
    expect(h["X-Client-Language"]).toBe("zh-CN");
    expect(h["X-Client-Timezone"]).toBe("Asia/Shanghai");
    expect(h["X-Device-Mid"]).toBe("MID123");
  });

  it("omits optional fields when absent", () => {
    const h = buildSourceHeaders({
      platform: "linux",
      arch: "x64",
      clientLanguage: "unknown",
      clientTimezone: "unknown",
    });
    expect(h["X-Title"]).toBe("Z Code@electron");
    expect(h["X-Os-Category"]).toBe("linux");
    expect(h["User-Agent"]).toBe("ZCode/unknown");
    expect(h["X-Device-Mid"]).toBeUndefined();
    expect(h["X-ZCode-App-Version"]).toBeUndefined();
  });

  it("maps win32 to windows", () => {
    const h = buildSourceHeaders({ platform: "win32", arch: "x64" });
    expect(h["X-Os-Category"]).toBe("windows");
  });
});
