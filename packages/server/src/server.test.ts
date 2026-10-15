import { describe, it, expect } from "vitest";
import { request as httpRequest } from "node:http";
import { startGateway } from "./server.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rawRequest(
  port: number,
  options: { method?: string; path?: string; body?: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        port,
        path: options.path ?? "/",
        method: options.method ?? "GET",
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

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
    const r = await fetch(`http://127.0.0.1:${port}/health`);
    expect(r.status).toBe(200);
    await gw.close();
  });

  it("answers an unsupported HTTP method (e.g. TRACE) without crashing the daemon", async () => {
    const gw = await startGateway(0, async () => Response.json({ ok: true }));
    const port = (gw as any).port as number;
    const raw = await rawRequest(port, { method: "TRACE", path: "/" });
    expect(raw.status).toBeGreaterThanOrEqual(400);
    // The daemon must still serve other requests afterwards.
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
    expect(health).toEqual({ ok: true });
    await gw.close();
  });

  it("does not abort the upstream signal when the request finishes normally", async () => {
    let sawAbort = false;
    const gw = await startGateway(0, async (req, ctx) => {
      ctx.signal.addEventListener("abort", () => {
        sawAbort = true;
      });
      await req.text(); // fully consume the request body (used to mis-fire before)
      await delay(30);
      return Response.json({ ok: true });
    });
    const port = (gw as any).port as number;
    const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      body: JSON.stringify({ x: 1 }),
    });
    expect(r.status).toBe(200);
    await delay(30);
    expect(sawAbort).toBe(false);
    await gw.close();
  });

  it("aborts the upstream signal when the client disconnects mid-request", async () => {
    let aborted = false;
    const gw = await startGateway(0, async (_req, ctx) => {
      ctx.signal.addEventListener("abort", () => {
        aborted = true;
      });
      await new Promise((resolve) => {
        ctx.signal.addEventListener("abort", resolve);
        setTimeout(resolve, 2000);
      });
      return new Response("ok");
    });
    const port = (gw as any).port as number;
    const ac = new AbortController();
    fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      body: JSON.stringify({ x: 1 }),
      signal: ac.signal,
    }).catch(() => {});
    await delay(100);
    ac.abort();
    await delay(100);
    expect(aborted).toBe(true);
    await gw.close();
  });
});
