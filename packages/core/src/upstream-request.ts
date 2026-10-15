export interface UpstreamRequestInput {
  getHeaders: (force?: boolean, failedToken?: string) => Promise<Record<string, string>>;
  send: (headers: Record<string, string>) => Promise<Response>;
}

function bearerToken(headers: Record<string, string>): string | undefined {
  const raw = headers["Authorization"] ?? headers["authorization"];
  if (!raw) return undefined;
  const token = raw.replace(/^Bearer\s+/i, "").trim();
  return token || undefined;
}

export async function sendWithAuthRetry(input: UpstreamRequestInput): Promise<Response> {
  const firstHeaders = await input.getHeaders(false);
  const first = await input.send(firstHeaders);
  if (first.status !== 401) return first;
  // Pass the token that actually failed so the auth layer can skip
  // invalidating a newer token that a concurrent request already minted.
  const refreshed = await input.getHeaders(true, bearerToken(firstHeaders));
  return input.send(refreshed);
}
