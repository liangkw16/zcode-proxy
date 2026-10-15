import { createServer, type Server as HttpServer } from "node:http";

export interface RequestContext {
  signal: AbortSignal;
  requestId: string;
}

export type GatewayHandler = (req: Request, ctx: RequestContext) => Promise<Response>;

export interface Gateway {
  close(): Promise<void>;
  port: number;
}

export function startGateway(port: number, handler: GatewayHandler): Promise<Gateway> {
  const server: HttpServer = createServer((nodeReq, nodeRes) => {
    const address = server.address();
    const boundPort = typeof address === "object" && address ? address.port : port;
    const url = `http://127.0.0.1:${boundPort}${nodeReq.url}`;
    const controller = new AbortController();
    const requestId = `req_${Math.random().toString(36).slice(2, 10)}`;

    // 客户端断连：abort 上游，避免继续消耗额度。
    nodeReq.on("close", () => {
      if (!nodeRes.writableEnded) controller.abort();
    });

    const webReq = new Request(url, {
      method: nodeReq.method,
      headers: new Headers(nodeReq.headers as Record<string, string>),
      body: ["GET", "HEAD"].includes(nodeReq.method ?? "") ? undefined : (nodeReq as any),
      // @ts-expect-error undici duplex option required for streaming request bodies
      duplex: "half",
    });

    handler(webReq, { signal: controller.signal, requestId })
      .then(async (webRes) => {
        nodeRes.writeHead(webRes.status, Object.fromEntries(webRes.headers));
        if (webRes.body) {
          for await (const chunk of webRes.body) {
            if (!nodeRes.write(chunk)) {
              await new Promise((r) => nodeRes.once("drain", r));
            }
          }
          nodeRes.end();
        } else {
          nodeRes.end(await webRes.text());
        }
      })
      .catch(() => {
        if (!nodeRes.headersSent) {
          nodeRes.writeHead(500, { "content-type": "application/json" });
          nodeRes.end(
            JSON.stringify({ type: "error", error: { type: "api_error", message: "internal error" } }),
          );
        } else {
          nodeRes.end();
        }
      });
  });

  return new Promise((resolve) => {
    // 硬编码 loopback，禁止外部访问。
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const boundPort = typeof address === "object" && address ? address.port : port;
      resolve({
        port: boundPort,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
