import type { Family } from "./endpoints.js";

const KEY_NAME = "zcode-api-key";

export interface ProjectLocation {
  organizationId: string;
  projectId: string;
  apiKeyId: string;
}

export interface ProjectLocationDeps {
  fetchImpl: typeof fetch;
  managementOrigin: string;
  family: Family;
  loginToken: string;
}

export async function resolveProjectLocation(deps: ProjectLocationDeps): Promise<ProjectLocation> {
  const { origin } = new URL(deps.managementOrigin);
  const authHeader = deps.family === "zai" ? `Bearer ${deps.loginToken}` : deps.loginToken;

  const customer = await getJson(deps.fetchImpl, `${origin}/api/biz/customer/getCustomerInfo`, {
    method: "GET",
    headers: { Authorization: authHeader, "Content-Type": "application/json" },
  });
  const organizations = Array.isArray(customer?.organizations) ? customer.organizations : [];

  const org =
    organizations.find((o: any) => String(o.organizationName ?? "").includes("默认机构")) ??
    organizations[0];
  const project =
    org?.projects?.find((p: any) => String(p.projectName ?? "").includes("默认项目")) ??
    org?.projects?.[0];
  if (!org?.organizationId || !project?.projectId) {
    throw new Error("project_token_project_unavailable");
  }

  const keyUrl =
    `${origin}/api/biz/v1/organization/${encodeURIComponent(org.organizationId)}` +
    `/projects/${encodeURIComponent(project.projectId)}/api_keys`;
  const keyHeaders =
    deps.family === "zai"
      ? { Authorization: authHeader, "Content-Type": "application/json" }
      : {
          Authorization: deps.loginToken,
          "Content-Type": "application/json",
          "bigmodel-organization": org.organizationId,
          "bigmodel-project": project.projectId,
        };

  const list = await getJson(deps.fetchImpl, keyUrl, { method: "GET", headers: keyHeaders });
  const entries = Array.isArray(list) ? list : [];
  const existing = entries.find((e: any) => e && e.name === KEY_NAME && typeof e.apiKey === "string");

  let apiKeyId: string | undefined = existing?.apiKey;
  if (!apiKeyId) {
    const created = await getJson(deps.fetchImpl, keyUrl, {
      method: "POST",
      headers: keyHeaders,
      body: JSON.stringify({ name: KEY_NAME, usageScene: "coding_plan" }),
    });
    apiKeyId = created?.apiKey;
  }
  if (typeof apiKeyId !== "string" || !apiKeyId) {
    throw new Error("project_token_invalid_response");
  }
  return { organizationId: org.organizationId, projectId: project.projectId, apiKeyId };
}

async function getJson(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<any> {
  const res = await fetchImpl(url, init);
  if (res.status === 429 || res.status >= 500) {
    throw new Error("project_token_transient_failure");
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error("project_token_request_failed");
  }
  const body = await res.json();
  const code = body?.code;
  if (code !== undefined && code !== 200 && code !== 0 && code !== "200" && code !== "0") {
    throw new Error("project_token_request_failed");
  }
  return body?.data;
}
