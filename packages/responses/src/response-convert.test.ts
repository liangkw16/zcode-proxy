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
