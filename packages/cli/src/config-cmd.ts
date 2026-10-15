import { readFile, writeFile, mkdir } from "node:fs/promises";
import { configDir, configPath, DEFAULT_CONFIG, type ProxyConfig } from "./config-dir.js";

export async function loadConfig(): Promise<ProxyConfig> {
  try {
    const raw = await readFile(configPath(), "utf-8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function saveConfig(config: ProxyConfig): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  await writeFile(configPath(), JSON.stringify(config, null, 2));
}
