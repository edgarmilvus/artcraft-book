// Language: typescript
// rig-panel.ts
import * as net from "node:net";
import { writeFile } from "node:fs/promises";

/* ------------------------------------------------------------------ *
 * 1. Errors — discriminated on code, with a hint.
 * ------------------------------------------------------------------ */

export type LiveErrorCode =
  | "AuthFailed"
  | "FrameTimeout"
  | "SandboxViolation"
  | "SelectionInvalid"
  | "RigBatchFailed";

class LiveError extends Error {
  constructor(public readonly code: LiveErrorCode, message: string, public readonly hint: string) {
    super(message);
  }
}

/* ------------------------------------------------------------------ *
 * 2. Frame types
 * ------------------------------------------------------------------ */

export type MethodName =
  | "auth"
  | "engine.execute"
  | "command.list"
  | "ui.screenshot";

interface Frame { id: number | "auth"; method: MethodName; params: Record<string, unknown>; }
interface FrameResponse { id: number | "auth"; ok: boolean; result?: unknown; error?: { code: string; message: string }; }

export function isBatchResult(v: unknown): v is { steps: number; results: unknown[] } {
  return typeof v === "object" && v !== null && "steps" in v && Array.isArray((v as any).results);
}
export function isScreenshotResult(v: unknown): v is { path: string; bytes: number } {
  return typeof v === "object" && v !== null && "path" in v && typeof (v as any).path === "string";
}
export function isPropertyGetResult(v: unknown): v is { path: string; value: number | number[] } {
  return (
    typeof v === "object" &&
    v !== null &&
    "path" in v &&
    typeof (v as any).path === "string" &&
    "value" in v
  );
}

/* ------------------------------------------------------------------ *
 * 3. The client
 * ------------------------------------------------------------------ */

export class CraftLiveClient {
  private socket: net.Socket | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: FrameResponse) => void; reject: (e: Error) => void }>();
  private authPromise: Promise<void> | null = null;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly token: string,
    private readonly writeRoot: string,
  ) {}

  async connect(): Promise<void> {
    this.socket = net.createConnection({ host: this.host, port: this.port });
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk: string) => this.onData(chunk));
    this.socket.on("error", (err) => this.failAll(err));
    this.socket.on("close", () => this.failAll(new Error("socket closed")));

    await new Promise<void>((resolve, reject) => {
      this.socket!.once("connect", () => resolve());
      this.socket!.once("error", (err) => reject(err));
    });

    // Mandatory auth frame first — no other frame may precede it.
    const authFrame: Frame = { id: "auth", method: "auth", params: { token: this.token } };
    this.socket.write(JSON.stringify(authFrame) + "\n");
    this.authPromise = this.awaitAuth();
    await this.authPromise;
  }

  private authDeferred: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private awaitAuth(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.authDeferred = { resolve, reject };
      const t = setTimeout(() => reject(new LiveError("FrameTimeout", "auth timeout", "Increase timeout or verify the app is running on this port")), 5000);
      const wrap = <T extends (...args: never[]) => void>(fn: T): T =>
        ((...args: never[]) => { clearTimeout(t); fn(...args); }) as T;
      this.authDeferred.resolve = wrap(this.authDeferred.resolve);
      this.authDeferred.reject = wrap(this.authDeferred.reject);
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.trim().length === 0) continue;
      let frame: FrameResponse;
      try { frame = JSON.parse(line); } catch { continue; }
      if (frame.id === "auth") {
        const d = this.authDeferred;
        this.authDeferred = null;
        if (!d) continue;
        if (frame.ok) d.resolve();
        else d.reject(new LiveError("AuthFailed", frame.error?.message ?? "auth failed", "Verify the 64-hex-char token matches the app's --control-token"));
        continue;
      }
      const p = this.pending.get(frame.id as number);
      if (p) {
        this.pending.delete(frame.id as number);
        p.resolve(frame);
      }
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
    if (this.authDeferred) {
      const d = this.authDeferred;
      this.authDeferred = null;
      d.reject(err);
    }
  }

  async execute<R>(method: MethodName, params: unknown): Promise<R> {
    if (!this.socket) throw new Error("connect() first");
    const id = this.nextId++;
    const frame: Frame = { id, method, params: params as Record<string, unknown> };
    const promise = new Promise<FrameResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new LiveError("FrameTimeout", `frame ${id} (${method}) timed out`, "Increase the tool's timeout or check for a slow render on the app side"));
        }
      }, 5000);
    });
    this.socket.write(JSON.stringify(frame) + "\n");
    const res = await promise;
    if (!res.ok) throw new LiveError("RigBatchFailed", res.error?.message ?? "unknown", "Check the app's ERROR log panel");
    return res.result as R;
  }

  async screenshot(outRelPath: string): Promise<string> {
    if (outRelPath.startsWith("/") || outRelPath.includes("..")) {
      throw new LiveError("SandboxViolation", `refusing path ${outRelPath}`, "Pass a path under --automation-write-root");
    }
    const res = await this.execute<unknown>("ui.screenshot", {});
    if (!isScreenshotResult(res)) throw new Error("unexpected screenshot shape");
    const png = Buffer.from((res as any).dataBase64 ?? "", "base64");
    const abs = `${this.writeRoot}/${outRelPath}`;
    await writeFile(abs, png);
    return abs;
  }

  close(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.socket) return resolve();
      this.socket.end(() => resolve());
    });
  }
}

/* ------------------------------------------------------------------ *
 * 4. Rig construction
 * ------------------------------------------------------------------ */

const RIG_MARKER = "rig.stagger.v1";

interface SelectionInfo {
  ids?: number[];
  kind?: string;
  name?: string;
  comment?: string;
}

async function getSelectedShapeLayer(client: CraftLiveClient): Promise<SelectionInfo> {
  // The editor's selection is read with the `editor.state` command, carried
  // by the generic `engine.execute` envelope.
  const res = await client.execute<unknown>("engine.execute", {
    command: "editor.state",
    params: {},
  });
  if (typeof res !== "object" || res === null) throw new LiveError("SelectionInvalid", "no editor state", "Select a shape layer in the timeline");
  const info = res as { selection?: SelectionInfo };
  const sel = info.selection;
  if (!sel || !sel.ids || sel.ids.length !== 1 || sel.kind !== "shape") {
    throw new LiveError("SelectionInvalid", "select exactly one shape layer", "Click the shape layer row in the timeline");
  }
  return sel;
}

export async function injectRig(client: CraftLiveClient, stagger: number): Promise<number> {
  const sel = await getSelectedShapeLayer(client);
  const layerId = sel.ids![0]!;

  // 1. Atomic batch that constructs the repeater + trim and keys the initial stagger.
  const batch = {
    steps: [
      {
        command: "layer.addShapeItem",
        params: { layer: layerId, kind: "repeater", name: "Rig: Repeater" },
      },
      {
        command: "layer.addShapeItem",
        params: { layer: layerId, kind: "trim" },
      },
      {
        command: "prop.addKey",
        params: {
          layer: layerId,
          path: "shape/Repeater 1/copies",
          time: 0,
          value: 8,
        },
      },
      {
        command: "prop.addKey",
        params: {
          layer: layerId,
          path: "shape/Repeater 1/offset",
          time: 0,
          value: stagger,
        },
      },
      {
        command: "layer.setComment",
        params: { layers: [layerId], comment: RIG_MARKER },
      },
    ],
    atomic: true,
    label: "Rig: Repeater + Stagger",
  };

  const res = await client.execute<unknown>("engine.execute", {
    command: "engine.batch",
    params: batch,
  });
  if (!isBatchResult(res)) throw new LiveError("RigBatchFailed", "batch returned unexpected shape", "See the app's log");
  return layerId as number;
}

/* ------------------------------------------------------------------ *
 * 5. Idempotent stagger setter
 * ------------------------------------------------------------------ */

export async function setStagger(client: CraftLiveClient, layerId: number, value: number): Promise<void> {
  // Discover the existing keys and update in place — never append.
  const offsetProp = await client.execute<unknown>("engine.execute", {
    command: "get_property",
    params: { layer: layerId, path: "shape/Repeater 1/offset" },
  });
  if (!isPropertyGetResult(offsetProp)) throw new Error("unexpected get_property shape");
  const existingKeys = (offsetProp as any).keyframes as Array<{ time: number }> | undefined;

  const steps = existingKeys && existingKeys.length > 0
    ? [
        {
          command: "keys.set",
          params: { layer: layerId, path: "shape/Repeater 1/offset", time: existingKeys[0]?.time ?? 0, value },
        },
      ]
    : [
        {
          command: "prop.addKey",
          params: { layer: layerId, path: "shape/Repeater 1/offset", time: 0, value },
        },
      ];

  await client.execute<unknown>("engine.execute", {
    command: "engine.batch",
    params: { steps, atomic: true, label: "Rig: Stagger update" },
  });
}

/* ------------------------------------------------------------------ *
 * 6. Non-destructive reset
 * ------------------------------------------------------------------ */

export async function reset(client: CraftLiveClient): Promise<"undone" | "skipped"> {
  const hist = await client.execute<unknown>("engine.execute", {
    command: "edit.history.list",
    params: {},
  });
  const events = (hist as any)?.states as Array<{ label: string }> | undefined;
  const top = events?.[events.length - 1];
  if (!top || top.label !== "Rig: Repeater + Stagger") {
    console.log("reset: skipped, state not owned");
    return "skipped";
  }
  await client.execute<unknown>("engine.execute", {
    command: "edit.undo",
    params: {},
  });
  return "undone";
}

/* ------------------------------------------------------------------ *
 * 7. CLI harness
 * ------------------------------------------------------------------ */

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  const args = Object.fromEntries(rest.reduce<Array<[string, string]>>((acc, cur, i, arr) => {
    if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1] ?? ""]);
    return acc;
  }, []));

  const port = Number(args.port ?? "7979");
  const token = process.env.EFFECTCRAFT_TOKEN ?? "";
  const writeRoot = process.env.PWD ?? process.cwd();

  const client = new CraftLiveClient("127.0.0.1", port, token, writeRoot);
  try {
    await client.connect();
    switch (cmd) {
      case "rig": {
        const layerId = await injectRig(client, 0);
        console.log(`rig: injected on layer ${layerId}`);
        break;
      }
      case "stagger": {
        const layerId = await getSelectedShapeLayer(client).then((s) => s.ids![0]!);
        await setStagger(client, layerId, Number(args.value ?? 0));
        break;
      }
      case "reset": {
        console.log(`reset: ${await reset(client)}`);
        break;
      }
      default:
        throw new Error(`unknown subcommand: ${cmd}`);
    }
    await client.screenshot("out/rig-preview.png").then((p) => console.log(`preview: ${p}`));
  } finally {
    await client.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((err) => {
    if (err instanceof LiveError) {
      console.error(`[${err.code}] ${err.message}\n  hint: ${err.hint}`);
    } else {
      console.error(err);
    }
    process.exit(1);
  });
}
