// Minimal SSE (Server-Sent Events) parser/serializer per
// https://html.spec.whatwg.org/multipage/server-sent-events.html.
//
// Each parser owns its own TextDecoder/TextEncoder: concurrent requests each
// create a parser, and a single module-level decoder would either share
// multibyte streaming state (with stream:true) or corrupt characters split
// across chunks (with stream:false).

export interface SSEEvent {
  event: string;
  data: any;
  id?: string;
  retry?: number;
}

const EVENT_SEPARATOR = /\r\n\r\n|\n\n|\r\r/;
const LINE_SEPARATOR = /\r\n|\n|\r/;

function dispatchBlock(block: string, controller: TransformStreamDefaultController<SSEEvent>) {
  let eventName = "message";
  const dataLines: string[] = [];
  let id = "";
  let retry: number | undefined;

  for (const line of block.split(LINE_SEPARATOR)) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") eventName = value;
    else if (field === "data") dataLines.push(value);
    else if (field === "id") id = value;
    else if (field === "retry") retry = Number(value);
  }

  if (dataLines.length > 0) {
    const raw = dataLines.join("\n");
    let parsed: any = raw;
    if (raw.trim().length > 0) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
    }
    controller.enqueue({ event: eventName, data: parsed, id, retry });
  }
}

export function parseSSE(): TransformStream<Uint8Array, SSEEvent> {
  // Per-stream instances so concurrent parsers never share decoder state.
  const decoder = new TextDecoder();
  let buffer = "";

  return new TransformStream<Uint8Array, SSEEvent>({
    transform(chunk, controller) {
      // stream:true keeps a multibyte character split across two chunks
      // buffered instead of replacing it with U+FFFD.
      buffer += decoder.decode(chunk, { stream: true });
      const segments = buffer.split(EVENT_SEPARATOR);
      // The last segment is a partial event with no trailing blank line yet.
      buffer = segments.pop() ?? "";
      for (const block of segments) {
        if (block.length > 0) dispatchBlock(block, controller);
      }
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer.trim().length > 0) dispatchBlock(buffer, controller);
    },
  });
}

export function serializeSSE(): TransformStream<SSEEvent, Uint8Array> {
  // TextEncoder is stateless; kept per-stream for symmetry.
  const encoder = new TextEncoder();
  return new TransformStream<SSEEvent, Uint8Array>({
    transform(ev, controller) {
      const data = typeof ev.data === "string" ? ev.data : JSON.stringify(ev.data);
      controller.enqueue(
        encoder.encode(`event: ${ev.event}\ndata: ${data}\n\n`),
      );
    },
  });
}
