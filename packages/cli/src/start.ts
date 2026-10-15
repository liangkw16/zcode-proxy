import { spawn as nodeSpawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pidPath } from "./config-dir.js";

export interface ChildLike {
  pid: number;
  exitCode: number | null;
  unref(): unknown;
  on(event: string, cb: (...args: any[]) => void): unknown;
}

export interface StartDeps {
  pidFile?: string;
  entryPath?: string;
  readText?: (path: string) => Promise<string>;
  isProcessAlive?: (pid: number) => boolean;
  spawn?: (cmd: string, args: string[], opts: any) => ChildLike;
  waitForHealth?: (port: number) => Promise<boolean>;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export interface StartResult {
  pid: number;
  alreadyRunning?: boolean;
}

async function defaultWaitForHealth(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`);
    return r.ok;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startBackground(
  port: number,
  deps: StartDeps = {},
): Promise<StartResult> {
  const file = deps.pidFile ?? pidPath();
  const readText = deps.readText ?? ((p: string) => readFile(p, "utf8"));
  const isProcessAlive =
    deps.isProcessAlive ??
    ((pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
  const spawn = deps.spawn ?? ((cmd, args, opts) => nodeSpawn(cmd, args, opts) as unknown as ChildLike);
  const waitForHealth = deps.waitForHealth ?? defaultWaitForHealth;
  const pollIntervalMs = deps.pollIntervalMs ?? 100;
  const timeoutMs = deps.timeoutMs ?? 8000;

  // Refuse to start a second instance and never clobber the live pid file:
  // a stale port collision previously made the parent report success while
  // the original daemon kept running and could not be stopped.
  try {
    const existing = Number((await readText(file)).trim());
    if (Number.isInteger(existing) && existing > 0 && isProcessAlive(existing)) {
      return { pid: existing, alreadyRunning: true };
    }
  } catch {
    // No pid file / unreadable: proceed.
  }

  const entry = deps.entryPath ?? process.argv[1];
  const child = spawn(process.execPath, [entry, "daemon", "--port", String(port)], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // The daemon writes its own pid file only after it is listening. Wait for
  // the health endpoint so a failed bind surfaces as an error, not success.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null && child.exitCode !== undefined) {
      throw new Error(`daemon exited with code ${child.exitCode} before becoming ready`);
    }
    if (await waitForHealth(port)) return { pid: child.pid };
    await sleep(pollIntervalMs);
  }
  throw new Error(`daemon did not become ready within ${timeoutMs}ms`);
}
