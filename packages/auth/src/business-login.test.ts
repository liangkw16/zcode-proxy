import { describe, it, expect, vi } from "vitest";
import { loginWithZaiBusinessJwt } from "./business-login.js";

describe("business login", () => {
  it("exchanges oauth token for business jwt", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ code: 200, data: { token: "biz-jwt" } }), { status: 200 }),
    );
    const jwt = await loginWithZaiBusinessJwt({
      fetchImpl,
      loginUrl: "https://api.z.ai/api/auth/z/login",
      oauthAccessToken: "oauth",
    });
    expect(jwt).toBe("biz-jwt");
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.body).toContain("oauth");
  });

  it("throws on non-2xx", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 }));
    await expect(
      loginWithZaiBusinessJwt({
        fetchImpl,
        loginUrl: "https://x/login",
        oauthAccessToken: "oauth",
      }),
    ).rejects.toThrow(/login_failed/);
  });

  it("throws on malformed body", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200 }));
    await expect(
      loginWithZaiBusinessJwt({ fetchImpl, loginUrl: "https://x/login", oauthAccessToken: "o" }),
    ).rejects.toThrow(/login_failed/);
  });
});
