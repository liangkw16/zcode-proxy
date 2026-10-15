import { describe, it, expect } from "vitest";
import { createResponseStreamConverter } from "./stream-convert.js";
import type { SSEEvent } from "@zcode-proxy/core";

function ev(event: string, data: any): SSEEvent {
  return { event, data };
}

describe("response stream converter", () => {
  it("emits the full Responses event sequence for a text answer", () => {
    const c = createResponseStreamConverter({ model: "gpt-5-codex" });
    const events: string[] = [];
    for (const e of [
      ev("message_start", { message: { model: "GLM-5.3" } }),
      ev("content_block_start", { index: 0, content_block: { type: "text" } }),
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "hi" } }),
      ev("content_block_stop", { index: 0 }),
      ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { input_tokens: 1, output_tokens: 1 } }),
      ev("message_stop", {}),
    ]) {
      for (const out of c.process(e)) events.push(out.event);
    }
    expect(events).toContain("response.created");
    expect(events).toContain("response.output_item.added");
    expect(events).toContain("response.output_text.delta");
    expect(events).toContain("response.output_item.done");
    expect(events.at(-1)).toBe("response.completed");
  });

  it("maps tool_use deltas to function_call_arguments", () => {
    const c = createResponseStreamConverter({ model: "gpt-5-codex" });
    c.process(ev("message_start", { message: {} }));
    const started = c.process(
      ev("content_block_start", {
        index: 0,
        content_block: { type: "tool_use", id: "call_1", name: "f" },
      }),
    );
    expect(started.map((e) => e.event)).toContain("response.output_item.added");
    const deltas = c.process(
      ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"a":' } }),
    );
    expect(deltas.map((e) => e.event)).toContain("response.function_call_arguments.delta");
  });
});
