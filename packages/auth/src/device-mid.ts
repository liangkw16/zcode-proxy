import { join } from "node:path";

export interface DeviceMidDeps {
  readTextFile: (path: string) => Promise<string>;
  homedir: string;
}

export function telemetryStatePath(homedir: string): string {
  return join(homedir, ".zcode", "v2", "telemetry-state.json");
}

export async function readDeviceMid(deps: DeviceMidDeps): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await deps.readTextFile(telemetryStatePath(deps.homedir)));
    const mid = typeof parsed.deviceMid === "string" ? parsed.deviceMid.trim() : "";
    return mid && /^[\x20-\x7e]+$/.test(mid) ? mid : undefined;
  } catch {
    // deviceMid 由桌面端管理；只读复用，不创建。
    return undefined;
  }
}
