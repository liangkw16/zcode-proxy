import { writeFile, rename, mkdir } from "node:fs/promises";
import { createAuthServiceInternal, defaultNodeDeps } from "@zcode-proxy/auth";
import { createModelMapping, createModelAttribution } from "@zcode-proxy/core";
import { startGateway } from "@zcode-proxy/server";
import { handleMessages, handleHealth, handleModels } from "@zcode-proxy/anthropic";
import { handleResponses } from "@zcode-proxy/responses";
import { configDir, pidPath, portPath, type ProxyConfig } from "./config-dir.js";

// Write pid/port files atomically (temp + rename) so a concurrent `stop` can
// never read a half-written or empty pid file.
async function writeAtomic(path: string, contents: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, contents, "utf8");
  await rename(tmp, path);
}

export async function runDaemon(config: ProxyConfig): Promise<void> {
  const deps = defaultNodeDeps();
  const auth = createAuthServiceInternal(deps);
  const endpoints = await auth.getEndpoints();
  const modelMapping = createModelMapping(config.modelOverrides);
  const attribution = createModelAttribution();

  const gw = await startGateway(config.port, async (req, reqCtx) => {
    const url = new URL(req.url);
    if (url.pathname === "/health") return handleHealth(auth);
    if (url.pathname === "/v1/models" && req.method === "GET") return handleModels();
    if (url.pathname === "/v1/messages" && req.method === "POST")
      return handleMessages(req, {
        auth,
        modelMapping,
        attribution,
        signal: reqCtx.signal,
        upstreamBaseUrl: endpoints.anthropicBaseUrl,
        fetchImpl: deps.fetchImpl,
      });
    if (url.pathname === "/v1/responses" && req.method === "POST")
      return handleResponses(req, {
        auth,
        modelMapping,
        attribution,
        signal: reqCtx.signal,
        upstreamBaseUrl: endpoints.anthropicBaseUrl,
        fetchImpl: deps.fetchImpl,
      });
    return new Response("not found", { status: 404 });
  });

  await mkdir(configDir(), { recursive: true });
  await writeAtomic(pidPath(), String(process.pid));
  await writeAtomic(portPath(), String(gw.port));

  const shutdown = async () => {
    await gw.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
