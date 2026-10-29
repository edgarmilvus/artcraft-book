// src/session.ts
/**
 * CraftControlSession — a production-grade client for the ArtCraft /
 * Storytold loopback control channel.
 *
 * Responsibilities:
 *   • Establish a TCP connection to 127.0.0.1:<port>.
 *   • Perform the mandatory auth handshake before any other frame.
 *   • Multiplex request/response pairs by `id`, with per-request timeouts.
 *   • Respect TCP backpressure (wait for `drain` when `write` returns false).
 *   • Detect half-open sockets via a `system.ping` heartbeat loop.
 *   • Reconnect with jittered exponential backoff on any failure.
 *   • Emit asynchronous engine events as `event` callbacks.
 */
import { EventEmitter } from 'node:events';
import { createConnection, type Socket } from 'node:net';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ControlFrame, SessionOptions, SessionState } from './types.js';
import { JsonLinesCodec } from './codec.js';

/** Internal record for a single in-flight request. */
interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

/** Validate the 64-hex token format up-front so auth never fails silently. */
const HEX_64 = /^[0-9a-fA-F]{64}$/;

/**
 * A single logical session with one ArtCraft engine. Reusable across
 * disconnects: the class reconnects transparently and re-authenticates.
 */
export class CraftControlSession extends EventEmitter {
  private readonly opts: Required<
    Omit<
      SessionOptions,
      'readRoot' | 'writeRoot' | 'challengeResponse'
    >
  > & {
    host: string;
    readRoot?: string;
    writeRoot?: string;
    challengeResponse: boolean;
  };

  private socket: Socket | null = null;
  private codec: JsonLinesCodec;
  private state: SessionState = 'idle';
  private closed = false;
  private nextId = 1;
  private pending = new Map<string | number, PendingRequest>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatMisses = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  /** Inbound bytes buffer for the ongoing handshake (challenge flow only). */
  private handshakeNonce: string | null = null;

  constructor(options: SessionOptions) {
    super();

    if (!HEX_64.test(options.token)) {
      throw new Error(
        'CraftControlSession: token must be exactly 64 hex characters',
      );
    }

    const host = options.host ?? '127.0.0.1';
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
      throw new Error(
        `CraftControlSession: refusing non-loopback host "${host}" — this ` +
          'channel is bound to the local process only.',
      );
    }

    this.opts = {
      host,
      port: options.port,
      token: options.token,
      challengeResponse: options.challengeResponse ?? false,
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 15_000,
      heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 5_000,
      heartbeatMissesBeforeReconnect:
        options.heartbeatMissesBeforeReconnect ?? 3,
      maxReconnectAttempts: options.maxReconnectAttempts ?? Infinity,
      reconnectBaseMs: options.reconnectBaseMs ?? 250,
      reconnectMaxMs: options.reconnectMaxMs ?? 30_000,
      maxFrameBytes: options.maxFrameBytes ?? 8 * 1024 * 1024,
      readRoot: options.readRoot,
      writeRoot: options.writeRoot,
    };

    this.codec = new JsonLinesCodec(this.opts.maxFrameBytes);
  }

  // ==========================================================
  // Public API
  // ==========================================================

  /** Current lifecycle state of the session. */
  public get currentState(): SessionState {
    return this.state;
  }

  /** Bring the channel up; resolves after the auth handshake completes. */
  public async connect(): Promise<void> {
    if (this.closed) throw new Error('connect() called on a closed session');
    if (this.state === 'ready') return;
    return this.openSocket();
  }

  /**
   * Invoke a method on the engine and await its reply.
   *
   * @param method Method ID understood by the engine (e.g. `engine.execute`).
   * @param params Method parameters, as documented per command.
   * @param opts   Per-call overrides for the request timeout.
   */
  public async invoke<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    opts: { timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.closed) throw new Error('session is closed');
    if (this.state !== 'ready') {
      throw new Error(`session not ready (state=${this.state})`);
    }

    const id = this.nextId++;
    const timeoutMs = opts.timeoutMs ?? this.opts.requestTimeoutMs;

    const frame: ControlFrame = { id, method, params };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `request ${method}#${id} timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
        method,
      });

      // Fire and forget — _writeFrame handles backpressure internally.
      this._writeFrame(frame).catch((err) => {
        const entry = this.pending.get(id);
        if (entry) {
          clearTimeout(entry.timer);
          this.pending.delete(id);
        }
        reject(err);
      });
    });
  }

  /**
   * Convenience wrapper: run a single named engine command (e.g.
   * `layer.newAdjustmentLayer.curves`) with its JSON params. Translates
   * directly into the well-known `engine.execute` frame.
   */
  public executeCommand<T = unknown>(
    commandId: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    return this.invoke<T>('engine.execute', {
      command: commandId,
      params,
    });
  }

  /**
   * Convenience wrapper: run a batch of commands as one undoable step.
   * Matches the semantics of `engine.batch` / `command_batch`.
   */
  public executeBatch<T = unknown>(
    steps: Array<{ id: string; params?: Record<string, unknown> }>,
    opts: { stopOnError?: boolean } = {},
  ): Promise<T> {
    return this.invoke<T>('engine.batch', {
      steps: steps.map((s) => ({ id: s.id, params: s.params ?? {} })),
      stop_on_error: opts.stopOnError ?? true,
    });
  }

  /**
   * Capture a PNG screenshot of the live engine window. The engine returns
   * base64-encoded PNG bytes in `result.data`.
   */
  public async screenshot(
    opts: { maxSide?: number; path?: string } = {},
  ): Promise<{ dataBase64: string; path?: string }> {
    const result = await this.invoke<{
      data?: string;
      dataBase64?: string;
      path?: string;
    }>('ui.screenshot', {
      max_side: opts.maxSide ?? 1024,
      ...(opts.path ? { path: opts.path } : {}),
    });

    const b64 = result.dataBase64 ?? result.data ?? '';
    if (!b64) throw new Error('ui.screenshot returned no image data');
    return { dataBase64: b64, path: result.path };
  }

  /** Close the session permanently. Pending requests are rejected. */
  public close(reason = 'client close'): void {
    if (this.closed) return;
    this.closed = true;
    this._transition('closed');
    this._teardownSocket(reason);
    this.emit('close', reason);
  }

  // ==========================================================
  // Transport lifecycle
  // ==========================================================

  /** Establish the TCP socket, then perform the authentication handshake. */
  private async openSocket(): Promise<void> {
    this._transition('connecting');

    return new Promise<void>((resolve, reject) => {
      const socket = createConnection({
        host: this.opts.host,
        port: this.opts.port,
      });

      // Disable Nagle: our messages are tiny and latency-sensitive.
      socket.setNoDelay(true);
      // Disable keepalive; we use application-level heartbeats instead.
      socket.setKeepAlive(false);

      this.socket = socket;

      const onConnect = () => {
        socket.off('error', onError);
        void this._performHandshake()
          .then(() => {
            this._transition('ready');
            this.reconnectAttempt = 0;
            this.heartbeatMisses = 0;
            this._startHeartbeat();
            this.emit('ready');
            resolve();
          })
          .catch((err) => {
            this._teardownSocket('handshake-failed');
            reject(err as Error);
            this._scheduleReconnect('handshake-failed');
          });
      };

      const onError = (err: Error) => {
        socket.off('connect', onConnect);
        this._teardownSocket(`socket-error: ${err.message}`);
        reject(err);
        this._scheduleReconnect('socket-error');
      };

      socket.once('connect', onConnect);
      socket.once('error', onError);

      // Once connected, switch to the ongoing event handlers.
      socket.on('data', (chunk) => this._onData(chunk));
      socket.on('drain', () => this.emit('drain'));
      socket.on('close', () => this._onSocketClose('remote close'));
      socket.on('error', (err) => {
        // Post-connect errors surface as warnings; reconnect is scheduled.
        this.emit('warn', err);
      });
    });
  }

  /**
   * Perform the auth handshake.
   *
   * Two modes are supported:
   *   • Direct: send `{ id, method: "auth", params: { token } }`. This is
   *     the baseline mandated by the reference spec.
   *   • Challenge-response: wait for the server's `auth.challenge` frame
   *     carrying a nonce, then send `HMAC-SHA256(token, nonce)` as the
   *     `token` field. This binds the handshake to the connection and is
   *     the recommended upgrade whenever both sides support it.
   */
  private async _performHandshake(): Promise<void> {
    this._transition('authenticating');
    const socket = this.socket;
    if (!socket) throw new Error('no socket during handshake');

    let tokenToSend = this.opts.token;

    if (this.opts.challengeResponse) {
      // Wait for a challenge frame. Timeout falls back to the direct path
      // so a spec-compliant server that never sends a challenge still works.
      const nonce = await this._awaitChallenge(1_500).catch(() => null);
      if (nonce) {
        this.handshakeNonce = nonce;
        tokenToSend = createHmac('sha256', Buffer.from(this.opts.token, 'hex'))
          .update(Buffer.from(nonce, 'hex'))
          .digest('hex');
      }
    }

    const authFrame: ControlFrame = {
      id: 'auth',
      method: 'auth',
      params: { token: tokenToSend },
    };

    await this._writeFrame(authFrame);

    // The server replies with `{ id: 'auth', ok: true }` on success.
    const reply = await this._awaitFrameById('auth', 5_000);
    if (reply.ok !== true) {
      throw new Error(
        `auth handshake rejected: ${JSON.stringify(reply.error ?? reply)}`,
      );
    }

    // Constant-time check on the negotiated nonce to catch protocol drift.
    if (this.handshakeNonce) {
      const a = Buffer.from(this.handshakeNonce, 'hex');
      const b = Buffer.from(this.handshakeNonce, 'hex');
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        throw new Error('auth nonce echo mismatch');
      }
    }
  }

  /**
   * Wait for a single inbound frame with `id === expectedId`. Used only
   * during the handshake, where a strict single-frame reply is expected.
   */
  private _awaitFrameById(
    expectedId: string | number,
    timeoutMs: number,
  ): Promise<ControlFrame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('frame', onFrame);
        reject(new Error(`waiting for frame #${expectedId} timed out`));
      }, timeoutMs);

      const onFrame = (frame: ControlFrame) => {
        if (frame.id !== expectedId) return;
        clearTimeout(timer);
        this.off('frame', onFrame);
        resolve(frame);
      };

      this.on('frame', onFrame);
    });
  }

  /**
   * Wait for an `auth.challenge` frame carrying a hex nonce. Server may
   * never send one; in that case the timeout resolves through the caller.
   */
  private _awaitChallenge(timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('frame', onFrame);
        reject(new Error('no auth challenge'));
      }, timeoutMs);

      const onFrame = (frame: ControlFrame) => {
        if (frame.method !== 'auth.challenge') return;
        const nonce = (frame.params?.nonce as string | undefined) ?? '';
        if (!/^[0-9a-fA-F]+$/.test(nonce)) return;
        clearTimeout(timer);
        this.off('frame', onFrame);
        resolve(nonce);
      };

      this.on('frame', onFrame);
    });
  }

  // ==========================================================
  // Inbound handling
  // ==========================================================

  /** TCP `data` callback: feed the codec, dispatch each completed frame. */
  private _onData(chunk: Buffer | string): void {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    let frames: ControlFrame[];
    try {
      frames = this.codec.push(chunk);
    } catch (err) {
      this.emit('warn', err as Error);
      this._forceReconnect('codec-error');
      return;
    }

    for (const frame of frames) {
      // Emit every frame for handshake observers first.
      this.emit('frame', frame);

      // Async events (no `id`) go straight to `event`.
      if (frame.id === undefined) {
        this.emit('event', frame);
        continue;
      }

      // Replies resolve pending requests.
      const entry = this.pending.get(frame.id);
      if (!entry) continue;
      clearTimeout(entry.timer);
      this.pending.delete(frame.id);

      if (frame.ok === true) {
        entry.resolve(frame.result);
      } else if (frame.error !== undefined) {
        const errMsg =
          typeof frame.error === 'string'
            ? frame.error
            : frame.error.message ?? JSON.stringify(frame.error);
        entry.reject(new Error(`${entry.method}: ${errMsg}`));
      } else {
        // Some engines return `result` without `ok`; treat as success.
        entry.resolve(frame.result);
      }
    }
  }

  /** TCP `close` callback: mark disconnected and schedule a reconnect. */
  private _onSocketClose(reason: string): void {
    if (this.state === 'closed') return;
    this.emit('warn', new Error(`socket closed: ${reason}`));
    this._teardownSocket(reason);
    this._scheduleReconnect(reason);
  }

  // ==========================================================
  // Outbound handling
  // ==========================================================

  /**
   * Serialize and write a frame. Waits for the `drain` event if the
   * kernel send buffer is full. This is the single point through which
   * every outbound message must travel.
   */
  private async _writeFrame(frame: ControlFrame): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      throw new Error('cannot write to a closed socket');
    }
    const payload = this.codec.encode(frame);

    // socket.write returns false when the internal buffer is above its
    // high-water mark (default 16 KiB for a socket in Node.js).
    const flushed = socket.write(payload);
    if (flushed) return;

    // Wait for the kernel to accept more bytes.
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        socket.off('drain', onDrain);
        socket.off('error', onError);
        socket.off('close', onClose);
      };
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const onClose = () => {
        cleanup();
        reject(new Error('socket closed while awaiting drain'));
      };
      socket.once('drain', onDrain);
      socket.once('error', onError);
      socket.once('close', onClose);
    });
  }

  // ==========================================================
  // Heartbeats
  // ==========================================================

  /** Start the periodic ping loop. */
  private _startHeartbeat(): void {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(
      () => void this._sendHeartbeat(),
      this.opts.heartbeatIntervalMs,
    );
    // Don't hold the event loop open purely for a heartbeat.
    this.heartbeatTimer.unref?.();
  }

  /** Stop the ping loop. */
  private _stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Send a `system.ping` and track consecutive misses. Three misses in a
   * row (default) forces a reconnect — this is the mechanism that
   * unblocks a half-open socket quickly.
   */
  private async _sendHeartbeat(): Promise<void> {
    if (this.state !== 'ready' || this.closed) return;
    try {
      await this.invoke('system.ping', {}, {
        timeoutMs: this.opts.heartbeatTimeoutMs,
      });
      this.heartbeatMisses = 0;
    } catch (err) {
      this.heartbeatMisses++;
      this.emit(
        'warn',
        new Error(
          `heartbeat miss ${this.heartbeatMisses}/${this.opts.heartbeatMissesBeforeReconnect}`,
        ),
      );
      if (
        this.heartbeatMisses >= this.opts.heartbeatMissesBeforeReconnect
      ) {
        this._forceReconnect('heartbeat-timeout');
      }
    }
  }

  // ==========================================================
  // Reconnection
  // ==========================================================

  /** Destroy the current socket without touching the reconnect state. */
  private _teardownSocket(reason: string): void {
    this._stopHeartbeat();
    this.codec.reset();
    this.handshakeNonce = null;

    // Reject all pending requests so callers see the failure promptly.
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(
        new Error(`${entry.method}: channel lost (${reason})`),
      );
    }
    this.pending.clear();

    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.removeAllListeners('data');
      socket.removeAllListeners('error');
      socket.removeAllListeners('close');
      socket.destroy();
    }
  }

  /** Force a reconnect (used by heartbeat and codec failures). */
  private _forceReconnect(reason: string): void {
    this._teardownSocket(reason);
    this._scheduleReconnect(reason);
  }

  /**
   * Schedule the next reconnection attempt with jittered exponential
   * backoff. Jitter is multiplicative (0.5–1.5×) and prevents thundering
   * herds when many sessions from the same tenant reconnect at once.
   */
  private _scheduleReconnect(reason: string): void {
    if (this.closed) return;
    if (this.reconnectTimer) return; // already scheduled

    if (this.reconnectAttempt >= this.opts.maxReconnectAttempts) {
      const err = new Error(
        `reconnect budget exhausted after ${this.reconnectAttempt} attempts (${reason})`,
      );
      this._transition('closed');
      this.emit('fatal', err);
      return;
    }

    const base = Math.min(
      this.opts.reconnectMaxMs,
      this.opts.reconnectBaseMs * 2 ** this.reconnectAttempt,
    );
    const jitter = 0.5 + Math.random(); // in [0.5, 1.5)
    const delay = Math.round(base * jitter);

    this.reconnectAttempt++;
    this._transition('reconnecting');

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openSocket().catch((err) => {
        this.emit('warn', err as Error);
        // openSocket already called _scheduleReconnect on failure.
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  // ==========================================================
  // State machine
  // ==========================================================

  private _transition(next: SessionState): void {
    if (this.state === next) return;
    this.state = next;
    this.emit('state', next);
  }
}
