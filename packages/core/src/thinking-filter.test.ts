import { describe, it, expect } from "vitest";
import { stripThinkingFromMessage } from "./thinking-filter.js";

describe("stripThinkingFromMessage", () => {
  it("removes thinking blocks", () => {
    const msg = {
      id: "m",
      role: "assistant",
      content: [
        { type: "thinking", thinking: "secret thoughts" },
        { type: "text", text: "answer" },
      ],
    };
    const out = stripThinkingFromMessage(msg);
    expect(out.content).toHaveLength(1);
    expect(out.content[0]).toEqual({ type: "text", text: "answer" });
  });
  it("keeps tool_use after removing thinking", () => {
    const msg = {
      content: [
        { type: "thinking", thinking: "..." },
        { type: "tool_use", id: "t1", name: "f", input: {} },
      ],
    };
    const out = stripThinkingFromMessage(msg);
    expect(out.content).toHaveLength(1);
    expect(out.content[0].type).toBe("tool_use");
  });
  it("returns messages without content unchanged", () => {
    expect(stripThinkingFromMessage(null)).toBeNull();
  });
});
