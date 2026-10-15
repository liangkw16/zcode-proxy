import { describe, it, expect, vi } from "vitest";
import { handleResponses } from "./responses.js";
import { createModelMapping } from "@zcode-proxy/core";

function ctxWith(upstream: any, stream = false, upstreamInit: ResponseInit = {}) {
  return {
    auth: {
      getUpstreamHeaders: async () => ({ Authorization: "Bearer pat" }),
    } as any,
    modelMapping: createModelMapping(),
    signal: new AbortController().signal,
    upstreamBaseUrl: "https://bigmodel.cn/api/anthropic",
    fetchImpl: vi.fn(
      async () =>
        new Response(
          JSON.stringify(upstream),
          upstreamInit.status
            ? upstreamInit
            : { status: 200, headers: { "content-type": "application/json" } },
        ),
    ),
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

describe("handleResponses", () => {
  it("returns a Responses object for a non-stream request", async () => {
    const ctx = ctxWith({
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const req = new Request("http://x/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5-codex", input: "hi" }),
    });
    const res = await handleResponses(req, ctx);
    const body = await res.json();
    expect(body.object).toBe("response");
    expect(body.output[0].content[0].text).toBe("ok");
  });

  it("ignores native-only tools instead of failing the request", async () => {
    const ctx = ctxWith({
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const req = new Request("http://x/v1/responses", {
      method: "POST",
      body: JSON.stringify({
        input: "hi",
        tools: [{ type: "web_search", external_web_access: false }],
      }),
    });
    const res = await handleResponses(req, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ object: "response" });
  });

  it("injects zcode per-request attribution headers on the upstream call", async () => {
    const ctx = ctxWith({
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const req = new Request("http://x/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5-codex", input: "hi" }),
    });
    await handleResponses(req, ctx);
    const sent = new Headers(ctx.fetchImpl.mock.calls[0][1].headers);
    expect(sent.get("x-zcode-session-type")).toBe("main");
    expect(sent.get("x-zcode-query-source")).toBe("main_turn");
    expect(sent.get("x-request-id")).toBe("req-1");
    expect(sent.get("x-session-id")).toBe("sess-1");
  });
});

describe("handleResponses errors & abort", () => {
  it("returns 400 unsupported_tool when a required native tool is dropped", async () => {
    const ctx = ctxWith({});
    const req = new Request("http://x/v1/responses", {
      method: "POST",
      body: JSON.stringify({
        input: "hi",
        tools: [{ type: "web_search", name: "web_search" }],
        tool_choice: "required",
      }),
    });
    const res = await handleResponses(req, ctx);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { type: "unsupported_tool" } });
  });

  it("passes through upstream Retry-After on 429", async () => {
    const ctx = ctxWith(
      { error: { type: "rate_limit_error" } },
      false,
      { status: 429, headers: { "content-type": "application/json", "retry-after": "30" } },
    );
    const req = new Request("http://x/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5-codex", input: "hi" }),
    });
    const res = await handleResponses(req, ctx);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
  });

  it("forwards the client abort signal to the upstream fetch", async () => {
    const ctx = ctxWith({ content: [{ type: "text", text: "ok" }] });
    const controller = new AbortController();
    ctx.signal = controller.signal;
    const req = new Request("http://x/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5-codex", input: "hi" }),
    });
    await handleResponses(req, ctx);
    expect(ctx.fetchImpl.mock.calls[0][1].signal).toBe(controller.signal);
  });
});
