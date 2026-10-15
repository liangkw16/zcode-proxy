import { describe, it, expect } from "vitest";
import { parseSSE, serializeSSE } from "./sse.js";

const enc = new TextEncoder();
function bytes(text: string): Uint8Array {
  return enc.encode(text);
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// Start draining before writing: TransformStream backpressure requires an
// active reader while the writer pushes chunks.
async function runThrough(chunks: Uint8Array[]): Promise<any[]> {
  const stream = parseSSE();
  const reader = stream.readable.getReader();
  const events: any[] = [];
  const draining = (async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      events.push(value);
    }
  })();
  const writer = stream.writable.getWriter();
  for (const c of chunks) await writer.write(c);
  await writer.close();
  await draining;
  return events;
}

function collect(stream: any) {
  const reader = stream.readable.getReader();
  const events: any[] = [];
  const done = (async () => {
    while (true) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      events.push(value);
    }
  })();
  return { events, done };
}

describe("parseSSE", () => {
  it("parses an LF-delimited event", async () => {
    const events = await runThrough([bytes("event: message_start\ndata: {\"a\":1}\n\n")]);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("message_start");
    expect(events[0].data).toEqual({ a: 1 });
  });

  it("parses CRLF-delimited events (SSE allows CRLF, LF, CR)", async () => {
    const events = await runThrough([
      bytes("event: message_stop\r\ndata: {}\r\n\r\n"),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("message_stop");
  });

  it("parses CR-only line endings and event separators", async () => {
    const events = await runThrough([bytes("data: x\r\r")]);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("x");
  });

  it("handles a multibyte UTF-8 character split across chunks", async () => {
    // "中" = E4 B8 AD; split the first two bytes from the last one.
    const zhong = bytes("中");
    const events = await runThrough([
      concat(bytes("data: "), zhong.slice(0, 2)),
      concat(zhong.slice(2), bytes("\n\n")),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("中");
  });

  it("keeps two interleaved streams' decoders independent", async () => {
    const a = parseSSE();
    const b = parseSSE();
    const aSink = collect(a);
    const bSink = collect(b);
    const aw = a.writable.getWriter();
    const bw = b.writable.getWriter();

    const zhong = bytes("中");
    // Stream A pauses in the middle of a multibyte character.
    await aw.write(concat(bytes("data: "), zhong.slice(0, 2)));
    // Stream B processes a complete event in between.
    await bw.write(bytes("data: B\r\n\r\n"));
    // Stream A then completes its character.
    await aw.write(concat(zhong.slice(2), bytes("\n\n")));
    await aw.close();
    await bw.close();
    await aSink.done;
    await bSink.done;

    expect(bSink.events).toHaveLength(1);
    expect(bSink.events[0].data).toBe("B");
    expect(bSink.events[0].event).toBe("message");
    expect(aSink.events).toHaveLength(1);
    expect(aSink.events[0].data).toBe("中");
  });

  it("round-trips through serializeSSE", async () => {
    const stream = serializeSSE();
    const reader = stream.readable.getReader();
    const writer = stream.writable.getWriter();
    const readP = reader.read();
    await writer.write({ event: "message_stop", data: {} });
    await writer.close();
    const { value } = await readP;
    const text = new TextDecoder().decode(value);
    expect(text).toContain("event: message_stop");
    expect(text).toContain("data: {}");
  });
});
