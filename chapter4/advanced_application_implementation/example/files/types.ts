// src/types.ts
/**
 * Shape definitions for the ArtCraft loopback control protocol.
 *
 * The protocol is deliberately minimal: every message on the wire is a
 * single JSON object terminated by `\n`. There is no correlation protocol
 * beyond `id`; there is no negotiation beyond the initial auth frame.
 */

/**
 * A single frame on the JSON-Lines control channel.
 *
 * Requests carry `id` + `method` + optional `params`.
 * Replies carry the same `id` + `ok` and either `result` or `error`.
 * Asynchronous events carry only `event` (no `id`) — these are the frames
 * the engine pushes to the client unprompted: progress, log lines, and
 * cancellations.
 */
export interface ControlFrame {
  /** Correlation identifier; present on requests and on their replies. */
  id?: string | number;
  /**
   * Method or command identifier, e.g. `"engine.execute"`, `"ui.screenshot"`.
   * Absent on replies (`id` + `ok`) and on async events (`event`).
   */
  method?: string;
  /** Method arguments; shape depends on `method`. */
  params?: Record<string, unknown>;
  /** Present on replies: `true` iff the invocation succeeded. */
  ok?: boolean;
  /** Present on error replies. */
  error?:
    | string
    | { code: number; message: string; data?: unknown };
  /** Present on success replies. */
  result?: unknown;
  /** Present on asynchronous events (heartbeats, progress, log lines). */
  event?: string;
}

/**
 * Subset of engine commands we care about bridging into MCP. Kept as a
 * discriminated union so TypeScript catches typos at the call site.
 */
export type KnownMethod =
  | 'auth'
  | 'system.ping'
  | 'system.version'
  | 'engine.execute'
  | 'engine.batch'
  | 'ui.screenshot'
  | 'doc.inspect';

/**
 * Options accepted by `CraftControlSession`. `port` and `token` are the
 * only required fields; everything else has a production-safe default.
 */
export interface SessionOptions {
  /** Loopback host — **never** override this to `0.0.0.0` or a routable IP. */
  host?: string;
  /** Control port; matches `--control <PORT>` on the engine command line. */
  port: number;
  /** 64-hex-char shared secret; bound to the engine process at launch. */
  token: string;
  /**
   * When `true`, the client waits for the server's `auth.challenge` frame
   * (which carries a per-connection nonce) and replies with
   * `HMAC-SHA256(token, nonce)` as the `token` field. When `false` (the
   * behavior mandated by the base spec), the raw token is sent directly.
   */
  challengeResponse?: boolean;
  /** Wall-clock ceiling for any single request/response pair. */
  requestTimeoutMs?: number;
  /** Interval between `system.ping` probes. */
  heartbeatIntervalMs?: number;
  /** Timeout for each individual `system.ping`. */
  heartbeatTimeoutMs?: number;
  /** Consecutive missed heartbeats before we force a reconnect. */
  heartbeatMissesBeforeReconnect?: number;
  /** Reconnection budget; `Infinity` (default) retries forever. */
  maxReconnectAttempts?: number;
  /** Base delay for reconnection backoff (ms). */
  reconnectBaseMs?: number;
  /** Ceiling for reconnection backoff (ms). */
  reconnectMaxMs?: number;
  /** Hard cap on a single inbound line, in bytes. Prevents OOM from a
   *  runaway server frame. Defaults to 8 MiB. */
  maxFrameBytes?: number;
  /** Sandbox roots; used only for client-side pre-flight validation. */
  readRoot?: string;
  /** Sandbox roots; used only for client-side pre-flight validation. */
  writeRoot?: string;
}

/** Events emitted by `CraftControlSession`. */
export interface SessionEvents {
  /** Fired after a successful handshake (initial or reconnection). */
  ready: () => void;
  /** Fired once when the TCP socket closes; not fired on reconnect churn. */
  close: (reason: string) => void;
  /** Fired on recoverable errors (bad frame, heartbeat miss, etc.). */
  warn: (err: Error) => void;
  /** Fired when the reconnect budget is exhausted or `close()` is called. */
  fatal: (err: Error) => void;
  /** Fired for every asynchronous event frame from the engine. */
  event: (frame: ControlFrame) => void;
  /** Fired every time the client transitions connection states. */
  state: (state: SessionState) => void;
}

export type SessionState =
  | 'idle'
  | 'connecting'
  | 'authenticating'
  | 'ready'
  | 'reconnecting'
  | 'closed';
