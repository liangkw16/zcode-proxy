import {
  createThinkingEventFilter,
  parseSSE,
  sendWithAuthRetry,
  serializeSSE,
  stripThinkingFromMessage,
} from "@zcode-proxy/core";
import type { ModelMapping, ModelAttribution } from "@zcode-proxy/core";
import { filterAnthropicBeta } from "./beta-filter.js";

export interface MessagesContext {
  auth: {
    getUpstreamHeaders: (force?: boolean, failedToken?: string) => Promise<Record<string, string>>;
  };
  modelMapping: ModelMapping;
  attribution: ModelAttribution;
  signal: AbortSignal;
  upstreamBaseUrl: string;
  fetchImpl: typeof fetch;
}

export async function handleMessages(req: Request, ctx: MessagesContext): Promise<Response> {
  const inbound = await req.json();
  const wantsThinking = Boolean(inbound.thinking);
  const outbound = {
    ...inbound,
    model: ctx.modelMapping.map(inbound.model),
  };
  const body = JSON.stringify(outbound);
  // Minted once per inbound request so a 401 retry keeps the same correlation ids.
  const attributionHeaders = ctx.attribution.createHeaders();

  const upstream = await sendWithAuthRetry({
    getHeaders: async (force) => {
      const base = await ctx.auth.getUpstreamHeaders(force);
      const clientBeta = req.headers.get("anthropic-beta");
      const filtered = filterAnthropicBeta(
        clientBeta ? { ...base, "anthropic-beta": clientBeta } : base,
      );
      return { ...filtered, ...attributionHeaders };
    },
    send: (headers) =>
      ctx.fetchImpl(`${ctx.upstreamBaseUrl}/v1/messages`, {
        method: "POST",
        headers,
        body,
        signal: ctx.signal,
      }),
  });

  if (!upstream.ok || !upstream.body) {
    // Pass through backoff hints on 429/503 per spec §11.
    const headers: Record<string, string> = { "content-type": "application/json" };
    const retryAfter = upstream.headers.get("retry-after");
    if (retryAfter) headers["retry-after"] = retryAfter;
    return new Response(upstream.body, {
      status: upstream.status,
      headers,
    });
  }

  if (!outbound.stream) {
    const json = await upstream.json();
    return Response.json(wantsThinking ? json : stripThinkingFromMessage(json));
  }

  const eventFilter = createThinkingEventFilter();
  const transformed = upstream.body
    .pipeThrough(parseSSE())
    .pipeThrough(
      new TransformStream({
        transform(ev, controller) {
          const r = wantsThinking ? ev : eventFilter.process(ev);
          if (r) controller.enqueue(r);
        },
      }),
    )
    .pipeThrough(serializeSSE());
  return new Response(transformed, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}
