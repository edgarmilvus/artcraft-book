// src/codec.ts
/**
 * JSON-Lines codec: buffers inbound bytes, splits on `\n`, parses each
 * line into a `ControlFrame`, and re-encodes outbound frames.
 *
 * The codec is deliberately strict about a hard frame-size cap so a
 * misbehaving peer cannot drive the client out of memory.
 */
import type { ControlFrame } from './types.js';

export class JsonLinesCodec {
  private buffer = '';

  constructor(private readonly maxFrameBytes: number) {}

  /** Encode a single frame as a `\n`-terminated JSON line. */
  public encode(frame: ControlFrame): string {
    return JSON.stringify(frame) + '\n';
  }

  /**
   * Feed a chunk of inbound bytes. Returns every frame that is now
   * complete. Throws if the internal buffer exceeds `maxFrameBytes`.
   */
  public push(chunk: Buffer | string): ControlFrame[] {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');

    if (Buffer.byteLength(this.buffer, 'utf8') > this.maxFrameBytes) {
      // Reset and signal — the caller will destroy the socket.
      this.buffer = '';
      throw new Error(
        `JsonLinesCodec: inbound buffer exceeded ${this.maxFrameBytes} bytes`,
      );
    }

    const frames: ControlFrame[] = [];
    let newlineIdx: number;

    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIdx);
      this.buffer = this.buffer.slice(newlineIdx + 1);

      if (line.length === 0) continue; // tolerate keepalive blank lines

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        // A malformed line is not fatal: skip it and keep the channel.
        // Callers see warnings on the `warn` event.
        throw new Error(
          `JsonLinesCodec: malformed JSON line: ${(err as Error).message}`,
        );
      }

      // Three shapes share the wire: requests carry `method`, replies carry
      // `id` + `ok` (no method), async events carry `event`. Rejecting
      // anything without `method` would reject every reply — including the
      // auth ack — and the handshake would never complete.
      if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('JsonLinesCodec: frame is not a valid control frame');
      }
      const f = parsed as { method?: unknown; ok?: unknown; event?: unknown };
      const isRequest = typeof f.method === 'string';
      const isReply = typeof f.ok === 'boolean';
      const isEvent = typeof f.event === 'string';
      if (!isRequest && !isReply && !isEvent) {
        throw new Error('JsonLinesCodec: frame is not a valid control frame');
      }

      frames.push(parsed as ControlFrame);
    }

    return frames;
  }

  /** Called on teardown. Discards any partial frame. */
  public reset(): void {
    this.buffer = '';
  }
}
