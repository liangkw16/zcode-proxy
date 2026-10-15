import { describe, it, expect } from "vitest";
import { runDoctor } from "./doctor.js";

describe("runDoctor", () => {
  it("passes when credential, token and health are all good", async () => {
    const result = await runDoctor({
      auth: {
        getUpstreamHeaders: async () => ({ Authorization: "Bearer x" }),
      } as any,
      fetchImpl: async () => Response.json({ ok: true }),
      port: 8792,
    });
    expect(result.ok).toBe(true);
  });

  it("fails when login is missing", async () => {
    const result = await runDoctor({
      auth: {
        getUpstreamHeaders: async () => {
          throw new Error("未找到 ZCode 登录态，请先运行 `zcode login`");
        },
      } as any,
      fetchImpl: fetch,
      port: 8792,
    });
    expect(result.ok).toBe(false);
    expect(result.checks.some((c) => c.name === "login" && !c.pass)).toBe(true);
  });
});
