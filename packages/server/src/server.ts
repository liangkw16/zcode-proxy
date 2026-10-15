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

    // Abort the upstream fetch when the client disconnects. We listen on the
    // response (not the request): nodeReq 'close' also fires once the request
    // body has been fully read, which would abort every normal POST. The
    // response 'close' with writableEnded === false means the connection went
    // away before we finished answering.
    nodeRes.on("close", () => {
      if (!nodeRes.writableEnded) controller.abort();
    });

    let webReq: Request;
    try {
      webReq = new Request(url, {
        method: nodeReq.method,
        headers: new Headers(nodeReq.headers as Record<string, string>),
        body: ["GET", "HEAD"].includes(nodeReq.method ?? "") ? undefined : (nodeReq as any),
        // @ts-expect-error undici duplex option required for streaming request bodies
        duplex: "half",
      });
    } catch {
      // e.g. TRACE/TRACK: the Fetch Request constructor throws synchronously for
      // forbidden methods. Return a clear error instead of killing the daemon.
      if (!nodeRes.headersSent) {
        nodeRes.writeHead(400, { "content-type": "application/json" });
        nodeRes.end(
          JSON.stringify({
            type: "error",
            error: {
              type: "invalid_request_error",
              message: `unsupported HTTP method: ${nodeReq.method}`,
            },
          }),
        );
      }
      return;
    }

    handler(webReq, { signal: controller.signal, requestId })
      .then(async (webRes) => {
        nodeRes.writeHead(webRes.status, Object.fromEntries(webRes.headers));
        if (webRes.body) {
          for await (const chunk of webRes.body) {
            if (!nodeRes.write(chunk)) {
              // Backpressure: also wake if the client disconnects while paused.
              await new Promise<void>((resolve, reject) => {
                nodeRes.once("drain", () => resolve());
                nodeRes.once("close", () => reject(new Error("client closed")));
              });
            }
          }
          nodeRes.end();
        } else {
          nodeRes.end(await webRes.text());
        }
      })
      .catch(() => {
        // Includes AbortError from a client disconnect.
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

  return new Promise((resolve, reject) => {
    // A failed bind (e.g. EADDRINUSE) must reject rather than hang so the
    // foreground launcher exits non-zero.
    server.once("error", reject);
    // 硬编码 loopback，禁止外部访问。
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      const boundPort = typeof address === "object" && address ? address.port : port;
      resolve({
        port: boundPort,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
