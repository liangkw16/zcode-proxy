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

  it("emits OpenAI-shaped events with type, sequence_number and a response envelope", () => {
    const c = createResponseStreamConverter({ model: "gpt-5-codex" });
    const all: SSEEvent[] = [];
    for (const e of [
      ev("message_start", { message: { model: "GLM-5.3" } }),
      ev("content_block_start", { index: 0, content_block: { type: "text" } }),
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "hi" } }),
      ev("content_block_stop", { index: 0 }),
      ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { input_tokens: 1, output_tokens: 1 } }),
      ev("message_stop", {}),
    ]) {
      for (const out of c.process(e)) all.push(out);
    }
    const by = (n: string) => all.find((x) => x.event === n);
    const created = by("response.created")!;
    expect(created.data.type).toBe("response.created");
    expect(created.data.sequence_number).toBe(0);
    expect(created.data.response).toMatchObject({ object: "response", status: "in_progress" });
    const delta = by("response.output_text.delta")!;
    expect(delta.data.type).toBe("response.output_text.delta");
    expect(typeof delta.data.sequence_number).toBe("number");
    const completed = by("response.completed")!;
    expect(completed.data.type).toBe("response.completed");
    expect(completed.data.response).toMatchObject({ object: "response", status: "completed" });
    expect(completed.data.response.usage).toMatchObject({ input_tokens: 1, output_tokens: 1 });
    expect(all.map((x) => x.data.sequence_number)).toEqual(all.map((_, i) => i));
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

  it("maps GLM-dialect thinking deltas (delta.thinking) to reasoning summary", () => {
    const c = createResponseStreamConverter({ model: "gpt-5-codex" });
    c.process(ev("message_start", { message: {} }));
    c.process(ev("content_block_start", { index: 0, content_block: { type: "thinking" } }));
    const deltas = c.process(
      ev("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "reasoning here" } }),
    );
    const summary = deltas.find((e) => e.event === "response.reasoning_summary_text.delta");
    expect(summary?.data.delta).toBe("reasoning here");
  });
});

function runConverter(c: ReturnType<typeof createResponseStreamConverter>, events: any[]): SSEEvent[] {
  const out: SSEEvent[] = [];
  for (const e of events) for (const o of c.process(ev(e.event ?? e.type, e.data ?? e))) out.push(o);
  return out;
}

describe("response stream converter status & usage", () => {
  it("reads input_tokens from message_start and merges output tokens", () => {
    const c = createResponseStreamConverter({ model: "gpt-5-codex" });
    const out = runConverter(c, [
      { event: "message_start", data: { message: { model: "GLM-5.3", usage: { input_tokens: 25 } } } },
      ev("content_block_start", { index: 0, content_block: { type: "text" } }),
      ev("content_block_stop", { index: 0 }),
      ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 15 } }),
      ev("message_stop", {}),
    ]);
    const completed = out.find((e) => e.event === "response.completed");
    expect(completed?.data.response.usage).toEqual({
      input_tokens: 25,
      output_tokens: 15,
      total_tokens: 40,
    });
  });

  it("emits response.incomplete when stop_reason is max_tokens", () => {
    const c = createResponseStreamConverter({ model: "gpt-5-codex" });
    const out = runConverter(c, [
      { event: "message_start", data: { message: { model: "GLM-5.3", usage: { input_tokens: 1 } } } },
      ev("content_block_start", { index: 0, content_block: { type: "text" } }),
      ev("content_block_stop", { index: 0 }),
      ev("message_delta", { delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 4096 } }),
      ev("message_stop", {}),
    ]);
    expect(out.some((e) => e.event === "response.incomplete")).toBe(true);
    expect(out.some((e) => e.event === "response.completed")).toBe(false);
    const incomplete = out.find((e) => e.event === "response.incomplete");
    expect(incomplete?.data.response.status).toBe("incomplete");
    expect(incomplete?.data.response.incomplete_details).toEqual({
      reason: "max_output_tokens",
    });
  });

  it("emits response.failed when an in-stream error arrives after message_start", () => {
    const c = createResponseStreamConverter({ model: "gpt-5-codex" });
    const out = runConverter(c, [
      { event: "message_start", data: { message: { model: "GLM-5.3", usage: { input_tokens: 3 } } } },
      { event: "error", data: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } },
    ]);
    const failed = out.find((e) => e.event === "response.failed");
    expect(failed).toBeTruthy();
    expect(failed?.data.response.status).toBe("failed");
    expect(out.some((e) => e.event === "response.completed")).toBe(false);
  });
});
