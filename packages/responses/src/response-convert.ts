function randomId(prefix: string): string {
  return prefix + Math.random().toString(36).slice(2, 14);
}

export function statusForStop(stopReason: string | undefined): {
  status: string;
  incomplete_details?: { reason: string };
} {
  if (stopReason === "max_tokens") {
    return { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } };
  }
  if (stopReason === "overloaded_error" || stopReason === "error") {
    return { status: "failed" };
  }
  // end_turn / tool_use / stop_sequence / pause_turn all reach a terminal,
  // usable state.
  return { status: "completed" };
}

export function convertAnthropicToResponse(anthropic: any, requestModel: string): any {
  const blocks = Array.isArray(anthropic.content) ? anthropic.content : [];
  const { status, incomplete_details } = statusForStop(anthropic.stop_reason);
  const itemStatus = status === "completed" ? "completed" : "incomplete";
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
        status: status === "completed" ? "completed" : itemStatus,
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
    status,
    ...(incomplete_details ? { incomplete_details } : {}),
    model: requestModel,
    output,
    usage: {
      input_tokens: input,
      output_tokens: outputTokens,
      total_tokens: input + outputTokens,
    },
  };
}
