import { ZCODE_APP_VERSION } from "./endpoints.js";
import type { ProjectLocation } from "./project-location.js";

const SECOND = 1000;
const REFRESH_LEAD = 120 * SECOND;
const JITTER = 60 * SECOND;

export interface AccessTokenMaterial {
  token: string;
  expiresAt: number;
}

export interface CacheScope {
  managementOrigin: string;
  location: ProjectLocation;
}

interface Entry {
  value?: AccessTokenMaterial;
  refreshAt?: number;
  pending?: Promise<AccessTokenMaterial>;
}

export class AccessTokenCache {
  #entries = new Map<string, Entry>();
  #now: () => number;
  #random: () => number;

  constructor(options: { now?: () => number; random?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
  }

  async resolve(scope: CacheScope, issue: () => Promise<unknown>): Promise<AccessTokenMaterial> {
    const key = scopeKey(scope);
    let entry = this.#entries.get(key);
    if (entry?.pending) return entry.pending;
    if (entry?.value && this.#now() < Math.min(entry.refreshAt!, entry.value.expiresAt)) {
      return entry.value;
    }
    if (!entry) {
      entry = {};
      this.#entries.set(key, entry);
    }
    const current = entry;
    const startedAt = this.#now();
    const pending = Promise.resolve()
      .then(issue)
      .then((raw) => {
        const data = (raw as { data?: any })?.data;
        if (data && data.enable === false) throw new Error("project_token_disabled");
        if (!data || data.enable !== true || typeof data.accessToken !== "string") {
          throw new Error("project_token_invalid_response");
        }
        const expiresAt = Math.min(
          data.expiresAt * SECOND,
          startedAt + data.expiresIn * SECOND,
        );
        if (!Number.isFinite(expiresAt) || expiresAt <= this.#now()) {
          throw new Error("project_token_invalid_response");
        }
        const jitter = Math.max(0, Math.min(1, this.#random())) * JITTER;
        current.value = { token: data.accessToken, expiresAt };
        current.refreshAt = expiresAt - REFRESH_LEAD - jitter;
        return current.value;
      })
      .catch((error) => {
        this.#entries.delete(key);
        throw error;
      })
      .finally(() => {
        if (current.pending === pending) current.pending = undefined;
      });
    current.pending = pending;
    return pending;
  }

  invalidate(scope: CacheScope): void {
    this.#entries.delete(scopeKey(scope));
  }

  clear(): void {
    this.#entries.clear();
  }
}

export async function issueProjectAccessToken(deps: {
  fetchImpl: typeof fetch;
  managementOrigin: string;
  location: ProjectLocation;
  loginToken: string;
}): Promise<unknown> {
  const { origin } = new URL(deps.managementOrigin);
  const { organizationId, projectId, apiKeyId } = deps.location;
  const url =
    `${origin}/api/biz/v1/organization/${encodeURIComponent(organizationId)}` +
    `/projects/${encodeURIComponent(projectId)}/api_keys/${encodeURIComponent(apiKeyId)}/access_tokens`;
  const res = await deps.fetchImpl(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${deps.loginToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ clientType: "zcode", clientVersion: ZCODE_APP_VERSION }),
  });
  if (!res.ok) throw new Error("project_token_request_failed");
  return res.json();
}

function scopeKey(scope: CacheScope): string {
  return JSON.stringify([new URL(scope.managementOrigin).origin, scope.location]);
}
