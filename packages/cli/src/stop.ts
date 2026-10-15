import { readFile } from "node:fs/promises";
import { pidPath } from "./config-dir.js";

export async function stopDaemon(): Promise<boolean> {
  let pid: number;
  try {
    pid = Number((await readFile(pidPath(), "utf-8")).trim());
  } catch {
    return false;
  }
  if (!Number.isFinite(pid)) return false;
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "ESRCH") return false;
    throw error;
  }
}
