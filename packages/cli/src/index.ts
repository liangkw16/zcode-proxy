export { runDaemon } from "./daemon.js";
export { startBackground } from "./start.js";
export { stopDaemon } from "./stop.js";
export { fetchStatus } from "./status.js";
export type { DaemonStatus } from "./status.js";
export { loadConfig, saveConfig } from "./config-cmd.js";
export { runDoctor } from "./doctor.js";
export type { Check, DoctorDeps } from "./doctor.js";
export { listModels } from "./models-cmd.js";
export { onboardingSnippets } from "./onboarding.js";
export {
  configDir,
  configPath,
  pidPath,
  portPath,
  DEFAULT_CONFIG,
} from "./config-dir.js";
export type { ProxyConfig } from "./config-dir.js";
