import {
  createThinkingEventFilter,
  parseSSE,
  sendWithAuthRetry,
  serializeSSE,
  stripThinkingFromMessage,
} from "@zcode-proxy/core";
import type { ModelAttribution, ModelMapping } from "@zcode-proxy/core";
import { convertResponsesRequest } from "./request-convert.js";
import { convertAnthropicToResponse } from "./response-convert.js";
import { createResponseStreamConverter } from "./stream-convert.js";

export interface ResponsesContext {
  auth: {
    getUpstreamHeaders: (force?: boolean, failedToken?: string) => Promise<Record<string, string>>;
  };
  modelMapping: ModelMapping;
  attribution: ModelAttribution;
  signal: AbortSignal;
  upstreamBaseUrl: string;
  fetchImpl: typeof fetch;
}

export async function handleResponses(req: Request, ctx: ResponsesContext): Promise<Response> {
  const inbound = await req.json();

  const { anthropicBody, wantsThinking, unsupportedTool } = convertResponsesRequest(
    inbound,
    ctx.modelMapping,
  );

  if (unsupportedTool) {
    return Response.json(
      {
        error: {
          type: "unsupported_tool",
          message: `tool '${unsupportedTool}' is not supported by zcode-proxy`,
        },
      },
      { status: 400 },
    );
  }

  // Minted once per inbound request so a 401 retry keeps the same correlation ids.
  const attributionHeaders = ctx.attribution.createHeaders();

  const upstream = await sendWithAuthRetry({
    getHeaders: async (force, failedToken) => ({
      ...(await ctx.auth.getUpstreamHeaders(force, failedToken)),
      ...attributionHeaders,
    }),
    send: (headers) =>
      ctx.fetchImpl(`${ctx.upstreamBaseUrl}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify(anthropicBody),
        signal: ctx.signal,
      }),
  });

  if (!upstream.ok || !upstream.body) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const retryAfter = upstream.headers.get("retry-after");
    if (retryAfter) headers["retry-after"] = retryAfter;
    return new Response(upstream.body, {
      status: upstream.status,
      headers,
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
