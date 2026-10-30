export type Frame = {
  id?: string;
  event?: string;
  data?: string;
  comment?: string;
};

/** Reads SSE frames off a response body, one at a time. */
export function sseReader(res: Response) {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next(): Promise<Frame | null> {
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const frame: Frame = {};
          for (const line of block.split("\n")) {
            if (line.startsWith(":")) frame.comment = line.slice(1).trim();
            const m = /^(id|event|data): ?(.*)$/.exec(line);
            if (m) frame[m[1] as "id" | "event" | "data"] = m[2];
          }
          return frame;
        }
        const { done, value } = await reader.read();
        if (done) return null;
        buffer += decoder.decode(value, { stream: true });
      }
    },
    /** The next frame that dispatches an event: no heartbeat, no id-only cursor frame. */
    async event(): Promise<Frame | null> {
      for (;;) {
        const frame = await this.next();
        if (!frame || frame.data !== undefined) return frame;
      }
    },
    cancel: () => reader.cancel(),
  };
}
