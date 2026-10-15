export interface DaemonStatus {
  running: boolean;
  health?: any;
}

export async function fetchStatus(
  port: number,
  fetchImpl: typeof fetch = fetch,
): Promise<DaemonStatus> {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/health`);
    return { running: res.ok, health: await res.json().catch(() => null) };
  } catch (error) {
    const code =
      (error as { code?: string }).code ??
      (error as { cause?: { code?: string } }).cause?.code;
    if (code === "ECONNREFUSED") return { running: false };
    throw error;
  }
}
