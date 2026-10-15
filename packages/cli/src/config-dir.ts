import { homedir } from "node:os";
import { join } from "node:path";

export interface ProxyConfig {
  port: number;
  defaultModel: string;
  modelOverrides: Record<string, string>;
  logLevel: string;
}

export const DEFAULT_CONFIG: ProxyConfig = {
  port: 8792,
  defaultModel: "GLM-5.3",
  modelOverrides: {},
  logLevel: "info",
};

export function configDir(): string {
  return join(homedir(), ".zcode-proxy");
}
export function configPath(): string {
  return join(configDir(), "config.json");
}
export function pidPath(): string {
  return join(configDir(), "daemon.pid");
}
export function portPath(): string {
  return join(configDir(), "daemon.port");
}
