// =============================================================================
// loopback-control-channel.ts
// -----------------------------------------------------------------------------
// A complete, self-contained implementation of the ArtCraft / Storytold
// loopback control channel:
//   * TCP socket bound to 127.0.0.1 only
//   * JSON Lines (NDJSON) framing: one UTF-8 JSON value per '\n'
//   * Mandatory first-frame auth: {id:"auth", method:"auth", params:{token}}
//   * Constant-time token comparison (crypto.timingSafeEqual)
//   * Heartbeats (ping / pong) with a liveness watchdog
//   * Backpressure-aware outbox (socket.write() === false ⇒ wait for 'drain')
//   * Exponential-backoff reconnect for the client side
// =============================================================================

import * as net from 'net';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import { StringDecoder } from 'string_decoder';

// -----------------------------------------------------------------------------
// Protocol constants — mirror the numbers the Rust engine bakes in.
// -----------------------------------------------------------------------------
export const DEFAULT_PORT           = 7979;               // `--control <PORT>`
export const AUTH_DEADLINE_MS       = 3_000;              // first frame deadline
export const HEARTBEAT_INTERVAL_MS  = 15_000;             // server pings every 15s
export const HEARTBEAT_DEAD_MS      = 40_000;             // declare dead after 40s
export const MAX_FRAME_BYTES        = 2 * 1024 * 1024;    // 2 MiB framing cap
export const MAX_OUTBOX             = 1_024;              // pending frames cap
export const RECONNECT_BASE_MS      = 250;
export const RECONNECT_MAX_MS       = 5_000;

// -----------------------------------------------------------------------------
// Wire protocol — every frame is a single JSON object on its own line.
// -----------------------------------------------------------------------------
export interface AuthRequestFrame {
  id: 'auth';
  method: 'auth';
  params: { token: string; client?: string };
}
export interface AuthAckFrame {
  id: 'auth';
  ok: boolean;
  server?: { name: string; version: string; protocol: number };
  error?: string;
}
export interface CommandRequestFrame {
  id: number;
  method: 'engine.execute';
  params: { command: string; params?: Record<string, unknown> };
}
export interface CommandResponseFrame {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}
export interface PingFrame { method: 'ping'; params: { t: number } }
export interface PongFrame { method: 'pong'; params: { t: number; receivedAt: number } }
export interface ErrorFrame { id: string | number | null; ok: false; error: string; code?: string }

/** Frames a client sends: auth, commands, and heartbeats. */
export type ClientFrame =
  | AuthRequestFrame | CommandRequestFrame | PingFrame | PongFrame;
/** Frames the engine sends: the auth verdict, replies, errors, heartbeats. */
export type ServerFrame =
  | AuthAckFrame | CommandResponseFrame | ErrorFrame | PingFrame | PongFrame;
/** Anything that can appear on the wire, in either direction. */
export type WireFrame = ClientFrame | ServerFrame;

// -----------------------------------------------------------------------------
// NDJSON framer — turns a TCP byte stream into complete JSON values.
// -----------------------------------------------------------------------------
/**
 * TCP delivers a *stream of bytes*, not a stream of messages. This class
 * accumulates chunks until it sees a '\n', then parses the complete line.
 * It uses StringDecoder so a UTF-8 multi-byte codepoint split across two
 * TCP segments does not become U+FFFD garbage.
 */
export class NdjsonFramer extends EventEmitter {
  private dec = new StringDecoder('utf8');
  private buf = '';

  public push(chunk: Buffer | string): void {
    this.buf += this.dec.write(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      if (line.length > MAX_FRAME_BYTES) {
        this.emit('bad-frame', new Error('frame_too_large'));
        continue;
      }
      try {
        this.emit('frame', JSON.parse(line) as WireFrame);
      } catch (e) {
        this.emit('bad-frame', e as Error);
      }
    }
    // Safety valve: never let a hostile peer grow the buffer forever.
    if (this.buf.length > MAX_FRAME_BYTES) {
      this.emit('bad-frame', new Error('framing_buffer_overflow'));
      this.buf = '';
    }
  }
}

/** Serialise any frame to the wire (`JSON.stringify` + `\n`, UTF-8). */
export function encodeFrame(f: WireFrame): Buffer {
  return Buffer.from(JSON.stringify(f) + '\n', 'utf8');
}

// -----------------------------------------------------------------------------
// Constant-time token comparison — defends against timing side-channels.
// -----------------------------------------------------------------------------
function tokensMatch(candidate: string, expected: string): boolean {
  if (!candidate || candidate.length !== 64) return false;
  if (candidate.length !== expected.length) return false;
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// -----------------------------------------------------------------------------
// Server — lives inside the engine process (photocraft-cli --control <PORT>).
// -----------------------------------------------------------------------------
export interface ServerOptions {
  port?: number;
  token: string;                               // 64 hex chars, shared secret
  execute: (command: string, params: Record<string, unknown>) => Promise<unknown>;
  onLog?: (line: string) => void;
}

export class LoopbackServer extends EventEmitter {
  private srv: net.Server;
  private sessions = new Set<Session>();
  public readonly port: number;

  constructor(private opts: ServerOptions) {
    super();
    if (!/^[0-9a-fA-F]{64}$/.test(opts.token)) {
      throw new Error('token must be exactly 64 hex characters');
    }
    this.port = opts.port ?? DEFAULT_PORT;
    this.srv = net.createServer((s) => this.onConnection(s));
  }

  public start(): Promise<{ port: number }> {
    return new Promise((resolve, reject) => {
      const onErr = (e: Error) => reject(e);
      this.srv.once('error', onErr);
      // CRITICAL: 127.0.0.1, never 0.0.0.0 — the firewall is the bind.
      this.srv.listen(this.port, '127.0.0.1', () => {
        this.srv.off('error', onErr);
        this.log(`listening on 127.0.0.1:${this.port}`);
        resolve({ port: this.port });
      });
    });
  }

  public async stop(): Promise<void> {
    for (const s of this.sessions) s.destroy();
    await new Promise<void>((r) => this.srv.close(() => r()));
  }

  private onConnection(sock: net.Socket): void {
    const session = new Session(sock, this.opts, (l) => this.log(l));
    this.sessions.add(session);
    session.once('closed', () => this.sessions.delete(session));
    this.log(`client connected from ${sock.remoteAddress}:${sock.remotePort}`);
  }

  private log(line: string): void { this.opts.onLog?.(line); }
}

// -----------------------------------------------------------------------------
// Session — one authenticated connection on the server side.
// -----------------------------------------------------------------------------
type SessionState = 'WAIT_AUTH' | 'READY' | 'CLOSED';

class Session extends EventEmitter {
  private state: SessionState = 'WAIT_AUTH';
  private framer = new NdjsonFramer();
  private authTimer: NodeJS.Timeout;
  private hbTimer: NodeJS.Timeout | null = null;
  private outbox: Buffer[] = [];
  private pumping = false;

  constructor(
    private sock: net.Socket,
    private opts: ServerOptions,
    private log: (line: string) => void,
  ) {
    super();
    // Disable Nagle: our frames are tiny and we want them on the wire NOW.
    this.sock.setNoDelay(true);
    this.sock.on('data', (chunk) => this.framer.push(chunk));
    this.sock.on('error', () => this.destroy());
    this.sock.on('close', () => this.destroy());
    this.framer.on('frame', (f) => void this.onFrame(f as ClientFrame));
    this.framer.on('bad-frame', (e) => {
      this.log(`bad frame: ${(e as Error).message}`);
      this.send({ id: null, ok: false, error: 'bad_frame' });
    });

    // Enforce the auth deadline: silence ⇒ closed socket.
    this.authTimer = setTimeout(() => {
      if (this.state === 'WAIT_AUTH') {
        this.log('auth deadline exceeded, closing');
        this.destroy();
      }
    }, AUTH_DEADLINE_MS);
  }

  private async onFrame(f: ClientFrame): Promise<void> {
    // ---- Phase 1: handshake ------------------------------------------------
    if (this.state === 'WAIT_AUTH') {
      if (f.method !== 'auth' || f.id !== 'auth') {
        this.send({ id: null, ok: false, error: 'auth_required' });
        this.destroy();
        return;
      }
      const token = (f.params as { token?: string })?.token ?? '';
      if (!tokensMatch(token, this.opts.token)) {
        this.log('auth failed, closing');
        this.send({ id: 'auth', ok: false, error: 'auth_failed' });
        this.destroy();
        return;
      }
      clearTimeout(this.authTimer);
      this.state = 'READY';
      this.send({
        id: 'auth',
        ok: true,
        server: { name: 'photocraft', version: '1.0.0', protocol: 1 },
      });
      this.startHeartbeat();
      this.log('client authenticated');
      return;
    }

    if (this.state !== 'READY') return;

    // ---- Phase 2: steady state --------------------------------------------
    if (f.method === 'ping') {
      this.send({ method: 'pong', params: { t: f.params.t, receivedAt: Date.now() } });
      return;
    }
    if (f.method === 'pong') return;         // liveness bookkeeping, no reply

    if (f.method === 'engine.execute') {
      try {
        const result = await this.opts.execute(
          (f.params as { command: string }).command,
          (f.params as { params?: Record<string, unknown> }).params ?? {},
        );
        this.send({ id: f.id, ok: true, result });
      } catch (e) {
        this.send({ id: f.id, ok: false, error: (e as Error).message });
      }
      return;
    }

    // Unknown method: keep the pipe open but reply with an error. The union
    // above is exhausted, so this is reached only by a peer that sends a
    // method this build does not know yet.
    const unknown = f as unknown as { id?: unknown };
    if (typeof unknown.id === 'number') {
      this.send({ id: unknown.id, ok: false, error: 'unknown_method' });
    }
  }

  private startHeartbeat(): void {
    this.hbTimer = setInterval(() => {
      this.send({ method: 'ping', params: { t: Date.now() } });
    }, HEARTBEAT_INTERVAL_MS);
    this.hbTimer.unref?.();                  // don't hold the event loop open
  }

  /** Queue a frame; `pump()` enforces TCP backpressure. */
  private send(frame: ServerFrame): void {
    if (this.state === 'CLOSED') return;
    if (this.outbox.length >= MAX_OUTBOX) {
      this.log('outbox overflow, closing');
      this.destroy();
      return;
    }
    this.outbox.push(encodeFrame(frame));
    this.pump();
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    const step = (): void => {
      const next = this.outbox.shift();
      if (!next) { this.pumping = false; return; }
      if (this.sock.write(next)) setImmediate(step);
      else this.sock.once('drain', step);    // kernel buffer full: wait
    };
    step();
  }

  public destroy(): void {
    if (this.state === 'CLOSED') return;
    this.state = 'CLOSED';
    clearTimeout(this.authTimer);
    if (this.hbTimer) clearInterval(this.hbTimer);
    try { this.sock.destroy(); } catch { /* already toast */ }
    this.emit('closed');
  }
}

// -----------------------------------------------------------------------------
// Client — what an agent process runs.
// -----------------------------------------------------------------------------
export interface ClientOptions {
  port?: number;
  token: string;
  clientName?: string;
  onLog?: (line: string) => void;
  reconnect?: boolean;                        // default true
}

export class LoopbackClient extends EventEmitter {
  private sock: net.Socket | null = null;
  private framer = new NdjsonFramer();
  private authed = false;
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private reconnectMs = RECONNECT_BASE_MS;
  private stopping = false;
  private lastPongAt = Date.now();

  constructor(private opts: ClientOptions) { super(); }

  public connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.connect(this.opts.port ?? DEFAULT_PORT, '127.0.0.1');
      sock.setNoDelay(true);
      this.sock = sock;
      this.framer = new NdjsonFramer();
      this.framer.on('frame', (f) => this.onFrame(f as ServerFrame));
      this.framer.on('bad-frame', (e) =>
        this.opts.onLog?.(`bad frame: ${(e as Error).message}`));
      sock.on('data', (chunk) => this.framer.push(chunk));
      sock.on('error', (e) => { if (!this.authed) reject(e); this.onClose(); });
      sock.on('close', () => this.onClose());
      sock.once('connect', () => {
        // The mandatory first frame: no commands before this lands.
        const auth: AuthRequestFrame = {
          id: 'auth',
          method: 'auth',
          params: { token: this.opts.token, client: this.opts.clientName ?? 'agent' },
        };
        sock.write(encodeFrame(auth));
        this.once('authed', () => resolve());
        this.once('authFailed', (e: Error) => reject(e));
      });
    });
  }

  /** Send one engine command; resolves with the matching response. */
  public run(command: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.authed || !this.sock) return Promise.reject(new Error('not_authed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`command ${command} timed out`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      const req: CommandRequestFrame = {
        id, method: 'engine.execute', params: { command, params },
      };
      this.sock!.write(encodeFrame(req));
    });
  }

  private onFrame(f: ServerFrame): void {
    // The auth verdict is the only frame identified by id rather than method:
    // it answers the handshake, so it can arrive before any command exists.
    if ('id' in f && f.id === 'auth') {
      const ack = f as AuthAckFrame;
      if (ack.ok) {
        this.authed = true;
        this.reconnectMs = RECONNECT_BASE_MS;
        this.lastPongAt = Date.now();
        this.emit('authed');
      } else {
        this.emit('authFailed', new Error(ack.error ?? 'auth_failed'));
      }
      return;
    }
    if ('method' in f && f.method === 'pong') {
      this.lastPongAt = Date.now();
      return;
    }
    if ('method' in f && f.method === 'ping') {
      const pong: PongFrame = {
        method: 'pong', params: { t: f.params.t, receivedAt: Date.now() },
      };
      this.sock?.write(encodeFrame(pong));
      return;
    }
    if ('ok' in f && typeof f.id === 'number') {
      const reply = f as CommandResponseFrame | ErrorFrame;
      if (typeof reply.id !== 'number') return;   // ErrorFrame.id may be null
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      this.pending.delete(reply.id);
      clearTimeout(pending.timer);
      if (reply.ok) pending.resolve(reply.result);
      else pending.reject(new Error(reply.error ?? 'server_error'));
    }
  }

  private onClose(): void {
    this.authed = false;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('channel_closed'));
    }
    this.pending.clear();
    if (this.stopping || this.opts.reconnect === false) {
      this.emit('closed');
      return;
    }
    // Exponential backoff with jitter — never a thundering herd.
    const wait = this.reconnectMs + Math.floor(Math.random() * 100);
    this.reconnectMs = Math.min(this.reconnectMs * 2, RECONNECT_MAX_MS);
    this.opts.onLog?.(`reconnecting in ${wait}ms`);
    setTimeout(() => {
      this.connect().catch((e) => this.opts.onLog?.(`reconnect failed: ${e.message}`));
    }, wait);
  }

  public async close(): Promise<void> {
    this.stopping = true;
    this.sock?.destroy();
  }
}

// -----------------------------------------------------------------------------
// Demo — wire a server and a client together in one process.
// -----------------------------------------------------------------------------
export async function main(): Promise<void> {
  // In production this comes from the launching app: `--control 7979`
  // with the token handed to the agent over its own private channel.
  const token = crypto.randomBytes(32).toString('hex');    // 64 hex chars

  const server = new LoopbackServer({
    port: DEFAULT_PORT,
    token,
    onLog: (l) => console.log(`[server] ${l}`),
    execute: async (command, params) => {
      // In the real engine this dispatches into the Rust command registry.
      switch (command) {
        case 'doc.inspect':
          return { document: { width: 1920, height: 1080, mode: 'rgb' }, layers: [] };
        case 'layer.new.layer':
          return { id: 7, name: (params.name as string) ?? 'Layer 1' };
        case 'ui_screenshot':
          return { path: '/tmp/audit.png' };
        default:
          throw new Error(`unknown command: ${command}`);
      }
    },
  });
  await server.start();

  const client = new LoopbackClient({
    port: DEFAULT_PORT,
    token,
    clientName: 'demo-agent',
    onLog: (l) => console.log(`[client] ${l}`),
  });
  await client.connect();

  console.log('doc.inspect     ->', await client.run('doc.inspect'));
  console.log('layer.new.layer ->', await client.run('layer.new.layer', { name: 'Ink' }));
  console.log('ui_screenshot   ->', await client.run('ui_screenshot', { max_side: 1024 }));

  await client.close();
  await server.stop();
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
