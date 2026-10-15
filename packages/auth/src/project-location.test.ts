import { describe, it, expect, vi } from "vitest";
import { resolveProjectLocation } from "./project-location.js";

const org = "org-1";
const proj = "proj-1";
function makeFetch(existingKey: boolean) {
  return vi.fn(async (url: string, init: any) => {
    const u = String(url);
    if (u.endsWith("/api/biz/customer/getCustomerInfo")) {
      return new Response(
        JSON.stringify({
          code: 200,
          data: {
            organizations: [
              {
                organizationId: org,
                organizationName: "默认机构",
                projects: [{ projectId: proj, projectName: "默认项目", projectType: "1" }],
              },
            ],
          },
        }),
        { status: 200 },
      );
    }
    if (u.endsWith("/api_keys") && init.method === "GET") {
      return new Response(
        JSON.stringify({ code: 200, data: existingKey ? [{ name: "zcode-api-key", apiKey: "key-1" }] : [] }),
        { status: 200 },
      );
    }
    if (u.endsWith("/api_keys") && init.method === "POST") {
      return new Response(JSON.stringify({ code: 200, data: { name: "zcode-api-key", apiKey: "key-1" } }), {
        status: 200,
      });
    }
    throw new Error("unexpected url " + u);
  });
}

describe("resolveProjectLocation", () => {
  it("reuses existing zcode-api-key", async () => {
    const loc = await resolveProjectLocation({
      fetchImpl: makeFetch(true),
      managementOrigin: "https://bigmodel.cn",
      family: "bigmodel",
      loginToken: "oauth",
    });
    expect(loc).toEqual({ organizationId: org, projectId: proj, apiKeyId: "key-1" });
  });

  it("creates the key when absent", async () => {
    const fetchImpl = makeFetch(false);
    const loc = await resolveProjectLocation({
      fetchImpl,
      managementOrigin: "https://bigmodel.cn",
      family: "bigmodel",
      loginToken: "oauth",
    });
    expect(loc.apiKeyId).toBe("key-1");
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining("/api_keys"), expect.objectContaining({ method: "POST" }));
  });

  it("uses Bearer auth for zai and raw token for bigmodel", async () => {
    const fetchImpl = makeFetch(true);
    await resolveProjectLocation({
      fetchImpl,
      managementOrigin: "https://api.z.ai",
      family: "zai",
      loginToken: "jwt",
    });
    const [, init] = fetchImpl.mock.calls.find(([u]) => String(u).includes("getCustomerInfo"));
    expect(init.headers.Authorization).toBe("Bearer jwt");
  });

  it("throws project_unavailable when no org/project", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ code: 200, data: { organizations: [] } }), { status: 200 }),
    );
    await expect(
      resolveProjectLocation({
        fetchImpl,
        managementOrigin: "https://bigmodel.cn",
        family: "bigmodel",
        loginToken: "oauth",
      }),
    ).rejects.toThrow(/project_unavailable/);
  });
});
