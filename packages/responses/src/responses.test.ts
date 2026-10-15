import { describe, it, expect } from "vitest";
import { handleResponses } from "./responses.js";

function ctxWith(upstream: any, stream = false) {
  return {
    auth: {
      getUpstreamHeaders: async () => ({ Authorization: "Bearer pat" }),
    } as any,
    upstreamBaseUrl: "https://bigmodel.cn/api/anthropic",
    fetchImpl: async () =>
      new Response(JSON.stringify(upstream), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
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

  it("rejects unsupported built-in tools with a clear error", async () => {
    const ctx = ctxWith({});
    const req = new Request("http://x/v1/responses", {
      method: "POST",
      body: JSON.stringify({
        input: "hi",
        tools: [{ type: "web_search" }],
      }),
    });
    const res = await handleResponses(req, ctx);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: "unsupported_tool" },
    });
  });
});
