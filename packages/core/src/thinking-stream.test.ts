import { describe, it, expect } from "vitest";
import { createThinkingEventFilter } from "./thinking-stream.js";
import type { SSEEvent } from "./sse.js";

function ev(event: string, data: any): SSEEvent {
  return { event, data };
}

describe("thinking stream filter", () => {
  it("drops a leading thinking block and reindexes the text block", () => {
    const f = createThinkingEventFilter();
    const out: SSEEvent[] = [];
    for (const e of [
      ev("content_block_start", { index: 0, content_block: { type: "thinking" } }),
      ev("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking_delta: "x" } }),
      ev("content_block_stop", { index: 0 }),
      ev("content_block_start", { index: 1, content_block: { type: "text" } }),
      ev("content_block_delta", { index: 1, delta: { type: "text_delta", text: "hi" } }),
      ev("content_block_stop", { index: 1 }),
    ]) {
      const r = f.process(e);
      if (r) out.push(r);
    }
    expect(out).toHaveLength(3);
    expect(out[0].event).toBe("content_block_start");
    expect(out[0].data.index).toBe(0);
    expect(out[0].data.content_block.type).toBe("text");
    expect(out[1].data.index).toBe(0);
    expect(out[2].data.index).toBe(0);
  });

  it("keeps thinking when filter not used (pass-through handled by caller)", () => {
    const f = createThinkingEventFilter();
    const start = ev("content_block_start", { index: 0, content_block: { type: "text" } });
    expect(f.process(start)!.data.index).toBe(0);
  });

  it("reindexes when thinking appears between two text blocks", () => {
    const f = createThinkingEventFilter();
    const seq = [
      ev("content_block_start", { index: 0, content_block: { type: "text" } }),
      ev("content_block_stop", { index: 0 }),
      ev("content_block_start", { index: 1, content_block: { type: "thinking" } }),
      ev("content_block_stop", { index: 1 }),
      ev("content_block_start", { index: 2, content_block: { type: "text" } }),
      ev("content_block_stop", { index: 2 }),
    ];
    const kept = seq.map((e) => f.process(e)).filter(Boolean) as SSEEvent[];
    const starts = kept.filter((e) => e.event === "content_block_start");
    expect(starts.map((e) => e.data.index)).toEqual([0, 1]);
  });
});
