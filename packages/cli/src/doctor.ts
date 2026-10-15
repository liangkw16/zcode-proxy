export interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

export interface DoctorDeps {
  auth: { getUpstreamHeaders: () => Promise<Record<string, string>> };
  fetchImpl: typeof fetch;
  port: number;
}

export async function runDoctor(deps: DoctorDeps): Promise<{ ok: boolean; checks: Check[] }> {
  const checks: Check[] = [];

  try {
    await deps.auth.getUpstreamHeaders();
    checks.push({ name: "login", pass: true });
  } catch (error) {
    checks.push({ name: "login", pass: false, detail: (error as Error).message });
  }

  try {
    const res = await deps.fetchImpl(`http://127.0.0.1:${deps.port}/health`);
    checks.push({ name: "gateway", pass: res.ok });
  } catch (error) {
    checks.push({ name: "gateway", pass: false, detail: (error as Error).message });
  }

  return { ok: checks.every((c) => c.pass), checks };
}
