const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface SSEEvent {
  event: string;
  data: any;
}

export function parseSSE(): TransformStream<Uint8Array, SSEEvent> {
  let buffer = "";
  return new TransformStream<Uint8Array, SSEEvent>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const lines = raw.split("\n");
        let event = "message";
        const dataLines: string[] = [];
        for (const line of lines) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length === 0) continue;
        const joined = dataLines.join("\n");
        let data: any = joined;
        try {
          data = JSON.parse(joined);
        } catch {
          /* keep raw string */
        }
        controller.enqueue({ event, data });
      }
    },
  });
}

export function serializeSSE(): TransformStream<SSEEvent, Uint8Array> {
  return new TransformStream<SSEEvent, Uint8Array>({
    transform(ev, controller) {
      const payload = typeof ev.data === "string" ? ev.data : JSON.stringify(ev.data);
      controller.enqueue(encoder.encode(`event: ${ev.event}\ndata: ${payload}\n\n`));
    },
  });
}
