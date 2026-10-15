import { describe, it, expect, vi } from "vitest";
import { AccessTokenCache } from "./access-token.js";
import type { ProjectLocation } from "./project-location.js";

const loc: ProjectLocation = { organizationId: "org", projectId: "proj", apiKeyId: "key" };

function issueResponse(token: string, expiresIn: number) {
  return {
    code: 200,
    data: { enable: true, accessToken: token, tokenType: "Bearer", expiresIn, expiresAt: Date.now() / 1000 + expiresIn },
  };
}

describe("AccessTokenCache", () => {
  it("issues and caches a token", async () => {
    const issue = vi.fn(async () => issueResponse("pat-1", 3600));
    const cache = new AccessTokenCache();
    const a = await cache.resolve({ managementOrigin: "https://bigmodel.cn", location: loc }, issue);
    const b = await cache.resolve({ managementOrigin: "https://bigmodel.cn", location: loc }, issue);
    expect(a.token).toBe("pat-1");
    expect(b.token).toBe("pat-1");
    expect(issue).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent misses into one issue", async () => {
    const issue = vi.fn(async () => issueResponse("pat-2", 3600));
    const cache = new AccessTokenCache();
    const [a, b] = await Promise.all([
      cache.resolve({ managementOrigin: "https://bigmodel.cn", location: loc }, issue),
      cache.resolve({ managementOrigin: "https://bigmodel.cn", location: loc }, issue),
    ]);
    expect(a.token).toBe("pat-2");
    expect(b.token).toBe("pat-2");
    expect(issue).toHaveBeenCalledTimes(1);
  });

  it("re-issues when the token is invalidated", async () => {
    const issue = vi.fn(async () => issueResponse("pat-3", 3600));
    const cache = new AccessTokenCache();
    await cache.resolve({ managementOrigin: "https://bigmodel.cn", location: loc }, issue);
    cache.invalidate({ managementOrigin: "https://bigmodel.cn", location: loc });
    await cache.resolve({ managementOrigin: "https://bigmodel.cn", location: loc }, issue);
    expect(issue).toHaveBeenCalledTimes(2);
  });

  it("throws on disabled plan", async () => {
    const issue = vi.fn(async () => ({ code: 200, data: { enable: false } }));
    const cache = new AccessTokenCache();
    await expect(
      cache.resolve({ managementOrigin: "https://bigmodel.cn", location: loc }, issue),
    ).rejects.toThrow(/disabled/);
  });
});
