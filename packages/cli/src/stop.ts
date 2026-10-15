import { readFile } from "node:fs/promises";
import { pidPath } from "./config-dir.js";

export interface StopDeps {
  pidFile?: string;
  readText?: (path: string) => Promise<string>;
  kill?: (pid: number, signal: string) => void;
}

export async function stopDaemon(deps: StopDeps = {}): Promise<boolean> {
  const file = deps.pidFile ?? pidPath();
  const readText = deps.readText ?? ((p: string) => readFile(p, "utf8"));
  const kill = deps.kill ?? ((pid: number, signal: string) => process.kill(pid, signal as any));

  let raw: string;
  try {
    raw = await readText(file);
  } catch {
    return false;
  }

  const pid = Number(raw.trim());
  // Never signal on empty/garbage pid: Number("") === 0 and process.kill(0)
  // would target the caller's own process group.
  if (!Number.isInteger(pid) || pid <= 0) return false;

  try {
    kill(pid, "SIGTERM");
    return true;
  } catch (e: any) {
    if (e?.code === "ESRCH") return false;
    throw e;
  }
}
