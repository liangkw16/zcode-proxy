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

if (command === "daemon") await runDaemon(config);
else if (command === "start") {
  if (values.background) {
    const pid = await startBackground();
    console.log(`zcode-proxy started in background (pid ${pid})`);
  } else {
    await runDaemon(config);
  }
} else if (command === "stop") console.log(await stopDaemon() ? "stopped" : "not running");
else if (command === "status") {
  const s = await fetchStatus(config.port);
  console.log(s.running ? `running on port ${config.port}` : "stopped");
} else {
  console.log("usage: zcode-proxy <start|stop|status|daemon> [--background]");
}
