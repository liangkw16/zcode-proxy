import {
  createThinkingEventFilter,
  parseSSE,
  sendWithAuthRetry,
  serializeSSE,
  stripThinkingFromMessage,
} from "@zcode-proxy/core";
import { convertResponsesRequest } from "./request-convert.js";
import { convertAnthropicToResponse } from "./response-convert.js";
import { createResponseStreamConverter } from "./stream-convert.js";

export interface ResponsesContext {
  auth: { getUpstreamHeaders: (force?: boolean) => Promise<Record<string, string>> };
  upstreamBaseUrl: string;
  fetchImpl: typeof fetch;
}

export async function handleResponses(req: Request, ctx: ResponsesContext): Promise<Response> {
  const inbound = await req.json();

  const unsupported = (inbound.tools ?? []).find((t: any) => t.type !== "function");
  if (unsupported) {
    return new Response(
      JSON.stringify({
        error: {
          code: "unsupported_tool",
          message: `tool type ${unsupported.type} is not supported`,
        },
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  const { anthropicBody, wantsThinking } = convertResponsesRequest(inbound);

  const upstream = await sendWithAuthRetry({
    getHeaders: (force) => ctx.auth.getUpstreamHeaders(force),
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
