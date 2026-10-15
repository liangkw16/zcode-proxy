import { randomUUID } from "node:crypto";

/**
 * Per-request attribution headers the real zcode CLI attaches to every model
 * request (see adapters/src/model/runner-attribution.ts). The Coding Plan
 * service uses `x-zcode-session-type` to bucket traffic by main/subagent/
 * side_chat/other; the request/trace/query/session ids are observability
 * correlation ids. Authentication/identification is carried separately by
 * the short-lived coding-plan token and the static source headers.
 *
 * A proxy process models one interactive CLI session: the session id is
 * stable for the daemon's lifetime, while the request/trace/query ids are
 * freshly minted for each inbound (and each retried) HTTP request.
 */
export interface ModelAttribution {
  createHeaders(): Record<string, string>;
}

export function createModelAttribution(): ModelAttribution {
  const sessionId = randomUUID();
  return {
    createHeaders() {
      return {
        "x-request-id": randomUUID(),
        "x-zcode-session-type": "main",
        "x-zcode-trace-id": randomUUID(),
        "x-query-id": randomUUID(),
        "x-zcode-query-source": "main_turn",
        "x-session-id": sessionId,
      };
    },
  };
}
