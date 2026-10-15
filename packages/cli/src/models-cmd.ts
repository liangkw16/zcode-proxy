export async function listModels(port: number, fetchImpl: typeof fetch = fetch): Promise<any[]> {
  const res = await fetchImpl(`http://127.0.0.1:${port}/v1/models`);
  const body = await res.json();
  return body.data;
}
