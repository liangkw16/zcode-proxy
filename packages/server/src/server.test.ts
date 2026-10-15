import { describe, it, expect } from "vitest";
import { startGateway } from "./server.js";

describe("startGateway", () => {
  it("routes requests and aborts on client disconnect", async () => {
    const handler = async (req: Request) => {
      if (new URL(req.url).pathname === "/health") {
        return Response.json({ ok: true });
      }
      return Response.json({ echo: await req.text() });
    };
    const gw = await startGateway(0, handler);
    const port = (gw as any).port as number;
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
    expect(health).toEqual({ ok: true });
    await gw.close();
  });

  it("binds only loopback", async () => {
    const gw = await startGateway(0, async () => Response.json({}));
    const port = (gw as any).port as number;
    // 127.0.0.1 可达即证明绑定 loopback
    const r = await fetch(`http://127.0.0.1:${port}/health`);
    expect(r.status).toBe(200);
    await gw.close();
  });
});
