import { describe, it, expect, vi } from "vitest";
import { handleMessages } from "./messages.js";
import { createModelMapping } from "@zcode-proxy/core";

function makeCtx(upstream: Response, opts: { headers?: Record<string, string> } = {}) {
  const getHeaders = vi.fn(async () => opts.headers ?? { Authorization: "Bearer pat", "anthropic-version": "2023-06-01" });
  return {
    auth: { getUpstreamHeaders: getHeaders } as any,
    modelMapping: createModelMapping(),
    signal: new AbortController().signal,
    upstreamBaseUrl: "https://bigmodel.cn/api/anthropic",
    fetchImpl: vi.fn(async () => upstream),
    attribution: {
      createHeaders: vi.fn(() => ({
        "x-request-id": "req-1",
        "x-zcode-session-type": "main",
        "x-zcode-trace-id": "trace-1",
        "x-query-id": "q-1",
        "x-zcode-query-source": "main_turn",
        "x-session-id": "sess-1",
      })),
    } as any,
  };
}

describe("handleMessages", () => {
  it("maps model and strips thinking when client did not enable it", async () => {
    const upstream = Response.json({
      content: [
        { type: "thinking", thinking: "..." },
        { type: "text", text: "answer" },
      ],
    });
    const ctx = makeCtx(upstream);
    const req = new Request("http://x/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-sonnet-4-5", stream: false }),
    });
    const res = await handleMessages(req, ctx);
    const body = await res.json();
    expect(body.content).toHaveLength(1);
    expect(body.content[0].type).toBe("text");
  });

  it("keeps thinking when client enabled it", async () => {
    const upstream = Response.json({
      content: [
        { type: "thinking", thinking: "reason" },
        { type: "text", text: "answer" },
      ],
    });
    const ctx = makeCtx(upstream);
    const req = new Request("http://x/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        stream: false,
        thinking: { type: "enabled", budget_tokens: 4096 },
      }),
    });
    const res = await handleMessages(req, ctx);
    expect((await res.json()).content).toHaveLength(2);
  });

  it("injects zcode per-request attribution headers on the upstream call", async () => {
    const upstream = Response.json({ content: [{ type: "text", text: "ok" }] });
    const ctx = makeCtx(upstream);
    const req = new Request("http://x/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-sonnet-4-5", stream: false }),
    });
    await handleMessages(req, ctx);
    const sentInit = ctx.fetchImpl.mock.calls[0][1];
    const sent = new Headers(sentInit.headers);
    expect(sent.get("x-zcode-session-type")).toBe("main");
    expect(sent.get("x-zcode-query-source")).toBe("main_turn");
    expect(sent.get("x-request-id")).toBe("req-1");
    expect(sent.get("x-zcode-trace-id")).toBe("trace-1");
    expect(sent.get("x-query-id")).toBe("q-1");
    expect(sent.get("x-session-id")).toBe("sess-1");
  });
});

describe("handleMessages error & abort", () => {
  it("passes through upstream Retry-After on 429", async () => {
    const upstream = new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "30" },
    });
    const ctx = makeCtx(upstream);
    const req = new Request("http://x/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-sonnet", stream: false }),
    });
    const res = await handleMessages(req, ctx);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
  });

  it("passes through Retry-After on 503", async () => {
    const upstream = new Response(JSON.stringify({ error: { type: "api_error" } }), {
      status: 503,
      headers: { "content-type": "application/json", "retry-after": "5" },
    });
    const ctx = makeCtx(upstream);
    const req = new Request("http://x/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-sonnet", stream: false }),
    });
    const res = await handleMessages(req, ctx);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
  });

  it("forwards the client abort signal to the upstream fetch", async () => {
    const upstream = Response.json({ content: [{ type: "text", text: "ok" }] });
    const controller = new AbortController();
    const ctx = makeCtx(upstream);
    ctx.signal = controller.signal;
    const req = new Request("http://x/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-sonnet", stream: false }),
    });
    await handleMessages(req, ctx);
    expect(ctx.fetchImpl.mock.calls[0][1].signal).toBe(controller.signal);
  });
});
