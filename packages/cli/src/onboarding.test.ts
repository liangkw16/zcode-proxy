import { describe, it, expect } from "vitest";
import { onboardingSnippets } from "./onboarding.js";

describe("onboardingSnippets", () => {
  const snippets = onboardingSnippets(8792, "GLM-5.3");

  it("emits a valid parseable Claude Code settings.json snippet", () => {
    // Strip the leading comment line, then the remainder must be valid JSON.
    const jsonText = snippets.claudeCode
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n")
      .trim();
    const parsed = JSON.parse(jsonText);
    expect(parsed.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8792");
    expect(parsed.env.ANTHROPIC_AUTH_TOKEN).toBe("zcode-proxy");
    expect(parsed.env.ANTHROPIC_MODEL).toBe("GLM-5.3");
  });

  it("emits a Codex config with the responses base url", () => {
    expect(snippets.codex).toContain("base_url = \"http://127.0.0.1:8792/v1\"");
    expect(snippets.codex).toContain("wire_api = \"responses\"");
  });
});
