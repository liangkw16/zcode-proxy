import { describe, it, expect } from "vitest";
import { handleModels } from "./models.js";

describe("handleModels", () => {
  it("lists GLM models for discovery", async () => {
    const res = handleModels();
    const body = await res.json();
    const ids = body.data.map((m: any) => m.id);
    expect(ids).toContain("GLM-5.3");
    expect(ids).toContain("GLM-5.3-Flash");
  });
});
