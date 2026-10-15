export interface UpstreamRequestInput {
  getHeaders: (force?: boolean) => Promise<Record<string, string>>;
  send: (headers: Record<string, string>) => Promise<Response>;
}

export async function sendWithAuthRetry(input: UpstreamRequestInput): Promise<Response> {
  const firstHeaders = await input.getHeaders(false);
  const first = await input.send(firstHeaders);
  if (first.status !== 401) return first;
  const refreshed = await input.getHeaders(true);
  return input.send(refreshed);
}
