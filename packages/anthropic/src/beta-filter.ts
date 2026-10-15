// 初期白名单为空（最安全，全部过滤）；实现阶段逐个 beta 实测后，把上游接受的加入。
export const ALLOWED_UPSTREAM_BETAS: Set<string> = new Set([]);

export function filterAnthropicBeta(headers: Record<string, string>): Record<string, string> {
  const raw = headers["anthropic-beta"];
  if (!raw) return headers;
  const allowed = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((b) => b && ALLOWED_UPSTREAM_BETAS.has(b));
  const out = { ...headers };
  if (allowed.length) out["anthropic-beta"] = allowed.join(",");
  else delete out["anthropic-beta"];
  return out;
}
