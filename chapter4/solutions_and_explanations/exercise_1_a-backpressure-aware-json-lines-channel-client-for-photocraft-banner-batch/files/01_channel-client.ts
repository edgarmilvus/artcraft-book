// channel-client.ts
import * as net from "node:net";
import { TextDecoder } from "node:util";

// ---------- Wire types (all readonly, all discriminated) ----------
export type FrameId = number | "hb" | "auth";
export interface OutboundFrame<P = unknown> {
  readonly id: FrameId;
  readonly method: string;
  readonly params: P;
}
export type Reply<R> =
  | { readonly ok: true;  readonly id: FrameId; readonly result: R }
  | { readonly ok: false; readonly id: FrameId; readonly error: { readonly code: string; readonly message: string } };

export type CommandClass = "readOnly" | "mutating";
export type CommandClassRule = (commandId: string) => CommandClass;

// ---------- Errors ----------
export class AuthFailedError    extends Error { constructor(m: string) { super(m); this.name = "AuthFailedError"; } }
export class ChannelTimeoutError extends Error { constructor(m: string) { super(m); this.name = "ChannelTimeoutError"; } }
export class FrameTooLargeError  extends Error { constructor(m: string) { super(m); this.name = "FrameTooLargeError"; } }
export class PreflightError      extends Error { constructor(m: string) { super(m); this.name = "PreflightError"; } }
export class LoopbackRefusedError extends Error { constructor(m: string) { super(m); this.name = "LoopbackRefusedError"; } }

// ---------- Public surface ----------
export interface DocHelpers {
  readonly run: <P, R>(commandId: string, params: P) => Promise<R>;
  readonly inspect: () => Promise<unknown>;
  readonly save: (path: string, format?: "PNG" | "JPG" | "PSD" | "pcraft") => Promise<void>;
}
export interface ChannelClient {
  readonly connect: (opts: { port: number; token: string }) => Promise<void>;
  readonly run: <P, R>(commandId: string, params: P) => Promise<Reply<R>>;
  readonly batch: (steps: ReadonlyArray<{ id: string; params: unknown }>) => Promise<Reply<unknown>>;
  readonly withDocument: <T>(
    spec: { width: number; height: number; background?: string },
    body: (helpers: DocHelpers) => Promise<T>,
  ) => Promise<T>;
  readonly close: () => Promise<void>;
}

// ---------- Type guard ----------
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function isReply(v: unknown): v is Reply<unknown> {
  if (!isRecord(v)) return false;
  if (v["ok"] === true)  return "result" in v && ("id" in v);
  if (v["ok"] === false) return isRecord(v["error"]) && typeof (v["error"] as any).code === "string";
  return false;
}

// ---------- Bounded in-flight scheduler (own implementation, no deps) ----------
class Scheduler {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly maxInFlight: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.maxInFlight) { this.active++; return; }
    await new Promise<void>(res => this.waiters.push(res));
    this.active++;
  }
  release(): void {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }
}

// ---------- The client ----------
interface PendingEntry {
  readonly resolve: (r: Reply<unknown>) => void;
  readonly reject:  (e: Error) => void;
  readonly commandId: string;
  readonly params: unknown;
  readonly cls: CommandClass;
}

export class JsonLinesChannelClient implements ChannelClient {
  private socket: net.Socket | null = null;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, PendingEntry>();
  private scheduler = new Scheduler(16);
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private closedByUser = false;
  private missedHeartbeats = 0;
  private token = "";
  private port = 0;
  private readonly maxFrameBytes = 8 * 1024 * 1024;

  // read-only vs mutating classifier: default policy
  private readonly classify: CommandClassRule = (id) => {
    // anything starting with a mutating verb prefix is mutating
    const MUTATING_PREFIXES = ["layer.", "filter.", "edit.", "image.", "paint.", "type.", "shape.", "path."];
    if (id === "doc_save" || id === "doc_new" || id === "doc_close" || id === "doc_export") return "mutating";
    if (MUTATING_PREFIXES.some(p => id.startsWith(p))) return "mutating";
    return "readOnly";
  };

  // Bind exclusively to loopback
  private static assertLoopbackHost(host: string): void {
    const h = host.trim().toLowerCase();
    // Reject hostnames outright; only literal IPs allowed
    if (h !== "127.0.0.1" && h !== "::1") {
      throw new LoopbackRefusedError(`Refusing non-loopback host: ${host}`);
    }
  }

  public async connect(opts: { port: number; token: string }): Promise<void> {
    if (!/^[0-9a-f]{64}$/i.test(opts.token))
      throw new AuthFailedError("Token must be a 64-character hex string");

    this.token = opts.token;
    this.port = opts.port;
    JsonLinesChannelClient.assertLoopbackHost("127.0.0.1");

    await this.openSocket();
    await this.authenticate();
    this.startHeartbeat();
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: "127.0.0.1", port: this.port });
      sock.setNoDelay(true);       // loopback: avoid Nagle batching our small frames
      sock.once("connect", () => { this.socket = sock; this.attachHandlers(sock); resolve(); });
      sock.once("error", reject);
    });
  }

  private attachHandlers(sock: net.Socket): void {
    sock.on("data", (chunk: Buffer) => this.onData(chunk));
    sock.on("close", () => this.onSocketClosed(new ChannelTimeoutError("socket closed")));
    sock.on("error", (err) => this.onSocketClosed(err));
  }

  // Framing: strict \n split, streaming UTF-8 decoded, frame-size guard
  private onData(chunk: Buffer): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (Buffer.byteLength(line, "utf8") > this.maxFrameBytes) {
        const e = new FrameTooLargeError(`frame exceeded ${this.maxFrameBytes} bytes`);
        this.teardown(e);
        return;
      }
      this.dispatchLine(line);
    }
  }

  private dispatchLine(line: string): void {
    let parsed: unknown;
    try { parsed = JSON.parse(line); }
    catch { return; } // malformed frame: ignore, heartbeat will catch a bad peer
    if (!isReply(parsed)) return;

    if (parsed.id === "hb") { this.missedHeartbeats = 0; return; }
    if (typeof parsed.id !== "number") return;   // not a command reply

    const entry = this.pending.get(parsed.id);
    if (!entry) return;
    this.pending.delete(parsed.id);
    this.scheduler.release();
    if (parsed.ok) entry.resolve(parsed as Reply<unknown>);
    else           entry.reject(new Error(`${parsed.error.code}: ${parsed.error.message}`));
  }

  private async authenticate(): Promise<void> {
    const frame: OutboundFrame<{ token: string }> = {
      id: "auth", method: "auth", params: { token: this.token },
    };
    await this.writeFrame(frame);
    const reply = await this.readSingleReply("auth");
    if (!reply.ok) throw new AuthFailedError(`auth rejected: ${reply.error.message}`);
  }

  // Reads the next non-heartbeat reply directly off the socket — used only for the auth handshake.
  private readSingleReply(expectedId: "auth"): Promise<Reply<unknown>> {
    return new Promise((resolve, reject) => {
      const sock = this.socket;
      if (!sock) return reject(new Error("no socket"));
      const onLine = (chunk: Buffer) => {
        this.buffer += this.decoder.decode(chunk, { stream: true });
        const nl = this.buffer.indexOf("\n");
        if (nl < 0) return;
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        sock.off("data", onLine);
        try { resolve(JSON.parse(line) as Reply<unknown>); }
        catch (e) { reject(e as Error); }
      };
      sock.on("data", onLine);
    });
  }

  // writeFrame: honours backpressure via 'drain'
  private writeFrame(frame: OutboundFrame): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = this.socket;
      if (!sock) return reject(new Error("not connected"));
      const ok = sock.write(JSON.stringify(frame) + "\n", (err) => err ? reject(err) : resolve());
      if (!ok) {
        sock.once("drain", () => { /* callback already fires; drain is our receipt */ });
      }
    });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.missedHeartbeats >= 2) {
        this.onSocketClosed(new ChannelTimeoutError("two heartbeats missed"));
        return;
      }
      this.missedHeartbeats++;
      const hb: OutboundFrame<Record<string, never>> = { id: "hb", method: "ping", params: {} };
      void this.writeFrame(hb).catch(() => { /* socket teardown will fire */ });
    }, 5_000);
  }
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  /**
   * The peer went away. Mutating commands are failed immediately — the
   * engine may already have applied them, and replaying an edit twice is
   * worse than reporting the failure. Read-only work stays queued and is
   * re-issued on the new socket, which is what makes a reconnect invisible
   * to callers that only ever asked questions.
   */
  private onSocketClosed(err: Error): void {
    this.stopHeartbeat();
    const dead = this.socket;
    this.socket = null;
    dead?.destroy();

    for (const [id, e] of [...this.pending]) {
      if (e.cls === "mutating") {
        this.pending.delete(id);
        this.scheduler.release();
        e.reject(err);
      }
    }

    if (this.closedByUser) {
      for (const [, e] of this.pending) e.reject(err);
      this.pending.clear();
      return;
    }
    this.scheduleReconnect(err);
  }

  private scheduleReconnect(cause: Error): void {
    if (this.reconnectTimer || this.closedByUser) return;
    const attempt = ++this.reconnectAttempts;
    const delay = Math.min(2_000, 100 * 2 ** (attempt - 1));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reopen(cause);
    }, delay);
  }

  private async reopen(cause: Error): Promise<void> {
    if (this.closedByUser) return;
    try {
      await this.openSocket();
      await this.authenticate();
      this.missedHeartbeats = 0;
      this.startHeartbeat();
      this.reconnectAttempts = 0;
      // Re-issue the read-only requests that were in flight.
      for (const [id, e] of [...this.pending]) {
        const frame: OutboundFrame = {
          id, method: "engine.execute",
          params: { command: e.commandId, params: e.params },
        };
        void this.writeFrame(frame).catch((err) => {
          this.pending.delete(id);
          this.scheduler.release();
          e.reject(err as Error);
        });
      }
    } catch {
      if (this.reconnectAttempts >= 10) {
        for (const [, e] of this.pending) e.reject(cause);
        this.pending.clear();
        return;
      }
      this.scheduleReconnect(cause);
    }
  }

  /** Wait (briefly) for the channel to be usable again after a drop. */
  private async ensureConnected(): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (this.socket) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new ChannelTimeoutError("channel is not connected");
  }

  private teardown(err: Error): void {
    this.onSocketClosed(err);
    this.socket?.destroy();
    this.socket = null;
  }

  // ---------- Public dispatch ----------
  public async run<P, R>(commandId: string, params: P): Promise<Reply<R>> {
    await this.ensureConnected();
    await this.scheduler.acquire();
    const id = this.nextId++;
    const cls = this.classify(commandId);
    return new Promise<Reply<R>>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (r: Reply<unknown>) => void,
        reject, commandId, params, cls,
      });
      const frame: OutboundFrame<{ command: string; params: P }> = {
        id, method: "engine.execute", params: { command: commandId, params },
      };
      this.writeFrame(frame).catch((e) => {
        this.pending.delete(id);
        this.scheduler.release();
        reject(e as Error);
      });
    });
  }

  public async batch(steps: ReadonlyArray<{ id: string; params: unknown }>): Promise<Reply<unknown>> {
    await this.ensureConnected();
    await this.scheduler.acquire();
    const id = this.nextId++;
    return new Promise<Reply<unknown>>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (r: Reply<unknown>) => void,
        reject, commandId: "batch", params: steps, cls: "mutating",
      });
      const frame: OutboundFrame<{ steps: typeof steps }> = { id, method: "engine.batch", params: { steps } };
      this.writeFrame(frame).catch((e) => {
        this.pending.delete(id);
        this.scheduler.release();
        reject(e as Error);
      });
    });
  }

  public async withDocument<T>(
    spec: { width: number; height: number; background?: string },
    body: (helpers: DocHelpers) => Promise<T>,
  ): Promise<T> {
    const helpers: DocHelpers = {
      run: async <P, R>(commandId: string, params: P): Promise<R> => {
        const reply = await this.run<P, R>(commandId, params);
        if (!reply.ok) throw new Error(`${reply.error.code}: ${reply.error.message}`);
        return reply.result;
      },
      inspect: async () => {
        const r = await this.run<{}, unknown>("document.inspect", {});
        if (!r.ok) throw new Error(r.error.message);
        return r.result;
      },
      save: async (path, format) => {
        const r = await this.run<{ path: string; format?: string }, unknown>("file.save", { path, format });
        if (!r.ok) throw new Error(r.error.message);
      },
    };

    // Create the document
    const created = await helpers.run<typeof spec, { index?: number }>("file.new", spec);
    void created;
    try {
      return await body(helpers);
    } finally {
      // Always close before tearing down
      try { await helpers.run<{}, unknown>("file.close", {}); } catch { /* ignore */ }
    }
  }

  public async close(): Promise<void> {
    this.closedByUser = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.stopHeartbeat();
    if (this.socket) {
      await new Promise<void>(res => this.socket!.end(() => res()));
      this.socket = null;
    }
  }
}
