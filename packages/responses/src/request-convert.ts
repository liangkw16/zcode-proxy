const EFFORT_BUDGETS: Record<string, number> = {
  low: 1024,
  medium: 4096,
  high: 16384,
};

export interface ConvertedRequest {
  anthropicBody: any;
  wantsThinking: boolean;
}

export function convertToolChoice(choice: any, parallel = true): any {
  const disable = !parallel;
  if (choice === "required")
    return { type: "any", disable_parallel_tool_use: disable };
  if (typeof choice === "object" && choice?.type === "function")
    return { type: "tool", name: choice.name, disable_parallel_tool_use: disable };
  // "auto" 或缺省
  return { type: "auto", disable_parallel_tool_use: disable };
}

export function convertResponsesRequest(body: any): ConvertedRequest {
  const rawItems = Array.isArray(body.input)
    ? body.input
    : [{ type: "message", role: "user", content: [{ type: "input_text", text: body.input ?? "" }] }];

  const messages = convertItems(rawItems);

  // Codex (and some OpenAI clients) send plain function tools, `namespace`
  // containers holding function tools, and native-only tools (web_search /
  // file_search / code_interpreter / computer_use) the Anthropic upstream has
  // no equivalent for. Flatten namespace functions; silently drop the
  // native-only tools rather than failing the whole request (they encode
  // client-side optional features, not required server capabilities).
  const functionTools = normalizeTools(body.tools ?? []);
  const wantsTools = body.tool_choice !== "none" && functionTools.length > 0;

  const effort = body.reasoning?.effort;
  const wantsThinking = Boolean(body.reasoning);
  const thinking = wantsThinking
    ? {
        type: "enabled",
        budget_tokens: EFFORT_BUDGETS[effort] ?? 4096,
      }
    : undefined;

  return {
    wantsThinking,
    anthropicBody: {
      model: body.model ?? "gpt-5-codex",
      ...(typeof body.instructions === "string" ? { system: body.instructions } : {}),
      messages,
      ...(wantsTools
        ? {
            tools: functionTools,
            tool_choice: convertToolChoice(body.tool_choice, body.parallel_tool_calls ?? true),
          }
        : {}),
      ...(thinking ? { thinking } : {}),
      max_tokens: body.max_output_tokens ?? 8192,
      stream: body.stream === true,
    },
  };
}

function convertItems(items: any[]): any[] {
  const messages: any[] = [];
  let current: { role: string; content: any[] } | null = null;

  function ensure(role: string) {
    if (!current || current.role !== role) {
      if (current) messages.push(current);
      current = { role, content: [] };
    }
  }

  for (const item of items) {
    switch (item.type) {
      case "message": {
        const role = item.role === "assistant" ? "assistant" : "user";
        ensure(role);
        for (const c of item.content ?? []) {
          if (c.type === "input_text" || c.type === "output_text")
            current!.content.push({ type: "text", text: c.text });
          else if (c.type === "input_image")
            current!.content.push({
              type: "image",
              source: {
                type: "base64",
                media_type: c.image_url ? c.image_url.substring(5, c.image_url.indexOf(";")) : "image/png",
                data: c.image_url ? c.image_url.split(",")[1] : c.file_data,
              },
            });
          else
            throw new Error(`unsupported_response_content:${c.type}`);
        }
        break;
      }
      case "function_call":
        ensure("assistant");
        current!.content.push({
          type: "tool_use",
          id: item.call_id,
          name: item.name,
          input: safeParseArgs(item.arguments),
        });
        break;
      case "function_call_output":
        ensure("user");
        current!.content.push({
          type: "tool_result",
          tool_use_id: item.call_id,
          content: typeof item.output === "string" ? item.output : JSON.stringify(item.output),
        });
        break;
      case "reasoning":
        // 历史推理不重放给上游。
        break;
      default:
        throw new Error(`unsupported_response_item:${item.type}`);
    }
  }
  if (current) messages.push(current);
  return messages;
}

function safeParseArgs(raw: string): any {
  try {
    return JSON.parse(raw ?? "{}");
  } catch {
    return {};
  }
}

function toAnthropicTool(t: any): any {
  return {
    name: t.name,
    description: t.description ?? "",
    input_schema: t.parameters ?? { type: "object", properties: {} },
  };
}

function normalizeTools(rawTools: any[]): any[] {
  const out: any[] = [];
  const visit = (tool: any) => {
    if (tool?.type === "function") {
      out.push(toAnthropicTool(tool));
    } else if (tool?.type === "namespace" && Array.isArray(tool.tools)) {
      for (const inner of tool.tools) visit(inner);
    }
    // Native-only tools (web_search/file_search/code_interpreter/computer_use)
    // have no Anthropic equivalent and are dropped.
  };
  for (const tool of rawTools) visit(tool);
  return out;
}
