import { describe, it, expect } from "vitest";
import { createModelAttribution } from "./attribution.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("createModelAttribution", () => {
  it("emits the zcode per-request attribution headers for a main session", () => {
    const headers = createModelAttribution().createHeaders();
    expect(headers["x-zcode-session-type"]).toBe("main");
    expect(headers["x-zcode-query-source"]).toBe("main_turn");
    expect(headers["x-request-id"]).toMatch(UUID);
    expect(headers["x-zcode-trace-id"]).toMatch(UUID);
    expect(headers["x-query-id"]).toMatch(UUID);
    expect(headers["x-session-id"]).toMatch(UUID);
  });

  it("keeps a stable session id but rotates per-request ids", () => {
    const attribution = createModelAttribution();
    const first = attribution.createHeaders();
    const second = attribution.createHeaders();
    expect(second["x-session-id"]).toBe(first["x-session-id"]);
    expect(second["x-request-id"]).not.toBe(first["x-request-id"]);
    expect(second["x-zcode-trace-id"]).not.toBe(first["x-zcode-trace-id"]);
    expect(second["x-query-id"]).not.toBe(first["x-query-id"]);
  });
});
