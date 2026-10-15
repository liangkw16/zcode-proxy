import { describe, it, expect } from "vitest";
import {
  convertResponsesRequest,
  convertToolChoice,
} from "./request-convert.js";

describe("convertResponsesRequest", () => {
  it("converts instructions and a simple user message", () => {
    const { anthropicBody } = convertResponsesRequest({
      model: "gpt-5-codex",
      instructions: "be brief",
      input: "hello",
    });
    expect(anthropicBody.system).toBe("be brief");
    expect(anthropicBody.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);
  });

  it("converts flat function tools", () => {
    const { anthropicBody } = convertResponsesRequest({
      input: "x",
      tools: [
        {
          type: "function",
          name: "weather",
          description: "weather lookup",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      ],
    });
    expect(anthropicBody.tools).toEqual([
      {
        name: "weather",
        description: "weather lookup",
        input_schema: { type: "object", properties: { city: { type: "string" } } },
      },
    ]);
  });

  it("flattens namespace tool groups and drops native-only tools", () => {
    const { anthropicBody } = convertResponsesRequest({
      input: "x",
      tools: [
        { type: "function", name: "exec_command", description: "run", parameters: { type: "object" } },
        {
          type: "namespace",
          name: "multi_agent_v1",
          tools: [
            { type: "function", name: "spawn_agent", description: "spawn", parameters: { type: "object" } },
            { type: "function", name: "wait_agent", description: "wait", parameters: { type: "object" } },
          ],
        },
        { type: "web_search", external_web_access: false },
      ],
    });
    expect(anthropicBody.tools.map((t: any) => t.name)).toEqual([
      "exec_command",
      "spawn_agent",
      "wait_agent",
    ]);
  });

  it("converts a function_call/function_call_output round trip", () => {
    const { anthropicBody } = convertResponsesRequest({
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "weather?" }],
        },
        {
          type: "function_call",
          call_id: "call_1",
          name: "weather",
          arguments: '{"city":"北京"}',
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "sunny",
        },
      ],
    });
    expect(anthropicBody.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "weather?" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_1", name: "weather", input: { city: "北京" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: "sunny" }],
      },
    ]);
  });

  it("maps reasoning effort to thinking and flips the flag", () => {
    const { wantsThinking, anthropicBody } = convertResponsesRequest({
      input: "x",
      reasoning: { effort: "high" },
    });
    expect(wantsThinking).toBe(true);
    expect(anthropicBody.thinking.type).toBe("enabled");
    expect(anthropicBody.thinking.budget_tokens).toBe(16384);
  });

  it("drops tools when choice is none", () => {
    const { anthropicBody } = convertResponsesRequest({
      input: "x",
      tools: [{ type: "function", name: "f" }],
      tool_choice: "none",
    });
    expect(anthropicBody.tools).toBeUndefined();
  });
});

describe("convertToolChoice", () => {
  it("maps required + parallel=false to any with disable=true", () => {
    expect(convertToolChoice("required", false)).toEqual({
      type: "any",
      disable_parallel_tool_use: true,
    });
  });
  it("maps a named function", () => {
    expect(convertToolChoice({ type: "function", name: "f" }, true)).toEqual({
      type: "tool",
      name: "f",
      disable_parallel_tool_use: false,
    });
  });
});

import { createModelMapping } from "@zcode-proxy/core";

describe("convertResponsesRequest robustness", () => {
  it("accepts a message item that omits type and uses a string content", () => {
    const { anthropicBody } = convertResponsesRequest({
      model: "GLM-5.3",
      input: [{ role: "user", content: "hello" }],
    });
    expect(anthropicBody.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);
  });

  it("maps inbound model names via ModelMapping (claude-haiku -> Flash)", () => {
    const { anthropicBody } = convertResponsesRequest(
      { model: "claude-haiku-4-5", input: "hi" },
      createModelMapping(),
    );
    expect(anthropicBody.model).toBe("GLM-5.3-Flash");
  });

  it("errors when tool_choice requires a native-only tool that was dropped", () => {
    const result = convertResponsesRequest({
      input: "x",
      tools: [{ type: "web_search", name: "web_search" }],
      tool_choice: "required",
    });
    expect(result.unsupportedTool).toBeTruthy();
  });

  it("still drops native tools silently when usable functions remain (auto choice)", () => {
    const result = convertResponsesRequest({
      input: "x",
      tools: [
        { type: "function", name: "exec_command", parameters: { type: "object" } },
        { type: "web_search" },
      ],
      tool_choice: "auto",
    });
    expect(result.unsupportedTool).toBeUndefined();
    expect(result.anthropicBody.tools.map((t: any) => t.name)).toEqual(["exec_command"]);
  });

  it("errors when a named tool_choice points at a dropped native tool", () => {
    const result = convertResponsesRequest({
      input: "x",
      tools: [{ type: "web_search", name: "web_search" }],
      tool_choice: { type: "function", name: "web_search" },
    });
    expect(result.unsupportedTool).toBe("web_search");
  });

  it("converts a remote https image_url into a valid url source", () => {
    const { anthropicBody } = convertResponsesRequest({
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: "https://example.com/image.png",
            },
          ],
        },
      ],
    });
    const block = anthropicBody.messages[0].content[0];
    expect(block.type).toBe("image");
    expect(block.source).toEqual({
      type: "url",
      url: "https://example.com/image.png",
    });
  });

  it("converts a data URL image into a base64 source", () => {
    const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
    const { anthropicBody } = convertResponsesRequest({
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_image", image_url: dataUrl }],
        },
      ],
    });
    const block = anthropicBody.messages[0].content[0];
    expect(block.source).toEqual({
      type: "base64",
      media_type: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
    });
  });
});
