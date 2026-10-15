import type { SSEEvent } from "./sse.js";

export interface ThinkingEventFilter {
  process(ev: SSEEvent): SSEEvent | null;
}

export function createThinkingEventFilter(): ThinkingEventFilter {
  let skipping = false;
  let outputIndex = -1;

  return {
    process(ev: SSEEvent): SSEEvent | null {
      if (ev.event === "content_block_start") {
        if (ev.data?.content_block?.type === "thinking") {
          skipping = true;
          return null;
        }
        skipping = false;
        outputIndex += 1;
        return { event: ev.event, data: { ...ev.data, index: outputIndex } };
      }
      if (ev.event === "content_block_delta" || ev.event === "content_block_stop") {
        if (skipping) return null;
        return { event: ev.event, data: { ...ev.data, index: outputIndex } };
      }
      return ev;
    },
  };
}
