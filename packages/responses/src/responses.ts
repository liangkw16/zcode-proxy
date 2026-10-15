import {
  createThinkingEventFilter,
  parseSSE,
  sendWithAuthRetry,
  serializeSSE,
  stripThinkingFromMessage,
} from "@zcode-proxy/core";
import type { ModelAttribution } from "@zcode-proxy/core";
import { convertResponsesRequest } from "./request-convert.js";
import { convertAnthropicToResponse } from "./response-convert.js";
import { createResponseStreamConverter } from "./stream-convert.js";

export interface ResponsesContext {
  auth: { getUpstreamHeaders: (force?: boolean) => Promise<Record<string, string>> };
  attribution: ModelAttribution;
  upstreamBaseUrl: string;
  fetchImpl: typeof fetch;
}

export async function handleResponses(req: Request, ctx: ResponsesContext): Promise<Response> {
  const inbound = await req.json();

  const { anthropicBody, wantsThinking } = convertResponsesRequest(inbound);

  // Minted once per inbound request so a 401 retry keeps the same correlation ids.
  const attributionHeaders = ctx.attribution.createHeaders();

  const upstream = await sendWithAuthRetry({
    getHeaders: async (force) => ({
      ...(await ctx.auth.getUpstreamHeaders(force)),
      ...attributionHeaders,
    }),
    send: (headers) =>
      ctx.fetchImpl(`${ctx.upstreamBaseUrl}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify(anthropicBody),
      }),
  });

  if (!upstream.ok || !upstream.body) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "content-type": "application/json" },
    });
  }

  if (!anthropicBody.stream) {
    let json = await upstream.json();
    if (!wantsThinking) json = stripThinkingFromMessage(json);
    return Response.json(convertAnthropicToResponse(json, inbound.model));
  }

  const thinkingFilter = createThinkingEventFilter();
  const converter = createResponseStreamConverter({ model: inbound.model });
  const stream = upstream.body
    .pipeThrough(parseSSE())
    .pipeThrough(
      new TransformStream({
        transform(ev, controller) {
          const next = wantsThinking ? ev : thinkingFilter.process(ev);
          if (next) {
            for (const out of converter.process(next)) controller.enqueue(out);
          }
        },
      }),
    )
    .pipeThrough(serializeSSE());
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}
