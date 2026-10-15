import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { configDir, pidPath } from "./config-dir.js";

export async function startBackground(): Promise<number> {
  // Re-exec the current entry point in `daemon` mode. process.argv[1] is the
  // invoked entry in both layouts: packages/cli/bin/zcode-proxy.js under tsc
  // and the bundled single-file executable after install. Using a relative
  // URL to bin/ would break for the esbuild bundle, which ships one file.
  const entry = process.argv[1] ?? "";
  const child = spawn(process.execPath, [entry, "daemon"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  await mkdir(configDir(), { recursive: true });
  await writeFile(pidPath(), String(child.pid));
  return child.pid!;
}
