import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { configDir, pidPath } from "./config-dir.js";

export async function startBackground(): Promise<number> {
  // This module compiles to dist/start.js; the executable lives in ../bin.
  const entry = fileURLToPath(new URL("../bin/zcode-proxy.js", import.meta.url));
  const child = spawn(process.execPath, [entry, "daemon"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  await mkdir(configDir(), { recursive: true });
  await writeFile(pidPath(), String(child.pid));
  return child.pid!;
}
