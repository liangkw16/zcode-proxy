const DEFAULT_RULES: Array<[RegExp, string]> = [
  [/^claude-(opus|sonnet)/i, "GLM-5.3"],
  [/^claude-haiku/i, "GLM-5.3-Flash"],
];

export interface ModelMapping {
  map(inboundModel: string): string;
}

export function createModelMapping(overrides: Record<string, string> = {}): ModelMapping {
  const custom: Array<[RegExp, string]> = Object.entries(overrides).map(
    ([re, target]) => [new RegExp(re), target],
  );
  const rules = [...custom, ...DEFAULT_RULES];
  return {
    map(inboundModel: string): string {
      const model = inboundModel ?? "";
      for (const [re, target] of rules) {
        if (re.test(model)) return target;
      }
      if (/^GLM-/i.test(model)) return model;
      return "GLM-5.3";
    },
  };
}
