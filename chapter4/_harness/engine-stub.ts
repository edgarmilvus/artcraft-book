/**
 * A protocol-faithful stand-in for the engine's loopback control port.
 *
 * The shipped CLIs speak MCP over stdio; the chapter's TCP protocol
 * (`auth` → `system.ping` → `engine.execute`) has no upstream process to
 * talk to, so both harnesses here drive the book's client against this.
 */
import { createServer, type Server, type Socket } from 'node:net';
import { createHmac, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

// 1x1 transparent PNG, enough for a screenshot round-trip.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

type Frame = {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  ok?: boolean;
  result?: unknown;
  error?: string | { code: string | number; message: string };
};

// ─── the engine stub ────────────────────────────────────────────────────────
interface StubOptions {
  token: string;
  challenge: boolean;
  port: number;
}

export class EngineStub {
  private srv: Server;
  private sockets = new Set<Socket>();
  public calls: string[] = [];
  public commands: string[] = [];
  public layers: Array<{ id: number; name: string }> = [];
  public nextLayerId = 1;
  public docCount = 1;
  private nonce = '';

  constructor(private opts: StubOptions) {
    this.srv = createServer((s) => this.onConnection(s));
  }

  public start(): Promise<void> {
    return new Promise((resolve) => this.srv.listen(this.opts.port, '127.0.0.1', resolve));
  }

  /** Kill every live connection without stopping the listener (reconnect tests). */
  public dropConnections(): number {
    const n = this.sockets.size;
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    return n;
  }

  public stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    return new Promise((resolve) => this.srv.close(() => resolve()));
  }

  private onConnection(sock: Socket): void {
    this.sockets.add(sock);
    let buf = '';
    this.nonce = randomBytes(16).toString('hex');
    if (this.opts.challenge) {
      sock.write(JSON.stringify({ method: 'auth.challenge', params: { nonce: this.nonce } }) + '\n');
    }
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        void this.onFrame(JSON.parse(line) as Frame, sock);
      }
    });
    sock.on('error', () => this.sockets.delete(sock));
    sock.on('close', () => this.sockets.delete(sock));
  }

  private send(sock: Socket, f: Frame): void {
    sock.write(JSON.stringify(f) + '\n');
  }

  private async onFrame(f: Frame, sock: Socket): Promise<void> {
    this.calls.push(String(f.method));

    if (f.method === 'auth') {
      const presented = String(f.params?.['token'] ?? '');
      const expected = this.opts.challenge
        ? createHmac('sha256', Buffer.from(this.opts.token, 'hex'))
            .update(Buffer.from(this.nonce, 'hex'))
            .digest('hex')
        : this.opts.token;
      if (presented !== expected) {
        this.send(sock, { id: 'auth', ok: false, error: { code: 'auth_failed', message: 'token mismatch' } });
        sock.destroy();
        return;
      }
      this.send(sock, { id: 'auth', ok: true });
      return;
    }

    if (f.id === 'hb' || f.method === 'system.ping') {
      this.send(sock, { id: f.id, ok: true, result: { pong: true, at: Date.now() } });
      return;
    }

    // The session exposes both shapes: `invoke` sends a raw method, while
    // `executeCommand` wraps `engine.execute`. `screenshot()` uses the raw
    // form, so the stub answers it directly.
    if (f.method === 'ui.screenshot') {
      // The protocol lets the caller name a path; the engine writes the PNG
      // there and still returns the bytes, so callers can pick either.
      const target = f.params?.['path'];
      if (typeof target === 'string') {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, Buffer.from(PNG_B64, 'base64'));
      }
      this.send(sock, {
        id: f.id,
        ok: true,
        result: { data: PNG_B64, path: typeof target === 'string' ? target : '/tmp/stub-shot.png' },
      });
      return;
    }
    if (f.method === 'system.version') {
      this.send(sock, { id: f.id, ok: true, result: { name: 'stub', version: '1.0.0' } });
      return;
    }

    if (f.method === 'engine.batch') {
      const steps = (f.params?.steps ?? []) as Array<{ id: string }>;
      const applied = steps.map((s) => this.apply(s.id, {}));
      this.send(sock, { id: f.id, ok: true, result: { applied } });
      return;
    }

    if (f.method === 'engine.execute') {
      const command = String(f.params?.command ?? '');
      this.commands.push(command);
      const params = (f.params?.params ?? {}) as Record<string, unknown>;
      try {
        this.send(sock, { id: f.id, ok: true, result: this.apply(command, params) });
      } catch (e) {
        this.send(sock, { id: f.id, ok: false, error: { code: 'command_failed', message: (e as Error).message } });
      }
      return;
    }

    console.error(`stub: unknown method ${String(f.method)}`);
    this.send(sock, { id: f.id, ok: false, error: { code: 'unknown_method', message: String(f.method) } });
  }

  private apply(command: string, params: Record<string, unknown>): unknown {
    switch (command) {
      case 'doc.inspect':
      case 'document.inspect':
        return { document: { width: 1920, height: 1080, mode: 'rgb' }, layers: this.layers };
      case 'file.new': {
        this.layers = [];
        return { index: this.docCount++ };
      }
      case 'file.save':
        return { path: String(params.path ?? 'saved.pcraft'), bytes: 1024 };
      case 'layer.new.layer': {
        const layer = { id: this.nextLayerId++, name: String(params.name ?? 'Layer') };
        this.layers.push(layer);
        return layer;
      }
      case 'ui.screenshot':
        return { data: PNG_B64, path: '/tmp/stub-shot.png' };
      default:
        throw new Error(`stub does not implement ${command}`);
    }
  }
}

