export function onboardingSnippets(port: number, model: string): {
  claudeCode: string;
  codex: string;
} {
  return {
    claudeCode: [
      "// ~/.claude/settings.json",
      "{",
      `  "env": {`,
      `    "ANTHROPIC_BASE_URL": "http://127.0.0.1:${port}"`,
      `    "ANTHROPIC_AUTH_TOKEN": "zcode-proxy"`,
      `    "ANTHROPIC_MODEL": "${model}"`,
      `  },`,
      `  "enableArtifact": false`,
      "}",
    ].join("\n"),
    codex: [
      "# ~/.codex/config.toml",
      `model = "${model}"`,
      `model_provider = "zcode-proxy"`,
      "",
      `[model_providers.zcode-proxy]`,
      `name = "zcode-proxy"`,
      `base_url = "http://127.0.0.1:${port}/v1"`,
      `wire_api = "responses"`,
    ].join("\n"),
  };
}
