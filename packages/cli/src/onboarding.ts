export interface OnboardingSnippets {
  env: Record<string, string>;
  claudeCode: string;
  codex: string;
}

export function onboardingSnippets(port: number, model: string): OnboardingSnippets {
  const baseUrl = `http://127.0.0.1:${port}`;

  const env = {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: "zcode-proxy",
    ANTHROPIC_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: "GLM-5.3-Flash",
  };

  // Build the settings object and serialize it so the snippet is always valid
  // JSON; the comment is on its own line above the JSON body.
  const settings = {
    env,
    includeCoAuthoredBy: false,
    enableArtifact: false,
  };
  const claudeCode = `// ~/.claude/settings.json\n${JSON.stringify(settings, null, 2)}`;

  const codex = `# ~/.codex/config.toml
model_provider = "zcode-proxy"
model = "${model}"

[model_providers.zcode-proxy]
name = "ZCode Coding Plan"
base_url = "${baseUrl}/v1"
wire_api = "responses"
env_key = "ZCODE_PROXY_KEY"
`;

  return { env, claudeCode, codex };
}
