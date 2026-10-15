import { describe, it, expect, vi } from "vitest";
import { fetchStatus } from "./status.js";

describe("fetchStatus", () => {
  it("reports running when health is ok", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ok: true }));
    const status = await fetchStatus(8792, fetchImpl);
    expect(status.running).toBe(true);
  });
  it("reports stopped when connection refused", async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
    });
    const status = await fetchStatus(8792, fetchImpl);
    expect(status.running).toBe(false);
  });
  it("reports stopped for node fetch's wrapped TypeError (code on error.cause)", async () => {
    // Real undici/node fetch wraps network errors as `TypeError: fetch failed`
    // with the ECONNREFUSED errno nested on `error.cause`, not on the error itself.
    const fetchImpl = vi.fn(async () => {
      const cause = Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
        errno: -61,
      });
      throw Object.assign(new TypeError("fetch failed"), { cause });
    });
    const status = await fetchStatus(8792, fetchImpl);
    expect(status.running).toBe(false);
  });
});
