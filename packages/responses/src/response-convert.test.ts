import { describe, it, expect } from "vitest";
import { convertAnthropicToResponse } from "./response-convert.js";

describe("convertAnthropicToResponse", () => {
  it("maps thinking/text/tool_use into ordered output items", () => {
    const resp = convertAnthropicToResponse(
      {
        content: [
          { type: "thinking", thinking: "thought" },
          { type: "text", text: "answer" },
          { type: "tool_use", id: "call_9", name: "f", input: { a: 1 } },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      "gpt-5-codex",
    );
    expect(resp.object).toBe("response");
    expect(resp.status).toBe("completed");
    expect(resp.output.map((i: any) => i.type)).toEqual([
      "reasoning",
      "message",
      "function_call",
    ]);
    expect(resp.output[1].content[0]).toEqual({
      type: "output_text",
      text: "answer",
      annotations: [],
    });
    expect(resp.output[2]).toMatchObject({
      type: "function_call",
      call_id: "call_9",
      name: "f",
      arguments: '{"a":1}',
    });
    expect(resp.usage.total_tokens).toBe(15);
  });
});

describe("convertAnthropicToResponse status mapping", () => {
  const base = (stopReason: string) => ({
    stop_reason: stopReason,
    content: [{ type: "text", text: "part" }],
    usage: { input_tokens: 2, output_tokens: 10 },
  });

  it("marks max_tokens truncation as incomplete with reason", () => {
    const resp = convertAnthropicToResponse(base("max_tokens"), "m");
    expect(resp.status).toBe("incomplete");
    expect(resp.incomplete_details).toEqual({ reason: "max_output_tokens" });
  });

  it("marks end_turn as completed", () => {
    const resp = convertAnthropicToResponse(base("end_turn"), "m");
    expect(resp.status).toBe("completed");
    expect(resp.incomplete_details).toBeUndefined();
  });

  it("marks overloaded stop as failed", () => {
    const resp = convertAnthropicToResponse(base("overloaded_error"), "m");
    expect(resp.status).toBe("failed");
  });
});
