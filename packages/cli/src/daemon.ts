import { writeFile, mkdir } from "node:fs/promises";
import { createAuthServiceInternal, defaultNodeDeps } from "@zcode-proxy/auth";
import { createModelMapping, createModelAttribution } from "@zcode-proxy/core";
import { startGateway } from "@zcode-proxy/server";
import { handleMessages, handleHealth, handleModels } from "@zcode-proxy/anthropic";
import { handleResponses } from "@zcode-proxy/responses";
import { configDir, pidPath, portPath, type ProxyConfig } from "./config-dir.js";

export async function runDaemon(config: ProxyConfig): Promise<void> {
  const deps = defaultNodeDeps();
  const auth = createAuthServiceInternal(deps);
  const endpoints = await auth.getEndpoints();
  const modelMapping = createModelMapping(config.modelOverrides);
  const attribution = createModelAttribution();

  const gw = await startGateway(config.port, async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/health") return handleHealth(auth);
    if (url.pathname === "/v1/models" && req.method === "GET") return handleModels();
    if (url.pathname === "/v1/messages" && req.method === "POST")
      return handleMessages(req, {
        auth,
        modelMapping,
        attribution,
        upstreamBaseUrl: endpoints.anthropicBaseUrl,
        fetchImpl: deps.fetchImpl,
      });
    if (url.pathname === "/v1/responses" && req.method === "POST")
      return handleResponses(req, {
        auth,
        attribution,
        upstreamBaseUrl: endpoints.anthropicBaseUrl,
        fetchImpl: deps.fetchImpl,
      });
    return new Response("not found", { status: 404 });
  });

  await mkdir(configDir(), { recursive: true });
  await writeFile(pidPath(), String(process.pid));
  await writeFile(portPath(), String(gw.port));

  const shutdown = async () => {
    await gw.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
