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

function customerJson() {
  return {
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
  };
}

function buildFetch(hooks: {
  customer?: () => Response;
  onIssue?: (auth: string) => void;
}): { fetchImpl: typeof fetch; issueCount: number; customerCount: number } {
  const state: any = { issueCount: 0, customerCount: 0, fetchImpl: null };
  state.fetchImpl = (async (url: string, init: any) => {
    const u = String(url);
    if (u.includes("getCustomerInfo")) {
      state.customerCount++;
      return hooks.customer ? hooks.customer() : Response.json(customerJson());
    }
    if (u.endsWith("/api_keys") && init.method === "GET")
      return Response.json({ code: 200, data: [] });
    if (u.endsWith("/api_keys") && init.method === "POST")
      return Response.json({ code: 200, data: { name: "zcode-api-key", apiKey: "keyid" } });
    if (u.includes("/access_tokens")) {
      state.issueCount++;
      hooks.onIssue?.(init.headers.Authorization);
      return Response.json({
        code: 200,
        data: {
          enable: true,
          accessToken: "pat",
          tokenType: "Bearer",
          expiresIn: 3600,
          expiresAt: Date.now() / 1000 + 3600,
        },
      });
    }
    throw new Error("unexpected " + u);
  }) as typeof fetch;
  return state;
}

describe("AuthService recovery", () => {
  it("retries project location after a transient failure (no permanent cached rejection)", async () => {
    const f = buildFetch({
      customer: () =>
        f.customerCount === 1 ? new Response("busy", { status: 503 }) : Response.json(customerJson()),
    });
    const svc = createAuthServiceInternal({
      env,
      homedir: "/home/u",
      platform: "darwin",
      arch: "arm64",
      osRelease: "24.0",
      readTextFile: async () =>
        JSON.stringify({ "oauth:bigmodel:access_token": cipher.encrypt("oauth-tok") }),
      fetchImpl: f.fetchImpl,
    });
    await expect(svc.getAccessToken()).rejects.toBeTruthy();
    // After the upstream recovers, a later request must succeed and re-call
    // getCustomerInfo instead of replaying the cached rejection.
    const tok = await svc.getAccessToken();
    expect(tok.token).toBe("pat");
    expect(f.customerCount).toBe(2);
  });

  it("force refresh re-reads the login credential after re-login", async () => {
    let currentOauth = "oauth-A";
    const seenIssueAuth: string[] = [];
    const f = buildFetch({ onIssue: (a) => seenIssueAuth.push(a) });
    const svc = createAuthServiceInternal({
      env,
      homedir: "/home/u",
      platform: "darwin",
      arch: "arm64",
      osRelease: "24.0",
      readTextFile: async (p) =>
        p.endsWith("credentials.json")
          ? JSON.stringify({
              "oauth:bigmodel:access_token": cipher.encrypt(currentOauth),
            })
          : JSON.stringify({ deviceMid: "MID" }),
      fetchImpl: f.fetchImpl,
    });
    await svc.getAccessToken();
    currentOauth = "oauth-B";
    await svc.getAccessToken(true);
    expect(seenIssueAuth.at(-1)).toBe("Bearer oauth-B");
  });

  it("concurrent force refreshes share a single issue (singleflight)", async () => {
    const f = buildFetch({});
    const svc = createAuthServiceInternal({
      env,
      homedir: "/home/u",
      platform: "darwin",
      arch: "arm64",
      osRelease: "24.0",
      readTextFile: async (p) =>
        p.endsWith("credentials.json")
          ? JSON.stringify({ "oauth:bigmodel:access_token": cipher.encrypt("oauth-tok") })
          : JSON.stringify({ deviceMid: "MID" }),
      fetchImpl: f.fetchImpl,
    });
    await svc.getAccessToken();
    expect(f.issueCount).toBe(1);
    await Promise.all([svc.getAccessToken(true), svc.getAccessToken(true)]);
    // The two concurrent forced refreshes must coalesce into one re-issue.
    expect(f.issueCount).toBe(2);
  });
});
