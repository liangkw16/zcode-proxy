function randomId(prefix: string): string {
  return prefix + Math.random().toString(36).slice(2, 14);
}

export function convertAnthropicToResponse(anthropic: any, requestModel: string): any {
  const blocks = Array.isArray(anthropic.content) ? anthropic.content : [];
  const output: any[] = [];

  for (const b of blocks) {
    if (b.type === "thinking") {
      const id = randomId("rs_");
      output.push({
        id,
        type: "reasoning",
        role: "assistant",
        summary: [{ type: "summary_text", text: b.thinking ?? "" }],
      });
    } else if (b.type === "text") {
      const id = randomId("msg_");
      output.push({
        id,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: b.text ?? "", annotations: [] }],
      });
    } else if (b.type === "tool_use") {
      const id = randomId("fc_");
      output.push({
        id,
        type: "function_call",
        call_id: b.id,
        name: b.name,
        arguments: JSON.stringify(b.input ?? {}),
        status: "completed",
      });
    }
  }

  const input = anthropic.usage?.input_tokens ?? 0;
  const outputTokens = anthropic.usage?.output_tokens ?? 0;
  return {
    id: randomId("resp_"),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: requestModel,
    output,
    usage: {
      input_tokens: input,
      output_tokens: outputTokens,
      total_tokens: input + outputTokens,
    },
  };
}
