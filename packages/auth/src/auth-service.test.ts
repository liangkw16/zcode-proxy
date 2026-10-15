import { describe, it, expect } from "vitest";
import { createAuthServiceInternal } from "./auth-service.js";
import { createCipher } from "./cipher.js";

const env = { ZCODE_CREDENTIAL_SECRET: "svc-secret" };
const cipher = createCipher(env);

describe("AuthService", () => {
  it("resolves endpoints, token and upstream headers through the chain", async () => {
    const credFile = JSON.stringify({
      "oauth:bigmodel:access_token": cipher.encrypt("oauth-tok"),
    });
    const fetchImpl = (async (url: string, init: any) => {
      const u = String(url);
      if (u.includes("getCustomerInfo"))
        return Response.json({
          code: 200,
          data: {
            organizations: [
              {
                organizationId: "org",
                organizationName: "默认机构",
                projects: [{ projectId: "proj", projectName: "默认项目", projectType: "1" }],
              },
            ],
          },
        });
      if (u.endsWith("/api_keys") && init.method === "GET")
        return Response.json({ code: 200, data: [] });
      if (u.endsWith("/api_keys") && init.method === "POST")
        return Response.json({ code: 200, data: { name: "zcode-api-key", apiKey: "keyid" } });
      if (u.includes("/access_tokens"))
        return Response.json({
          code: 200,
          data: { enable: true, accessToken: "pat", tokenType: "Bearer", expiresIn: 3600, expiresAt: Date.now() / 1000 + 3600 },
        });
      throw new Error("unexpected " + u);
    }) as typeof fetch;

    const svc = createAuthServiceInternal({
      env,
      homedir: "/home/u",
      platform: "darwin",
      arch: "arm64",
      osRelease: "24.0",
      readTextFile: async (p) => (p.endsWith("credentials.json") ? credFile : JSON.stringify({ deviceMid: "MID" })),
      fetchImpl,
    });

    const endpoints = await svc.getEndpoints();
    expect(endpoints.family).toBe("bigmodel");
    const token = await svc.getAccessToken();
    expect(token.token).toBe("pat");
    const headers = await svc.getUpstreamHeaders();
    expect(headers["Authorization"]).toBe("Bearer pat");
    expect(headers["User-Agent"]).toBe("ZCode/3.15.1");
    expect(headers["X-Device-Mid"]).toBe("MID");
  });
});
