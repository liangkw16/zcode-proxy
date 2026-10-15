import type { ModelMapping } from "@zcode-proxy/core";

export interface ConvertedResponsesRequest {
  anthropicBody: any;
  wantsThinking: boolean;
  unsupportedTool?: string;
}

interface FunctionTool {
  name: string;
  description?: string;
  parameters?: any;
  strict?: boolean;
}

// Tool types that are client-hosted / native capabilities with no upstream
// Anthropic equivalent. They are dropped by default so clients (e.g. Codex)
// that always send them still work; an explicitly required choice errors.
const NATIVE_TOOL_TYPES = new Set([
  "web_search",
  "file_search",
  "code_interpreter",
  "computer_use",
  "local_shell",
  "mcp",
]);

function normalizeTools(tools: any[] | undefined): {
  functions: FunctionTool[];
  dropped: Set<string>;
} {
  const functions: FunctionTool[] = [];
  const dropped = new Set<string>();

  const visit = (tool: any) => {
    if (!tool || typeof tool !== "object") return;
    if (tool.type === "function") {
      functions.push({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: tool.strict,
      });
    } else if (tool.type === "namespace" && Array.isArray(tool.tools)) {
      // Namespace containers hold inner functions; lift them to the top level.
      for (const inner of tool.tools) visit(inner);
    } else if (NATIVE_TOOL_TYPES.has(tool.type) || tool.type !== "function") {
      dropped.add(tool.name ?? tool.type);
    }
  };

  for (const tool of tools ?? []) visit(tool);
  return { functions, dropped };
}

function normalizeContentParts(raw: any): any[] {
  if (typeof raw === "string") return [{ type: "input_text", text: raw }];
  if (!Array.isArray(raw)) return [];
  return raw;
}

function normalizeItems(input: any): any[] {
  if (typeof input === "string") return [{ type: "message", role: "user", content: input }];
  if (!Array.isArray(input)) return [];
  // The official SDK lets message items omit `type` (inferred from role).
  for (const item of input) {
    if (item && typeof item === "object" && !item.type && item.role) item.type = "message";
  }
  return input;
}

function toImageBlock(part: any): any {
  const ref = part.image_url;
  const url = typeof ref === "string" ? ref : (ref?.url ?? "");
  if (url.startsWith("data:")) {
    const m = url.match(/^data:([^;,]+)?(?:;base64)?,(.*)$/s);
    if (m) {
      return {
        type: "image",
        source: { type: "base64", media_type: m[1] || "image/png", data: m[2] },
      };
    }
  }
  if (/^https?:\/\//i.test(url)) {
    return { type: "image", source: { type: "url", url } };
  }
  // Unsupported scheme (e.g. local file path) — emit a text placeholder rather
  // than an invalid base64 block with no data.
  return { type: "text", text: "[unsupported image source]" };
}

function toAnthropicContent(parts: any[]): any[] {
  const blocks: any[] = [];
  for (const part of parts) {
    if (part.type === "input_text" || part.type === "text") {
      blocks.push({ type: "text", text: part.text ?? "" });
    } else if (part.type === "input_image" || part.type === "image_url") {
      blocks.push(toImageBlock(part));
    } else {
      // Unknown input content shape; surface it rather than silently dropping.
      throw new Error(`unsupported_response_content:${part.type ?? "unknown"}`);
    }
  }
  return blocks;
}

function toToolResultContent(output: any): any {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output
      .map((p) => (typeof p === "string" ? p : p.text ?? p.content ?? ""))
      .join("");
  }
  return output?.output ?? JSON.stringify(output);
}

function convertToolArguments(raw: any): any {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return raw ?? {};
}

// Map Responses tool_choice to Anthropic tool_choice.
export function convertToolChoice(choice: any, parallelToolCalls: boolean): any {
  if (choice === "required" || choice === "any") {
    return { type: "any", disable_parallel_tool_use: !parallelToolCalls };
  }
  if (choice === "auto" || choice === undefined) return { type: "auto" };
  if (choice?.type === "function" && choice.name) {
    return { type: "tool", name: choice.name, disable_parallel_tool_use: !parallelToolCalls };
  }
  return { type: "auto" };
}

function thinkingFromReasoning(reasoning: any): {
  wantsThinking: boolean;
  thinking: any;
} {
  if (!reasoning) return { wantsThinking: false, thinking: undefined };
  const effort = reasoning.effort ?? "medium";
  const budgetMap: Record<string, number> = {
    low: 1024,
    minimal: 1024,
    medium: 4096,
    high: 16384,
  };
  // Codex sends {summary:"auto"} without an effort; treat the presence of
  // reasoning config as wanting thinking with a medium budget.
  const wantsThinking = true;
  const budget_tokens = budgetMap[effort] ?? 4096;
  return { wantsThinking, thinking: { type: "enabled", budget_tokens } };
}

export function convertResponsesRequest(
  inbound: any,
  modelMapping?: ModelMapping,
): ConvertedResponsesRequest {
  const items = normalizeItems(inbound.input);

  const messages: any[] = [];
  let pendingToolResult: any[] | null = null;

  for (const item of items) {
    if (item.type === "message") {
      messages.push({
        role: item.role === "assistant" ? "assistant" : "user",
        content: toAnthropicContent(normalizeContentParts(item.content)),
      });
    } else if (item.type === "function_call") {
      messages.push({
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: item.call_id ?? item.id,
            name: item.name,
            input: convertToolArguments(item.arguments),
          },
        ],
      });
    } else if (item.type === "function_call_output") {
      if (!pendingToolResult) pendingToolResult = [];
      pendingToolResult.push({
        type: "tool_result",
        tool_use_id: item.call_id,
        content: toToolResultContent(item.output),
      });
    } else if (item.type === "reasoning") {
      // Reasoning history is not forwarded upstream.
      continue;
    } else {
      throw new Error(`unsupported_response_item:${item.type ?? "unknown"}`);
    }

    // Flush a tool result group before the next assistant/non-result item.
    if (item.type !== "function_call_output" && pendingToolResult) {
      messages.push({ role: "user", content: pendingToolResult });
      pendingToolResult = null;
    }
  }
  if (pendingToolResult) messages.push({ role: "user", content: pendingToolResult });

  const { functions, dropped } = normalizeTools(inbound.tools);

  // tool_choice validation for dropped native tools (spec §9): silently
  // dropping is fine on auto, but a choice that requires a dropped capability
  // must fail loudly instead of silently removing it.
  let unsupportedTool: string | undefined;
  let toolChoice: any = undefined;
  if (inbound.tool_choice && inbound.tool_choice !== "none") {
    const tc = inbound.tool_choice;
    if (tc === "required" || tc === "any") {
      if (functions.length === 0) {
        unsupportedTool = [...dropped].join(",") || "required";
      }
    } else if (tc?.type === "function" && tc.name && dropped.has(tc.name)) {
      unsupportedTool = tc.name;
    }
    if (!unsupportedTool) {
      toolChoice = convertToolChoice(tc, inbound.parallel_tool_calls !== false);
    }
  }

  const { wantsThinking, thinking } = thinkingFromReasoning(inbound.reasoning);

  const anthropicBody: any = {
    model: modelMapping ? modelMapping.map(inbound.model) : inbound.model,
    max_tokens: inbound.max_output_tokens ?? 4096,
    stream: Boolean(inbound.stream),
    messages,
  };
  if (inbound.instructions) anthropicBody.system = inbound.instructions;
  if (inbound.temperature !== undefined) anthropicBody.temperature = inbound.temperature;
  if (inbound.top_p !== undefined) anthropicBody.top_p = inbound.top_p;
  if (inbound.stop) anthropicBody.stop_sequences = inbound.stop;

  if (inbound.tool_choice !== "none" && functions.length > 0 && !unsupportedTool) {
    anthropicBody.tools = functions.map((f) => ({
      name: f.name,
      description: f.description,
      input_schema: f.parameters ?? { type: "object", properties: {} },
    }));
    if (toolChoice) anthropicBody.tool_choice = toolChoice;
  }
  if (thinking) anthropicBody.thinking = thinking;

  return { anthropicBody, wantsThinking, unsupportedTool };
}
