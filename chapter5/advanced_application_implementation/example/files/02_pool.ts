/**
 * @file creativeforge/pool.ts
 *
 * Manages the lifecycle of MCP clients spawned against the ArtCraft CLI
 * binaries. One client per (session, app) pair. Connections are lazy: we
 * only spawn a worker the first time the LLM actually needs that app.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Session, CraftApp } from './session.js';

/** How many times we silently respawn a crashed worker before giving up. */
const RESPAWN_BUDGET = 2;

/** Backoff schedule (ms) between respawn attempts. */
const RESPAWN_BACKOFF = [250, 1_500];

/** Map a CraftApp id to the executable name shipped by ArtCraft. */
const BINARY: Record<CraftApp, string> = {
  photocraft:  'photocraft-cli',
  vectorcraft: 'vectorcraft-cli',
  filmcraft:   'filmcraft-cli',
  effectcraft: 'effectcraft-cli',
  designcraft: 'designcraft-cli',
  lightcraft:  'lightcraft-cli',
  pdfcraft:    'pdfcraft-cli',
  wordcraft:   'wordcraft-cli',
};

/**
 * Wraps a single ArtCraft MCP worker. Holds the transport so we can respawn
 * the underlying process on failure while keeping the same Client façade.
 */
class WorkerHandle {
  private client: Client | null = null;
  private respawns = 0;

  public constructor(
    public readonly app: CraftApp,
    private readonly session: Session,
  ) {}

  /** Lazily start the worker and complete the MCP handshake. */
  public async ensure(): Promise<Client> {
    if (this.client) return this.client;

    const transport = new StdioClientTransport({
      command: BINARY[this.app],
      args: [
        'mcp',
        '--automation-read-root',  this.session.readRoot,
        '--automation-write-root', this.session.writeRoot,
      ],
      // Capture stderr so we can attach it to audit records on failure.
      stderr: 'pipe',
    });

    const client = new Client(
      { name: `creativeforge-orchestrator/${this.app}`, version: '1.0.0' },
      { capabilities: {} },
    );

    await client.connect(transport);

    // Surface worker stderr into the orchestrator's log stream.
    transport.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString('utf8').trimEnd();
      if (line) {
        console.debug(`[${this.app}/${this.session.sessionId}] ${line}`);
      }
    });

    this.client = client;
    this.session.clients.set(this.app, client);
    return client;
  }

  /**
   * Run one MCP tool call, respawning the worker if the transport has
   * dropped (a plausible outcome when a headless render OOMs the process).
   */
  public async callTool<T>(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    let client = await this.ensure();
    try {
      const res = await client.callTool({ name: toolName, arguments: args });
      this.respawns = 0;
      return res as unknown as T;
    } catch (err) {
      if (this.respawns >= RESPAWN_BUDGET) throw err;
      const delay = RESPAWN_BACKOFF[this.respawns] ?? 2_000;
      this.respawns += 1;
      console.warn(
        `[pool] ${this.app} call "${toolName}" failed; respawning in ${delay}ms`,
        err,
      );
      await new Promise((r) => setTimeout(r, delay));
      try { await client.close(); } catch { /* already dead */ }
      this.client = null;
      this.session.clients.delete(this.app);
      client = await this.ensure();
      const res = await client.callTool({ name: toolName, arguments: args });
      this.respawns = 0;
      return res as unknown as T;
    }
  }

  /**
   * The worker's live tool registry. This is the ground truth the router's
   * "declared tools only" rule is checked against — never a hard-coded list.
   */
  public async listTools(): Promise<Array<{ name: string; description?: string }>> {
    const client = await this.ensure();
    const { tools } = await client.listTools();
    return tools.map((t) => ({ name: t.name, description: t.description }));
  }
}

/**
 * Public façade used by the router. Callers ask for "the PhotoCraft client
 * for this session" and get a handle that lazily spawns on first use.
 */
export class ClientPool {
  private readonly handles = new Map<string, WorkerHandle>();

  public acquire(session: Session, app: CraftApp): WorkerHandle {
    const key = `${session.sessionId}::${app}`;
    let h = this.handles.get(key);
    if (!h) {
      h = new WorkerHandle(app, session);
      this.handles.set(key, h);
    }
    return h;
  }

  /** Explicitly release every worker owned by a session (see Session.dispose). */
  public forget(session: Session): void {
    for (const key of [...this.handles.keys()]) {
      if (key.startsWith(`${session.sessionId}::`)) this.handles.delete(key);
    }
  }
}
