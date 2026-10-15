#!/usr/bin/env node
import { parseArgs } from "node:util";
import { runDaemon } from "../dist/daemon.js";
import { startBackground } from "../dist/start.js";
import { stopDaemon } from "../dist/stop.js";
import { fetchStatus } from "../dist/status.js";
import { loadConfig } from "../dist/config-cmd.js";

const { values, positionals } = parseArgs({
  options: { background: { type: "boolean", default: false } },
  allowPositionals: true,
});
const [command] = positionals;
const config = await loadConfig();

if (command === "daemon") {
  await runDaemon(config);
} else if (command === "start") {
  if (values.background) {
    const pid = await startBackground();
    console.log(`zcode-proxy started in background (pid ${pid})`);
    const { onboardingSnippets } = await import("../dist/onboarding.js");
    const snippets = onboardingSnippets(config.port, config.defaultModel);
    console.log("\n--- Claude Code ---\n" + snippets.claudeCode);
    console.log("\n--- Codex ---\n" + snippets.codex + "\n");
  } else {
    const { onboardingSnippets } = await import("../dist/onboarding.js");
    const snippets = onboardingSnippets(config.port, config.defaultModel);
    console.log("zcode-proxy starting on http://127.0.0.1:" + config.port);
    console.log("Claude Code:\n" + snippets.claudeCode + "\n");
    console.log("Codex:\n" + snippets.codex + "\n");
    await runDaemon(config);
  }
} else if (command === "stop") {
  console.log(await stopDaemon() ? "stopped" : "not running");
} else if (command === "status") {
  const s = await fetchStatus(config.port);
  console.log(s.running ? `running on port ${config.port}` : "stopped");
} else if (command === "models") {
  const { listModels } = await import("../dist/models-cmd.js");
  for (const m of await listModels(config.port)) console.log(m.id, m.display_name ?? "");
} else if (command === "doctor") {
  const { runDoctor } = await import("../dist/doctor.js");
  const authMod = await import("@zcode-proxy/auth");
  const auth = authMod.createAuthServiceInternal(authMod.defaultNodeDeps());
  const r = await runDoctor({ auth, fetchImpl: fetch, port: config.port });
  for (const c of r.checks) console.log(`${c.pass ? "✓" : "✗"} ${c.name} ${c.detail ?? ""}`);
  process.exit(r.ok ? 0 : 1);
} else if (command === "config") {
  console.log(await loadConfig());
} else {
  console.log("usage: zcode-proxy <start|stop|status|models|doctor|config> [--background]");
}
