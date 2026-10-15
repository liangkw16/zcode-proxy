import type { SSEEvent } from "@zcode-proxy/core";

function randomId(prefix: string): string {
  return prefix + Math.random().toString(36).slice(2, 14);
}

type Kind = "message" | "reasoning" | "function_call";

interface RuntimeItem {
  kind: Kind;
  id: string;
  text: string;
  callId?: string;
  name?: string;
  finalize(): any;
}

export function createResponseStreamConverter(opts: { model: string }) {
  const items = new Map<number, RuntimeItem>();
  const order: number[] = [];
  let responseId = "";
  let upstreamModel = opts.model;
  let finalUsage: any = {};
  let createdAt = Math.floor(Date.now() / 1000);
  let seq = 0;

  function responseObject(status: string, output: any[]): any {
    const input = finalUsage.input_tokens ?? 0;
    const outputTokens = finalUsage.output_tokens ?? 0;
    return {
      id: responseId,
      object: "response",
      created_at: createdAt,
      status,
      model: upstreamModel,
      output,
      ...(status === "completed"
        ? {
            usage: {
              input_tokens: input,
              output_tokens: outputTokens,
              total_tokens: input + outputTokens,
            },
          }
        : {}),
    };
  }

  function process(ev: SSEEvent): SSEEvent[] {
    const out: SSEEvent[] = [];
    // Every Responses SSE data payload carries the event `type` and a strictly
    // increasing `sequence_number`; the OpenAI client (Codex) rejects events
    // that omit them. Lifecycle events wrap the full response in `response`.
    const emit = (event: string, data: any) =>
      out.push({ event, data: { type: event, sequence_number: seq++, ...data } });

    switch (ev.event) {
      case "message_start": {
        responseId = randomId("resp_");
        upstreamModel = ev.data?.message?.model ?? upstreamModel;
        createdAt = Math.floor(Date.now() / 1000);
        emit("response.created", { response: responseObject("in_progress", []) });
        emit("response.in_progress", { response: responseObject("in_progress", []) });
        break;
      }
      case "content_block_start": {
        const i = ev.data.index as number;
        const item = startItem(ev.data.content_block);
        items.set(i, item);
        order.push(i);
        emit("response.output_item.added", { output_index: i, item: skeletonOf(item) });
        if (item.kind === "message" || item.kind === "reasoning") {
          emit("response.content_part.added", {
            output_index: i,
            content_index: 0,
            part: partAdded(item),
          });
        }
        break;
      }
      case "content_block_delta": {
        const i = ev.data.index as number;
        const item = items.get(i)!;
        const delta = ev.data.delta;
        if (delta.type === "text_delta") {
          item.text += delta.text;
          emit("response.output_text.delta", {
            output_index: i,
            content_index: 0,
            delta: delta.text,
          });
        } else if (delta.type === "thinking_delta") {
          // Standard Anthropic uses `thinking_delta`; the GLM /api/anthropic
          // compatibility layer emits the text as `thinking` instead.
          const chunk = delta.thinking_delta ?? delta.thinking ?? "";
          item.text += chunk;
          emit("response.reasoning_summary_text.delta", {
            output_index: i,
            content_index: 0,
            summary_index: 0,
            delta: chunk,
          });
        } else if (delta.type === "signature_delta") {
          // Reasoning signatures are not part of the Responses API; drop.
        } else if (delta.type === "input_json_delta") {
          item.text += delta.partial_json;
          emit("response.function_call_arguments.delta", {
            output_index: i,
            delta: delta.partial_json,
          });
        }
        break;
      }
      case "content_block_stop": {
        const i = ev.data.index as number;
        const item = items.get(i)!;
        if (item.kind === "message") {
          emit("response.output_text.done", {
            output_index: i,
            content_index: 0,
            text: item.text,
          });
          emit("response.content_part.done", {
            output_index: i,
            content_index: 0,
            part: { type: "output_text", text: item.text, annotations: [] },
          });
        } else if (item.kind === "reasoning") {
          emit("response.reasoning_summary_text.done", {
            output_index: i,
            content_index: 0,
            summary_index: 0,
            text: item.text,
          });
          emit("response.content_part.done", {
            output_index: i,
            content_index: 0,
            part: { type: "summary_text", text: item.text },
          });
        } else {
          emit("response.function_call_arguments.done", {
            output_index: i,
            arguments: item.text || "{}",
          });
        }
        emit("response.output_item.done", { output_index: i, item: item.finalize() });
        break;
      }
      case "message_delta": {
        if (ev.data?.usage) finalUsage = { ...finalUsage, ...ev.data.usage };
        break;
      }
      case "message_stop": {
        const output = order.map((i) => items.get(i)!.finalize());
        emit("response.completed", { response: responseObject("completed", output) });
        break;
      }
    }
    return out;
  }

  return { process };
}

function startItem(block: any): RuntimeItem {
  if (block.type === "text") {
    const id = randomId("msg_");
    const item: RuntimeItem = {
      kind: "message",
      id,
      text: "",
      finalize() {
        return {
          id,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: item.text, annotations: [] }],
        };
      },
    };
    return item;
  }
  if (block.type === "thinking") {
    const id = randomId("rs_");
    const item: RuntimeItem = {
      kind: "reasoning",
      id,
      text: "",
      finalize() {
        return {
          id,
          type: "reasoning",
          role: "assistant",
          summary: [{ type: "summary_text", text: item.text }],
        };
      },
    };
    return item;
  }
  const id = randomId("fc_");
  const item: RuntimeItem = {
    kind: "function_call",
    id,
    text: "",
    callId: block.id,
    name: block.name,
    finalize() {
      return {
        id,
        type: "function_call",
        call_id: block.id,
        name: block.name,
        arguments: item.text || "{}",
        status: "completed",
      };
    },
  };
  return item;
}

function skeletonOf(item: RuntimeItem): any {
  if (item.kind === "message")
    return { id: item.id, type: "message", role: "assistant", status: "in_progress", content: [] };
  if (item.kind === "reasoning")
    return { id: item.id, type: "reasoning", role: "assistant", summary: [] };
  return {
    id: item.id,
    type: "function_call",
    call_id: item.callId,
    name: item.name,
    arguments: "",
    status: "in_progress",
  };
}

function partAdded(item: RuntimeItem): any {
  return {
    type: item.kind === "message" ? "output_text" : "summary_text",
    text: "",
  };
}
