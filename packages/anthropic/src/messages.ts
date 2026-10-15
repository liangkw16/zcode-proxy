import {
  createThinkingEventFilter,
  parseSSE,
  sendWithAuthRetry,
  serializeSSE,
  stripThinkingFromMessage,
} from "@zcode-proxy/core";
import type { ModelMapping } from "@zcode-proxy/core";
import { filterAnthropicBeta } from "./beta-filter.js";

export interface MessagesContext {
  auth: { getUpstreamHeaders: (force?: boolean) => Promise<Record<string, string>> };
  modelMapping: ModelMapping;
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

  const upstream = await sendWithAuthRetry({
    getHeaders: async (force) => {
      const base = await ctx.auth.getUpstreamHeaders(force);
      const clientBeta = req.headers.get("anthropic-beta");
      return filterAnthropicBeta(clientBeta ? { ...base, "anthropic-beta": clientBeta } : base);
    },
    send: (headers) =>
      ctx.fetchImpl(`${ctx.upstreamBaseUrl}/v1/messages`, {
        method: "POST",
        headers,
        body,
      }),
  });

  if (!upstream.ok || !upstream.body) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "content-type": "application/json" },
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
