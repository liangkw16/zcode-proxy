export interface BusinessLoginDeps {
  fetchImpl: typeof fetch;
  loginUrl: string;
  oauthAccessToken: string;
}

export async function loginWithZaiBusinessJwt(deps: BusinessLoginDeps): Promise<string> {
  const res = await deps.fetchImpl(deps.loginUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: deps.oauthAccessToken }),
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error("project_token_login_failed");
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error("project_token_login_failed");
  }
  const token = (body as { data?: { token?: unknown } })?.data?.token;
  if (typeof token !== "string" || !token.trim()) {
    throw new Error("project_token_login_failed");
  }
  return token.trim();
}
