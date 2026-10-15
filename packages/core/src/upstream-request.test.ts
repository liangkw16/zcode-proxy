import { describe, it, expect, vi } from "vitest";
import { sendWithAuthRetry } from "./upstream-request.js";

function jsonResponse(status: number) {
  return new Response("{}", { status });
}

describe("sendWithAuthRetry", () => {
  it("retries once with forced refresh on 401", async () => {
    const getHeaders = vi
      .fn()
      .mockResolvedValueOnce({ Authorization: "Bearer old" })
      .mockResolvedValueOnce({ Authorization: "Bearer new" });
    const send = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401))
      .mockResolvedValueOnce(jsonResponse(200));
    const res = await sendWithAuthRetry({ getHeaders, send });
    expect(res.status).toBe(200);
    expect(getHeaders).toHaveBeenNthCalledWith(1, false);
    // The forced refresh is told which token failed so a late 401 against an
    // old token cannot discard a newer token another request already got.
    expect(getHeaders).toHaveBeenNthCalledWith(2, true, "old");
  });

  it("does not retry on 200", async () => {
    const getHeaders = vi.fn().mockResolvedValue({});
    const send = vi.fn().mockResolvedValue(jsonResponse(200));
    await sendWithAuthRetry({ getHeaders, send });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("returns the 401 when refresh also fails", async () => {
    const getHeaders = vi.fn().mockResolvedValue({});
    const send = vi.fn().mockResolvedValue(jsonResponse(401));
    const res = await sendWithAuthRetry({ getHeaders, send });
    expect(res.status).toBe(401);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
