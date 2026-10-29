/**
 * cathedral / supervisor.ts
 * -------------------------
 * Supervisor Node for Cathedral Post.
 *
 *   call-sheet.json ──► DelegationTask[] ──► worker-{a,b,c}
 *        │                    │                   (one FilmCraft session each)
 *        │                    ├─ command_batch / command_run
 *        │                    ├─ $N.path result interpolation
 *        │                    └─ undoMarkers on failure
 *        │
 *        ├─► <runsRoot>/<runId>/delegations.jsonl   (HMAC-chained)
 *        └─► <runsRoot>/<runId>/manifest.json
 *
 * Engine facts this file relies on (FilmCraft 0.5.0):
 *
 *   • the MCP meta-tools are `command_run {id, params}`,
 *     `command_batch {steps, stop_on_error}`, `command_list {filter,
 *     enabled_only}`, `media_import {text}`, `project_inspect`,
 *     `sequence_inspect` and `doc_inspect`;
 *   • `command_run` answers the command's own payload — `timeline.place`
 *     answers `{clips: [videoClipId, audioClipId]}`, and the audio id is
 *     present only when the media carries audio;
 *   • `command_batch` answers `{completed, failed, results: [{ok, result}]}`
 *     and *every edit inside it is its own undo step*: the batch is not
 *     atomic, which is exactly why the rollback undoes one marker at a time;
 *   • `command_batch` does not interpolate `$N.path` references (that is a
 *     DesignCraft `batch` feature), so the worker resolves them itself and
 *     splits the scene into as many batches as the references demand;
 *   • `timeline.place` takes `item` as a *project item id* — never as a path —
 *     and takes `seconds` / `frame` / `timecode` as separate keys;
 *   • `sequence.applyVideoTransition` takes the video clip id and
 *     `sequence.applyAudioTransition` takes the audio clip id, and both need
 *     the playhead parked on the edit point.
 *
 * Dependencies: `zod` (schemas) and the Node standard library.
 */

import { createHmac, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { z } from "zod";

/* ══ 1. Engine vocabulary ═══════════════════════════════════════════════ */

/** FilmCraft's time base: 254 016 000 000 ticks to the second. */
export const TICKS_PER_SECOND = 254_016_000_000;

/** The worker agents the supervisor fans out to. */
export const WORKER_IDS = ["worker-a", "worker-b", "worker-c"] as const;
export type WorkerId = (typeof WORKER_IDS)[number];

/**
 * The FilmCraft command ids a delegation may carry. Every entry is a real id
 * in the engine's registry — `filmcraft-cli commands --json` is the oracle.
 * The catalogue is the *wire* contract; the studio policy decides which of
 * these a given role may actually run.
 */
export const FILMCRAFT_COMMAND_IDS = [
  "timeline.place",
  "timeline.select",
  "timeline.move",
  "timeline.trim",
  "timeline.razor",
  "timeline.slip",
  "timeline.slide",
  "timeline.roll",
  "sequence.addEdit",
  "sequence.addTracks",
  "sequence.deleteTracks",
  "sequence.applyVideoTransition",
  "sequence.applyAudioTransition",
  "sequence.setTransition",
  "sequence.inspect",
  "effects.apply",
  "effects.remove",
  "effects.setParam",
  "effects.list",
  "playhead.set",
  "markers.add",
  "edit.undo",
  "edit.redo",
  "edit.clear",
  "edit.duplicate",
  "file.import",
  "file.newSequence",
  "file.open",
  "file.save",
  "file.saveAs",
  "project.inspect",
  "mediaCache.info",
  "mediaCache.clean",
  "media.findMissing",
  "media.status",
] as const;

export type FilmCraftCommandId = (typeof FILMCRAFT_COMMAND_IDS)[number];

/**
 * The commands that open an undo step in FilmCraft's history. A marker is
 * pushed for each of them, and the rollback issues one `edit.undo` per
 * marker. Pure navigation (`playhead.set`, `timeline.select`) and pure
 * inspection never create history.
 */
const UNDOABLE_COMMANDS: ReadonlySet<string> = new Set<FilmCraftCommandId>([
  "timeline.place",
  "timeline.move",
  "timeline.trim",
  "timeline.razor",
  "timeline.slip",
  "timeline.slide",
  "timeline.roll",
  "sequence.addEdit",
  "sequence.addTracks",
  "sequence.deleteTracks",
  "sequence.applyVideoTransition",
  "sequence.applyAudioTransition",
  "sequence.setTransition",
  "effects.apply",
  "effects.remove",
  "effects.setParam",
  "markers.add",
  "edit.clear",
  "edit.duplicate",
]);

/**
 * Parse a SMPTE timecode (`hh:mm:ss:ff`, non-drop) into seconds.
 *
 * The call sheet carries record timecodes, so the studio needs one frame
 * rate for the whole run; `CallSheet.fps` carries it and defaults to 24.
 */
export function timecodeToSeconds(timecode: string, fps: number): number {
  const match = /^(\d{1,2}):(\d{2}):(\d{2})[:;](\d{2})$/.exec(timecode.trim());
  if (!match) throw new Error(`timecode: cannot parse "${timecode}"`);
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  const frames = Number(match[4] ?? 0);
  return hours * 3600 + minutes * 60 + seconds + frames / fps;
}

/** Round to microseconds — the engine's `seconds` parameter is a double. */
function roundSeconds(seconds: number): number {
  return Math.round(seconds * 1_000_000) / 1_000_000;
}

/* ══ 2. The delegation schema ════════════════════════════════════════════ */

const OperationSchema = z.object({
  id: z.enum(FILMCRAFT_COMMAND_IDS),
  params: z.record(z.string(), z.unknown()),
});

/**
 * The wire format between the supervisor and a worker. It is validated
 * before dispatch, so a supervisor bug becomes a validation failure instead
 * of a runtime error deep inside a worker session.
 */
export const DelegationTaskSchema = z.object({
  delegationId: z.string().uuid(),
  runId: z.string().min(1),
  agentId: z.enum(WORKER_IDS),
  targetSequence: z.string().min(1),
  scene: z.object({
    number: z.number().int().nonnegative(),
    slug: z.string().min(1),
  }),
  operations: z.array(OperationSchema).min(1),
  undoBoundary: z.enum(["scene", "clip", "batch"]),
  deadlineIso: z.iso.datetime(),
});

export type DelegationOperation = z.infer<typeof OperationSchema>;
export type DelegationTask = z.infer<typeof DelegationTaskSchema>;
export type UndoBoundary = DelegationTask["undoBoundary"];

/**
 * Deliverable 1 — the delegation schema as a full JSON Schema (draft
 * 2020-12). It is *derived* from the Zod schema above, so the published
 * schema and the schema the supervisor enforces can never drift apart.
 */
export const DELEGATION_TASK_JSON_SCHEMA = z.toJSONSchema(DelegationTaskSchema, {
  target: "draft-2020-12",
});

const DelegationResultSchema = z.object({
  delegationId: z.string().uuid(),
  agentId: z.string(),
  completed: z.boolean(),
  failed: z.number().int().nonnegative(),
  results: z.array(z.object({ ok: z.boolean(), result: z.unknown() })),
  undoMarkers: z.array(z.string()),
  elapsedMs: z.number().int().nonnegative(),
  mediaCacheMisses: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});

export type DelegationResult = z.infer<typeof DelegationResultSchema>;

/** The post-condition the supervisor asserts once a scene is assembled. */
export interface SceneAssignmentPostCondition {
  sceneNumber: number;
  singleWorker: boolean;
  workerId: string;
  clipOrderMatchesCallSheet: boolean;
}

/* ══ 3. The studio policy ═══════════════════════════════════════════════ */

/**
 * A role is the set of engine commands one agent may run. The supervisor
 * adjudicates every delegation against the role bound to its agent, and
 * refuses the whole scene when a single operation is out of bounds.
 */
export interface StudioRole {
  name: string;
  /** Command ids the role may run. A trailing dot matches a whole family. */
  allow: readonly string[];
  /** Command ids the role may never run, whatever else allows them. */
  deny: readonly string[];
  /** Whether the role may unwind history (`edit.undo`). */
  mayUndo: boolean;
}

export interface StudioPolicy {
  /** Every media path a worker may touch must live under this root. */
  sandboxRoot: string;
  roles: Readonly<Record<string, StudioRole>>;
  /** The role each worker agent is bound to. */
  agentRoles: Readonly<Record<WorkerId, string>>;
}

export type PolicyDecision =
  | { allow: true; role: string }
  | { allow: false; role: string; commandId: string; reason: string };

/**
 * The studio's default policy. `sequence-assembler` may cut and grade; it
 * may not destroy the project (`edit.clear`, `file.saveAs`) and it may not
 * re-time a scene it did not cut (`timeline.slip`, `timeline.slide`,
 * `timeline.roll` are reserved for the editor).
 */
export const DEFAULT_STUDIO_POLICY: StudioPolicy = {
  sandboxRoot: "/work/cathedral",
  roles: {
    "sequence-assembler": {
      name: "sequence-assembler",
      allow: [
        "timeline.place",
        "timeline.select",
        "timeline.move",
        "timeline.trim",
        "playhead.set",
        "sequence.applyVideoTransition",
        "sequence.applyAudioTransition",
        "effects.apply",
        "markers.add",
        "edit.undo",
      ],
      deny: [
        "edit.clear",
        "edit.duplicate",
        "timeline.razor",
        "timeline.slip",
        "timeline.slide",
        "timeline.roll",
        "sequence.deleteTracks",
        "file.save",
        "file.saveAs",
      ],
      mayUndo: true,
    },
  },
  agentRoles: {
    "worker-a": "sequence-assembler",
    "worker-b": "sequence-assembler",
    "worker-c": "sequence-assembler",
  },
};

/** Does `commandId` match an entry of `patterns` (a family ends with a dot)? */
function matchesPattern(commandId: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) =>
    pattern.endsWith(".") ? commandId.startsWith(pattern) : commandId === pattern,
  );
}

/** Adjudicate one command id against one role. */
export function authorize(role: StudioRole, commandId: string): { allow: boolean; reason: string } {
  if (matchesPattern(commandId, role.deny)) {
    return { allow: false, reason: `command "${commandId}" is denied to role "${role.name}"` };
  }
  if (commandId === "edit.undo" && !role.mayUndo) {
    return { allow: false, reason: `role "${role.name}" may not unwind history` };
  }
  if (!matchesPattern(commandId, role.allow)) {
    return { allow: false, reason: `command "${commandId}" is not permitted to role "${role.name}"` };
  }
  return { allow: true, reason: "" };
}

/** Adjudicate a whole delegation: the first offending operation wins. */
export function adjudicate(
  role: StudioRole,
  operations: readonly DelegationOperation[],
): PolicyDecision {
  for (const operation of operations) {
    const decision = authorize(role, operation.id);
    if (!decision.allow) {
      return { allow: false, role: role.name, commandId: operation.id, reason: decision.reason };
    }
  }
  return { allow: true, role: role.name };
}

/* ══ 4. The call sheet ══════════════════════════════════════════════════ */

export interface Shot {
  shotId: string;
  clipPath: string;
  /** SMPTE record timecode of the take, e.g. "00:00:03:12". */
  recordIn: string;
  /** SMPTE duration of the shot, e.g. "00:00:07:00". */
  duration: string;
}

export interface SceneSpec {
  number: number;
  slug: string;
  shots: Shot[];
  audioSync: { mode: "timecode" | "scratch" | "manual"; reference: string };
}

export interface CallSheet {
  runId: string;
  workerCount: number;
  /** The frame rate the timecodes are written in. Defaults to 24. */
  fps?: number;
  scenes: SceneSpec[];
}

/**
 * Deliverable 2 — the field-by-field mapping from `call-sheet.json` to a
 * `DelegationTask`:
 *
 *   call sheet                     delegation task
 *   ───────────────────────────    ─────────────────────────────────────
 *   runId                          runId
 *   scenes[].number                scene.number
 *   scenes[].slug                  scene.slug
 *   scenes[].shots[].clipPath      operations[].params.item of timeline.place
 *   scenes[].shots[].recordIn      the in frame of the first shot
 *   scenes[].shots[].duration       operations[].params.duration of timeline.place
 *   scenes[].audioSync.mode        whether audio transitions are emitted
 *   —                              delegationId, agentId, targetSequence,
 *                                  undoBoundary, deadlineIso
 *
 * The shot order of the call sheet is the order of the `timeline.place`
 * operations, and the shot's start time is derived from the first shot's
 * record timecode plus the durations of the shots before it — the record
 * timecode is the camera's, not the timeline's.
 */
export interface TaskBuilderOptions {
  /** The worker the scene is assigned to. */
  assign: (sceneNumber: number, index: number) => WorkerId;
  /** The sequence the worker assembles the scene into. */
  sequenceNameFor: (scene: SceneSpec) => string;
  /** The deadline stamped on every task of the run. */
  deadlineIso: string;
  /** The delegation id factory (injected so a CI run is reproducible). */
  delegationId: () => string;
  /** The frame rate of the call sheet's timecodes. */
  fps: number;
  /** How many frames a transition spans. */
  transitionFrames?: number;
}

export function tasksFromCallSheet(
  callSheet: CallSheet,
  options: TaskBuilderOptions,
): DelegationTask[] {
  const fps = options.fps;
  const transitionFrames = options.transitionFrames ?? 8;

  return callSheet.scenes.map((scene, index) => {
    const operations: DelegationOperation[] = [];
    const firstShot = scene.shots[0];
    if (!firstShot) throw new Error(`call-sheet: scene ${scene.number} has no shots`);

    const sceneStart = timecodeToSeconds(firstShot.recordIn, fps);

    // Park the playhead on the scene's in point.
    operations.push({ id: "playhead.set", params: { frame: Math.round(sceneStart * fps) } });

    // One `timeline.place` per shot, in call-sheet order. `insert: false`
    // keeps the order: a rippling insert would push the shot that was just
    // placed *in front of* the previous one.
    let cursor = sceneStart;
    scene.shots.forEach((shot) => {
      const duration = timecodeToSeconds(shot.duration, fps);
      operations.push({
        id: "timeline.place",
        params: {
          item: shot.clipPath,
          track: "V1",
          seconds: roundSeconds(cursor),
          duration: Math.round(duration * TICKS_PER_SECOND),
          insert: false,
          video: true,
          audio: true,
        },
      });
      cursor += duration;
    });

    // Transitions at the inter-shot boundaries. A dissolve is a picture
    // decision and always applies; a cross-fade of the sound is only safe
    // when the sound is locked to timecode, so scratch and manual sync
    // scenes get no audio transition.
    if (scene.audioSync.mode === "timecode") {
      let boundary = sceneStart;
      for (let shotIndex = 1; shotIndex < scene.shots.length; shotIndex += 1) {
        const previous = scene.shots[shotIndex - 1];
        if (!previous) continue;
        boundary += timecodeToSeconds(previous.duration, fps);
        const placeIndex = 1 + shotIndex; // operation index of the place step
        operations.push({ id: "playhead.set", params: { frame: Math.round(boundary * fps) } });
        operations.push({
          id: "sequence.applyVideoTransition",
          params: {
            clip: `$${placeIndex}.result.clips.0`,
            effect: "cross_dissolve",
            frames: transitionFrames,
            edge: "in",
          },
        });
        operations.push({
          id: "sequence.applyAudioTransition",
          params: {
            clip: `$${placeIndex}.result.clips.1`,
            effect: "constant_power",
            frames: transitionFrames,
          },
        });
      }
    }

    return {
      delegationId: options.delegationId(),
      runId: callSheet.runId,
      agentId: options.assign(scene.number, index),
      targetSequence: options.sequenceNameFor(scene),
      scene: { number: scene.number, slug: scene.slug },
      operations,
      undoBoundary: "batch",
      deadlineIso: options.deadlineIso,
    } satisfies DelegationTask;
  });
}

/**
 * The assignment strategy: least-loaded, per-scene-local.
 *
 * A scene is never split across workers. `timeline.slip`, `timeline.slide`
 * and `timeline.roll` mutate a clip's spatial neighbours on one track, and
 * the engine's history is a single process-wide stack: a cross-worker roll
 * would need a distributed lock the control channel does not provide. The
 * scene is therefore the unit of assignment, and the workers are balanced by
 * shot count. Ties break alphabetically so a CI run is reproducible.
 */
export function assignScenes(
  scenes: readonly SceneSpec[],
  workers: readonly WorkerId[],
): Map<number, WorkerId> {
  const load = new Map<WorkerId, number>(workers.map((worker) => [worker, 0]));
  const assignment = new Map<number, WorkerId>();

  for (const scene of scenes) {
    const chosen = [...workers].sort(
      (a, b) => (load.get(a) ?? 0) - (load.get(b) ?? 0) || a.localeCompare(b),
    )[0];
    if (!chosen) throw new Error("assignment: no worker available");
    assignment.set(scene.number, chosen);
    load.set(chosen, (load.get(chosen) ?? 0) + scene.shots.length);
  }

  return assignment;
}

/* ══ 5. The transports ══════════════════════════════════════════════════ */

export interface CommandOutcome {
  ok: boolean;
  result: unknown;
  error?: string | undefined;
}

export interface BatchStep {
  id: string;
  params: Record<string, unknown>;
}

export interface BatchOutcome {
  completed: number;
  failed: number;
  results: Array<{ ok: boolean; result?: unknown | undefined; error?: string | undefined }>;
}

/** The project tree, as `project_inspect` answers it. */
export interface ProjectNode {
  id?: number | undefined;
  name?: string | undefined;
  item?: number | undefined;
  type?: string | undefined;
  duration?: number | undefined;
  children?: ProjectNode[] | undefined;
}

const ProjectNodeSchema: z.ZodType<ProjectNode> = z.lazy(() =>
  z.object({
    id: z.number().optional(),
    name: z.string().optional(),
    item: z.number().optional(),
    type: z.string().optional(),
    duration: z.number().optional(),
    children: z.array(ProjectNodeSchema).optional(),
  }),
);

const ProjectTreeSchema = z.object({
  root: ProjectNodeSchema,
  activeSequence: z.number().nullish(),
  sourceItem: z.number().nullish(),
});

export type ProjectTree = z.infer<typeof ProjectTreeSchema>;

const SequenceClipSchema = z.object({
  clip: z.number(),
  name: z.string(),
  start: z.number(),
  duration: z.number(),
  item: z.number().nullish(),
  link: z.number().nullish(),
});

const SequenceTrackSchema = z.object({
  id: z.number(),
  name: z.string(),
  items: z.array(SequenceClipSchema),
  transitions: z.array(z.unknown()).default([]),
});

const SequenceSnapshotSchema = z.object({
  id: z.number(),
  name: z.string(),
  duration: z.number(),
  video: z.array(SequenceTrackSchema),
  audio: z.array(SequenceTrackSchema),
});

export type SequenceSnapshot = z.infer<typeof SequenceSnapshotSchema>;
export type SequenceTrack = z.infer<typeof SequenceTrackSchema>;
export type SequenceClip = z.infer<typeof SequenceClipSchema>;

const BatchOutcomeSchema = z.object({
  completed: z.number(),
  failed: z.number(),
  results: z.array(
    z.object({
      ok: z.boolean(),
      result: z.unknown().optional(),
      error: z.string().optional(),
    }),
  ),
});

const MediaImportSchema = z.object({
  items: z.array(z.number()),
  errors: z.array(z.string()).default([]),
});

/** Everything the supervisor needs from a FilmCraft session. */
export interface FilmCraftTransport {
  /** Run one engine command. */
  runCommand(id: string, params: Record<string, unknown>): Promise<CommandOutcome>;
  /** Run several engine commands in order, stopping at the first failure. */
  runBatch(steps: readonly BatchStep[]): Promise<BatchOutcome>;
  /** Import media by absolute path; answers the new project item ids. */
  importMedia(paths: readonly string[]): Promise<{ ok: boolean; items: number[]; error?: string }>;
  /** The project tree (bins, items, sequences). */
  projectTree(): Promise<ProjectTree>;
  /** The active sequence, with its tracks and clips. */
  activeSequence(): Promise<SequenceSnapshot>;
  /** Release the session. */
  close(): Promise<void>;
}

/* ── 5a. The MCP stdio transport ──────────────────────────────────────── */

interface JsonRpcResponse {
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

interface McpToolOutcome {
  ok: boolean;
  value: unknown;
  text: string;
}

export interface McpStdioOptions {
  /** The engine binary, e.g. "filmcraft-cli". */
  binary: string;
  /** Options for the `mcp` sub-command, e.g. ["--demo"] or ["--project", p]. */
  args?: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Per-request timeout. */
  timeoutMs?: number;
}

/**
 * A live FilmCraft MCP session over stdio.
 *
 * The MCP surface FilmCraft exposes is `command_run {id, params}`,
 * `command_batch {steps, stop_on_error}`, `command_list {filter,
 * enabled_only}`, `media_import {text}`, `project_inspect`,
 * `sequence_inspect` and `doc_inspect` — so every engine call goes through
 * `command_run` or `command_batch`, never through the CLI.
 */
export class McpStdioTransport implements FilmCraftTransport {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = "";
  private stderrText = "";
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (message: JsonRpcResponse) => void; reject: (error: Error) => void }
  >();

  private readonly timeoutMs: number;

  constructor(private readonly options: McpStdioOptions) {
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  /** Spawn the engine and complete the MCP handshake. */
  async start(): Promise<void> {
    if (this.child) throw new Error("mcp: already started");
    const child = spawn(this.options.binary, ["mcp", ...(this.options.args ?? [])], {
      cwd: this.options.cwd,
      env: { ...process.env, ...(this.options.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrText += chunk;
    });
    child.on("error", (error: Error) => this.failAll(error));
    child.on("exit", (code: number | null) =>
      this.failAll(new Error(`mcp: the engine exited with code ${String(code)}`)),
    );

    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "cathedral-supervisor", version: "1.0.0" },
    });
    this.notify("notifications/initialized", {});
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.length > 0) this.dispatch(line);
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  private dispatch(line: string): void {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return; // not a JSON-RPC frame (a stray banner); ignore it
    }
    if (typeof message.id !== "number") return; // a notification
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    waiter.resolve(message);
  }

  private failAll(error: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }

  private write(payload: Record<string, unknown>): void {
    const child = this.child;
    if (!child) throw new Error("mcp: session is not started");
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private request(method: string, params: unknown): Promise<JsonRpcResponse> {
    const id = this.nextId;
    this.nextId += 1;
    const promise = new Promise<JsonRpcResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`mcp: ${method} timed out after ${this.timeoutMs} ms`));
        }
      }, this.timeoutMs);
      timer.unref?.();
    });
    this.write({ jsonrpc: "2.0", id, method, params });
    return promise;
  }

  /** Call one MCP tool and normalise its answer. */
  private async callTool(name: string, args: Record<string, unknown>): Promise<McpToolOutcome> {
    const response = await this.request("tools/call", { name, arguments: args });
    if (response.error) {
      return { ok: false, value: null, text: response.error.message };
    }
    const result = (response.result ?? {}) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const text = (result.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("\n");
    if (result.isError) return { ok: false, value: null, text };
    let value: unknown = null;
    if (text.length > 0) {
      try {
        value = JSON.parse(text) as unknown;
      } catch {
        value = text;
      }
    }
    return { ok: true, value, text };
  }

  async runCommand(id: string, params: Record<string, unknown>): Promise<CommandOutcome> {
    const outcome = await this.callTool("command_run", { id, params });
    if (!outcome.ok) return { ok: false, result: null, error: outcome.text };
    return { ok: true, result: outcome.value };
  }

  async runBatch(steps: readonly BatchStep[]): Promise<BatchOutcome> {
    const outcome = await this.callTool("command_batch", {
      steps: steps.map((step) => ({ id: step.id, params: step.params })),
      stop_on_error: true,
    });
    if (!outcome.ok) {
      return {
        completed: 0,
        failed: steps.length,
        results: steps.map(() => ({ ok: false, error: outcome.text })),
      };
    }
    const parsed = BatchOutcomeSchema.safeParse(outcome.value);
    if (!parsed.success) {
      return {
        completed: 0,
        failed: steps.length,
        results: steps.map(() => ({ ok: false, error: "unexpected command_batch payload" })),
      };
    }
    return parsed.data;
  }

  async importMedia(
    paths: readonly string[],
  ): Promise<{ ok: boolean; items: number[]; error?: string }> {
    const outcome = await this.callTool("media_import", { text: paths.join("\n") });
    if (!outcome.ok) return { ok: false, items: [], error: outcome.text };
    const parsed = MediaImportSchema.safeParse(outcome.value);
    if (!parsed.success) {
      return { ok: false, items: [], error: "unexpected media_import payload" };
    }
    if (parsed.data.errors.length > 0) {
      return { ok: false, items: parsed.data.items, error: parsed.data.errors.join("; ") };
    }
    return { ok: true, items: parsed.data.items };
  }

  async projectTree(): Promise<ProjectTree> {
    const outcome = await this.callTool("project_inspect", {});
    const parsed = ProjectTreeSchema.safeParse(outcome.value);
    if (!parsed.success) {
      throw new Error(`filmcraft: unexpected project_inspect payload: ${outcome.text}`);
    }
    return parsed.data;
  }

  async activeSequence(): Promise<SequenceSnapshot> {
    const outcome = await this.callTool("sequence_inspect", {});
    const parsed = SequenceSnapshotSchema.safeParse(outcome.value);
    if (!parsed.success) {
      throw new Error(`filmcraft: unexpected sequence_inspect payload: ${outcome.text}`);
    }
    return parsed.data;
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child) return;
    child.removeAllListeners("exit");
    await new Promise<void>((resolveClose) => {
      child.once("close", () => resolveClose());
      child.stdin.end();
      child.kill("SIGTERM");
      setTimeout(resolveClose, 2000).unref?.();
    });
  }

  /** Whatever the engine wrote to stderr — the first thing to look at. */
  get stderr(): string {
    return this.stderrText;
  }
}

/* ── 5b. The loopback control transport ───────────────────────────────── */

export interface LoopbackOptions {
  host: string;
  port: number;
  /** The 64 hex character bearer token of the running app. */
  token: string;
  timeoutMs?: number;
}

/**
 * The JSON-lines control channel of a running FilmCraft app
 * (`filmcraft --control <PORT>`).
 *
 * The first frame of every connection must be the auth frame:
 *
 *     {"id": "auth", "method": "auth", "params": {"token": "<64 hex>"}}
 *
 * and the server closes the socket if it is missing. Every later request is
 * one JSON line `{"id": n, "method": m, "params": {...}}` and is answered by
 * `{"id": n, "ok": true, "result": {...}}` or `{"id": n, "ok": false,
 * "error": "..."}`. Engine commands travel as `engine.execute {command,
 * params}`; there is no batch on this channel, so a batch is a sequence of
 * single executions — which is also how the engine's history behaves.
 */
export class LoopbackControlTransport implements FilmCraftTransport {
  private socket: Socket | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (message: { ok: boolean; result?: unknown | undefined; error?: string | undefined }) => void; reject: (error: Error) => void }
  >();
  private readonly timeoutMs: number;

  constructor(private readonly options: LoopbackOptions) {
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  /** Connect and authenticate. */
  async connect(): Promise<void> {
    await new Promise<void>((resolveConnect, reject) => {
      const socket = new Socket();
      socket.setEncoding("utf8");
      socket.once("error", reject);
      socket.connect(this.options.port, this.options.host, () => {
        socket.removeListener("error", reject);
        this.socket = socket;
        socket.on("data", (chunk: string) => this.onData(chunk));
        socket.on("error", (error: Error) => this.failAll(error));
        resolveConnect();
      });
    });

    const auth = await this.request("auth", { token: this.options.token });
    if (!auth.ok) {
      await this.close();
      throw new Error(`control: authentication failed: ${auth.error ?? "unknown reason"}`);
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) {
        let message: { id?: number | string; ok?: boolean; result?: unknown; error?: string };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          newline = this.buffer.indexOf("\n");
          continue;
        }
        if (typeof message.id === "number") {
          const waiter = this.pending.get(message.id);
          if (waiter) {
            this.pending.delete(message.id);
            waiter.resolve({
              ok: message.ok === true,
              result: message.result,
              error: message.error,
            });
          }
        }
      }
      newline = this.buffer.indexOf("\n");
    }
  }

  private failAll(error: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }

  private request(
    method: string,
    params: unknown,
  ): Promise<{ ok: boolean; result?: unknown | undefined; error?: string | undefined }> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error("control: session is not connected"));
    const id = this.nextId;
    this.nextId += 1;
    const promise = new Promise<{ ok: boolean; result?: unknown | undefined; error?: string | undefined }>(
      (resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        const timer = setTimeout(() => {
          if (this.pending.delete(id)) {
            reject(new Error(`control: ${method} timed out after ${this.timeoutMs} ms`));
          }
        }, this.timeoutMs);
        timer.unref?.();
      },
    );
    socket.write(`${JSON.stringify({ id, method, params })}\n`);
    return promise;
  }

  private async engineExecute(
    command: string,
    params: Record<string, unknown>,
  ): Promise<{ ok: boolean; result?: unknown | undefined; error?: string | undefined }> {
    return this.request("engine.execute", { command, params });
  }

  async runCommand(id: string, params: Record<string, unknown>): Promise<CommandOutcome> {
    const reply = await this.engineExecute(id, params);
    if (!reply.ok) return { ok: false, result: null, error: reply.error ?? "command failed" };
    return { ok: true, result: reply.result ?? null };
  }

  async runBatch(steps: readonly BatchStep[]): Promise<BatchOutcome> {
    const results: Array<{ ok: boolean; result?: unknown | undefined; error?: string | undefined }> = [];
    let completed = 0;
    let failed = 0;
    for (const step of steps) {
      const outcome = await this.runCommand(step.id, step.params);
      results.push({ ok: outcome.ok, result: outcome.result, error: outcome.error });
      if (outcome.ok) completed += 1;
      else {
        failed += 1;
        break; // stop_on_error
      }
    }
    return { completed, failed, results };
  }

  async importMedia(
    paths: readonly string[],
  ): Promise<{ ok: boolean; items: number[]; error?: string }> {
    const outcome = await this.runCommand("file.import", { paths: [...paths] });
    if (!outcome.ok) {
      return { ok: false, items: [], error: outcome.error ?? "file.import failed" };
    }
    const parsed = MediaImportSchema.safeParse(outcome.result);
    if (!parsed.success) {
      return { ok: false, items: [], error: "unexpected file.import payload" };
    }
    if (parsed.data.errors.length > 0) {
      return { ok: false, items: parsed.data.items, error: parsed.data.errors.join("; ") };
    }
    return { ok: true, items: parsed.data.items };
  }

  async projectTree(): Promise<ProjectTree> {
    const outcome = await this.runCommand("project.inspect", {});
    const parsed = ProjectTreeSchema.safeParse(outcome.result);
    if (!parsed.success) throw new Error("filmcraft: unexpected project.inspect payload");
    return parsed.data;
  }

  async activeSequence(): Promise<SequenceSnapshot> {
    const outcome = await this.runCommand("sequence.inspect", {});
    const parsed = SequenceSnapshotSchema.safeParse(outcome.result);
    if (!parsed.success) throw new Error("filmcraft: unexpected sequence.inspect payload");
    return parsed.data;
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    socket?.end();
    socket?.destroy();
  }
}

/* ══ 6. The worker ══════════════════════════════════════════════════════ */

export interface WorkerContext {
  transport: FilmCraftTransport;
  policy: StudioPolicy;
  roleName: string;
  /** The clock the worker reads for deadlines and elapsed time. */
  clock: () => number;
}

/** One operation of a delegation, with the outcome the engine gave it. */
export interface StepOutcome {
  ok: boolean;
  result: unknown;
}

/** `$N`, `$N.result.a.b` — a reference to an earlier operation's result. */
const REFERENCE_PATTERN = /^\$(\d+)(?:\.result)?((?:\.[A-Za-z0-9_-]+)*)$/;

/** Does this parameter tree mention an earlier operation's result? */
export function containsReference(value: unknown): boolean {
  if (typeof value === "string") return REFERENCE_PATTERN.test(value);
  if (Array.isArray(value)) return value.some(containsReference);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(containsReference);
  }
  return false;
}

/** Walk a path inside an earlier operation's result. */
export function resolveReference(
  reference: string,
  results: ReadonlyArray<StepOutcome | undefined>,
): unknown {
  const match = REFERENCE_PATTERN.exec(reference);
  if (!match) return undefined;
  const step = results[Number(match[1])];
  if (!step) return undefined;
  let cursor: unknown = step.result;
  const path = (match[2] ?? "").split(".").filter((segment) => segment.length > 0);
  for (const segment of path) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    if (Array.isArray(cursor)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      cursor = cursor[index];
    } else {
      cursor = (cursor as Record<string, unknown>)[segment];
    }
  }
  return cursor;
}

/** Replace every `$N.path` reference in a parameter tree with its value. */
export function resolveParams(
  params: Record<string, unknown>,
  results: ReadonlyArray<StepOutcome | undefined>,
): { params: Record<string, unknown>; missing: string | null } {
  const missing: string[] = [];

  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      if (!REFERENCE_PATTERN.test(value)) return value;
      const resolved = resolveReference(value, results);
      if (resolved === undefined) {
        missing.push(value);
        return value;
      }
      return resolved;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        out[key] = walk(entry);
      }
      return out;
    }
    return value;
  };

  return { params: walk(params) as Record<string, unknown>, missing: missing[0] ?? null };
}

/**
 * One unit of execution: a `command_batch` (or a single `command_run`).
 */
export interface ExecutionWave {
  kind: "batch" | "single";
  /** The operations of the wave, with their index in the task. */
  operations: Array<{ operation: DelegationOperation; index: number }>;
}

/**
 * Plan the execution of a delegation.
 *
 * `undoBoundary: "batch"` puts the whole scene in one `command_batch` — but
 * a step whose parameters reference an earlier result cannot be resolved
 * before that result exists, so the wave is split there and the reference is
 * resolved by the worker before the second batch is sent. `"scene"` behaves
 * the same way here, because one delegation covers exactly one scene.
 * `"clip"` runs every operation on its own with `command_run`.
 */
export function planWaves(
  operations: readonly DelegationOperation[],
  boundary: UndoBoundary,
): ExecutionWave[] {
  if (boundary === "clip") {
    return operations.map((operation, index) => ({
      kind: "single" as const,
      operations: [{ operation, index }],
    }));
  }

  const waves: ExecutionWave[] = [];
  let current: Array<{ operation: DelegationOperation; index: number }> = [];
  const flush = (): void => {
    if (current.length > 0) {
      waves.push({ kind: "batch", operations: current });
      current = [];
    }
  };

  operations.forEach((operation, index) => {
    if (containsReference(operation.params)) flush();
    current.push({ operation, index });
  });
  flush();
  return waves;
}

/** Flatten the project tree into the media catalogue, by media name. */
export function collectProjectItems(
  tree: ProjectTree,
): Map<string, { item: number; type: string }> {
  const catalogue = new Map<string, { item: number; type: string }>();

  const walk = (node: ProjectNode): void => {
    for (const child of node.children ?? []) {
      if (typeof child.item === "number" && typeof child.name === "string") {
        if (!catalogue.has(child.name)) {
          catalogue.set(child.name, { item: child.item, type: child.type ?? "Unknown" });
        }
      }
      walk(child);
    }
  };

  walk(tree.root);
  return catalogue;
}

/** Is `candidate` inside the studio sandbox? */
export function isInsideSandbox(candidate: string, sandboxRoot: string): boolean {
  const root = resolve(sandboxRoot);
  const target = resolve(candidate);
  return target === root || target.startsWith(root + sep);
}

/** How a `timeline.place` operation was resolved to a project item id. */
interface MediaResolution {
  item?: number;
  error?: string;
  /** True when the media had to be imported — a media cache miss. */
  recovered: boolean;
}

/**
 * Resolve every `timeline.place` operation to a project item id.
 *
 * The delegation speaks in media *paths*; the engine speaks in item *ids*.
 * A path whose media is already pooled is a cache hit; a path that is not
 * pooled is a cache miss and is recovered with `media_import`, which reads
 * absolute paths under the studio sandbox.
 */
async function resolveMedia(
  task: DelegationTask,
  context: WorkerContext,
): Promise<Map<number, MediaResolution>> {
  const catalogue = collectProjectItems(await context.transport.projectTree());
  const resolutions = new Map<number, MediaResolution>();

  for (const [index, operation] of task.operations.entries()) {
    if (operation.id !== "timeline.place") continue;

    const raw = operation.params["item"];
    if (typeof raw !== "string") {
      resolutions.set(index, { error: "timeline.place: item must be a media path", recovered: false });
      continue;
    }
    if (!isAbsolute(raw)) {
      resolutions.set(index, { error: `timeline.place: "${raw}" is not an absolute path`, recovered: false });
      continue;
    }
    if (!isInsideSandbox(raw, context.policy.sandboxRoot)) {
      resolutions.set(index, {
        error: `timeline.place: "${raw}" is outside the studio sandbox "${context.policy.sandboxRoot}"`,
        recovered: false,
      });
      continue;
    }

    const pooled = catalogue.get(basename(raw));
    if (pooled) {
      resolutions.set(index, { item: pooled.item, recovered: false });
      continue;
    }

    const imported = await context.transport.importMedia([raw]);
    const item = imported.items[0];
    if (!imported.ok || item === undefined) {
      resolutions.set(index, {
        error: `media_import failed for "${raw}": ${imported.error ?? "unknown error"}`,
        recovered: false,
      });
      continue;
    }
    catalogue.set(basename(raw), { item, type: "Imported" });
    resolutions.set(index, { item, recovered: true });
  }

  return resolutions;
}

/**
 * Run one delegation task inside a worker session.
 *
 * The worker does not trust the task: it re-validates the schema, resolves
 * every media path against the studio sandbox, and reports the operations
 * the engine refused.
 */
export async function runWorker(
  task: DelegationTask,
  context: WorkerContext,
): Promise<DelegationResult> {
  const startedAt = context.clock();
  const parsed = DelegationTaskSchema.safeParse(task);
  if (!parsed.success) {
    throw new Error(`worker: delegation ${task.delegationId} failed schema validation`);
  }

  const role = context.policy.roles[context.roleName];
  if (!role) throw new Error(`worker: unknown role "${context.roleName}"`);

  const resolutions = await resolveMedia(task, context);
  const waves = planWaves(task.operations, task.undoBoundary);

  const outcomes: Array<StepOutcome | undefined> = new Array(task.operations.length).fill(undefined);
  const undoMarkers: string[] = [];
  let failed = 0;
  let skipped = 0;
  let mediaCacheMisses = 0;

  for (const wave of waves) {
    if (context.clock() > Date.parse(task.deadlineIso)) {
      failed += 1;
      break; // the deadline passed: stop and let the supervisor roll back
    }

    const steps: BatchStep[] = [];
    const stepIndexes: number[] = [];

    for (const entry of wave.operations) {
      const resolution = resolutions.get(entry.index);
      let itemId: number | undefined;
      if (entry.operation.id === "timeline.place") {
        if (!resolution || resolution.error || resolution.item === undefined) {
          outcomes[entry.index] = { ok: false, result: resolution?.error ?? "unresolved operation" };
          failed += 1;
          continue;
        }
        if (resolution.recovered) mediaCacheMisses += 1;
        itemId = resolution.item;
      }

      // The delegation names the media by path; the engine wants the id.
      const params: Record<string, unknown> = { ...entry.operation.params };
      if (itemId !== undefined) params["item"] = itemId;

      const resolved = resolveParams(params, outcomes);
      if (resolved.missing !== null) {
        // A still image has no audio clip to cross-fade, and a clip that was
        // never placed has no id: the step is skipped, not failed.
        outcomes[entry.index] = {
          ok: false,
          result: `unresolved reference "${resolved.missing}"`,
        };
        skipped += 1;
        continue;
      }
      steps.push({ id: entry.operation.id, params: resolved.params });
      stepIndexes.push(entry.index);
    }

    if (steps.length === 0) continue;

    let stepResults: Array<{ ok: boolean; result?: unknown | undefined; error?: string | undefined }>;
    if (wave.kind === "batch") {
      const outcome = await context.transport.runBatch(steps);
      stepResults = outcome.results;
    } else {
      const outcome = await context.transport.runCommand(
        steps[0]?.id ?? "",
        steps[0]?.params ?? {},
      );
      stepResults = [{ ok: outcome.ok, result: outcome.result, error: outcome.error }];
    }

    stepResults.forEach((stepResult, position) => {
      const index = stepIndexes[position];
      if (index === undefined) return;
      if (stepResult.ok) {
        outcomes[index] = { ok: true, result: stepResult.result ?? null };
        const commandId = steps[position]?.id ?? "";
        if (UNDOABLE_COMMANDS.has(commandId)) undoMarkers.push(commandId);
      } else {
        outcomes[index] = { ok: false, result: stepResult.error ?? "command failed" };
        failed += 1;
      }
    });
  }

  const result: DelegationResult = {
    delegationId: task.delegationId,
    agentId: task.agentId,
    completed: failed === 0,
    failed,
    results: task.operations.map((_, index) => {
      const outcome = outcomes[index];
      return { ok: outcome?.ok ?? false, result: outcome?.result ?? null };
    }),
    undoMarkers,
    elapsedMs: Math.max(0, context.clock() - startedAt),
    mediaCacheMisses,
    skipped,
  };

  return DelegationResultSchema.parse(result);
}

/* ══ 7. Post-conditions and rollback ════════════════════════════════════ */

export interface SceneOrderReport {
  ok: boolean;
  expected: string[];
  actual: string[];
  mismatches: string[];
}

/**
 * Deliverable 3 — the post-condition checker.
 *
 * After the scene is assembled the supervisor re-inspects the sequence
 * (`sequence_inspect`) and compares the clips of the video track, in
 * timeline order, with the order the call sheet dictated. The comparison is
 * made on the media name, because that is what the engine's sequence
 * snapshot exposes.
 */
export async function assertSceneOrder(
  transport: FilmCraftTransport,
  expected: readonly string[],
): Promise<SceneOrderReport> {
  const snapshot = await transport.activeSequence();
  const clips = snapshot.video
    .flatMap((track) => track.items)
    .sort((a, b) => a.start - b.start);
  const actual = clips.map((clip) => clip.name);

  const mismatches: string[] = [];
  for (let index = 0; index < expected.length; index += 1) {
    const wanted = expected[index];
    const got = actual[index];
    if (wanted !== got) {
      mismatches.push(`shot ${index}: expected ${String(wanted)}, got ${String(got)}`);
    }
  }
  if (actual.length > expected.length) {
    mismatches.push(`the sequence holds ${actual.length} clips, the call sheet ${expected.length}`);
  }

  return { ok: mismatches.length === 0, expected: [...expected], actual, mismatches };
}

/**
 * Deliverable 4 — the failure semantics.
 *
 * A failure anywhere in a scene rolls the *whole scene* back: the
 * supervisor issues one `edit.undo` per undo marker, newest first, and
 * leaves the partial clips in place only when the engine refuses to unwind
 * them. A scene is never salvaged half-assembled.
 */
export async function rollbackScene(
  transport: FilmCraftTransport,
  markers: readonly string[],
): Promise<number> {
  let undone = 0;
  for (const _marker of [...markers].reverse()) {
    const outcome = await transport.runCommand("edit.undo", {});
    if (!outcome.ok) break;
    undone += 1;
  }
  return undone;
}

/* ══ 8. The signed journal ══════════════════════════════════════════════ */

export interface JournalEntry {
  seq: number;
  prev: string;
  kind: string;
  mac: string;
  [key: string]: unknown;
}

/**
 * The compliance trail: one JSONL per run, every line signed with
 * HMAC-SHA256 over the line's body and chained to the previous line's
 * signature. An auditor can therefore prove both the integrity of every
 * record and the order the records were written in.
 */
export class DelegationJournal {
  private seq = 0;
  private prev = "0".repeat(64);

  constructor(
    private readonly path: string,
    private readonly key: Buffer,
  ) {
    mkdirSync(dirname(path), { recursive: true });
    // The trail belongs to one run: a new run starts a new chain.
    writeFileSync(path, "");
  }

  /** Append one signed record. */
  append(kind: string, record: Record<string, unknown> = {}): JournalEntry {
    const body = { seq: this.seq, prev: this.prev, ...record, kind };
    const mac = createHmac("sha256", this.key).update(JSON.stringify(body)).digest("hex");
    const entry: JournalEntry = { ...body, mac };
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
    this.seq += 1;
    this.prev = mac;
    return entry;
  }

  /** Read the trail back. */
  static read(path: string): JournalEntry[] {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as JournalEntry);
  }

  /** Verify every signature and every link of the chain. */
  static verify(
    path: string,
    key: Buffer,
  ): { ok: boolean; entries: number; brokenAt: number | null } {
    const entries = DelegationJournal.read(path);
    let prev = "0".repeat(64);
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!entry) break;
      const { mac, ...body } = entry;
      const expected = createHmac("sha256", key).update(JSON.stringify(body)).digest("hex");
      if (expected !== mac || body.prev !== prev) {
        return { ok: false, entries: index, brokenAt: index };
      }
      prev = mac;
    }
    return { ok: true, entries: entries.length, brokenAt: null };
  }
}

/* ══ 9. The supervisor ══════════════════════════════════════════════════ */

export type SceneStatus = "assembled" | "failed" | "refused" | "rejected";

export interface SceneVerdict {
  sceneNumber: number;
  slug: string;
  workerId: WorkerId;
  status: SceneStatus;
  delegationId: string | null;
  completed: boolean;
  failedOperations: number;
  skippedOperations: number;
  mediaCacheMisses: number;
  undoMarkers: string[];
  clipOrderMatchesCallSheet: boolean;
  mismatches: string[];
}

export interface RunManifest {
  runId: string;
  startedIso: string;
  finishedIso: string;
  workers: WorkerId[];
  scenes: SceneVerdict[];
  postConditions: SceneAssignmentPostCondition[];
  journal: { path: string; entries: number; verified: boolean };
  ok: boolean;
}

export interface SupervisorOptions {
  policy: StudioPolicy;
  /** One FilmCraft session per worker agent. */
  transports: Record<WorkerId, FilmCraftTransport>;
  /** The directory that holds `<runId>/delegations.jsonl` and the manifest. */
  runsRoot: string;
  /** The shared HMAC key from the vault. */
  hmacKey: Buffer;
  /** The clock, injected so a CI run is reproducible. */
  clock?: () => number;
  /** The delegation id factory, injected so a CI run is reproducible. */
  idFactory?: () => string;
  /** The frame rate of the call sheet's timecodes. */
  fps?: number;
  /** How long a worker may take on a scene. */
  deadlineMs?: number;
  /** The name of the sequence a scene is assembled into. */
  sequenceNameFor?: (scene: SceneSpec) => string;
}

/** The media names a task expects to find on the timeline, in order. */
export function expectedMediaNames(task: DelegationTask): string[] {
  return task.operations
    .filter((operation) => operation.id === "timeline.place")
    .map((operation) => {
      const item = operation.params["item"];
      return typeof item === "string" ? basename(item) : "";
    });
}

/**
 * Read the few fields of an untrusted task that the verdict needs. The
 * supervisor never *trusts* these values — the schema decides.
 */
export function peekTask(task: unknown): {
  delegationId: string | null;
  agentId: WorkerId;
  sceneNumber: number;
  slug: string;
} {
  const record = (
    typeof task === "object" && task !== null ? task : {}
  ) as Record<string, unknown>;
  const scene = (
    typeof record["scene"] === "object" && record["scene"] !== null ? record["scene"] : {}
  ) as Record<string, unknown>;
  const agentId = WORKER_IDS.includes(record["agentId"] as WorkerId)
    ? (record["agentId"] as WorkerId)
    : "worker-a";
  return {
    delegationId: typeof record["delegationId"] === "string" ? record["delegationId"] : null,
    agentId,
    sceneNumber: typeof scene["number"] === "number" ? scene["number"] : -1,
    slug: typeof scene["slug"] === "string" ? scene["slug"] : "",
  };
}

/**
 * The Supervisor Node.
 *
 * It parses the call sheet, assigns every scene to exactly one worker,
 * adjudicates each delegation against the studio policy, drives the worker
 * sessions, checks the post-conditions and writes the signed trail.
 */
export class Supervisor {
  private readonly clock: () => number;
  private readonly idFactory: () => string;
  private readonly fps: number;
  private readonly deadlineMs: number;
  private journal: DelegationJournal | null = null;

  constructor(private readonly options: SupervisorOptions) {
    this.clock = options.clock ?? (() => Date.now());
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.fps = options.fps ?? 24;
    this.deadlineMs = options.deadlineMs ?? 10 * 60_000;
  }

  private sequenceNameFor(scene: SceneSpec): string {
    const custom = this.options.sequenceNameFor?.(scene);
    return custom ?? `CATHEDRAL-S${String(scene.number).padStart(3, "0")}`;
  }

  private transportFor(agentId: WorkerId): FilmCraftTransport {
    const transport = this.options.transports[agentId];
    if (!transport) throw new Error(`supervisor: no session for agent "${agentId}"`);
    return transport;
  }

  private roleFor(agentId: WorkerId): StudioRole {
    const roleName = this.options.policy.agentRoles[agentId];
    const role = roleName ? this.options.policy.roles[roleName] : undefined;
    if (!role) throw new Error(`supervisor: no role bound to agent "${agentId}"`);
    return role;
  }

  /** Make sure the task's target sequence exists in the worker's session. */
  private async ensureTargetSequence(
    transport: FilmCraftTransport,
    name: string,
  ): Promise<void> {
    const tree = await transport.projectTree();
    const exists = collectProjectItems(tree).get(name);
    if (exists) return;
    const created = await transport.runCommand("file.newSequence", { name, fps: this.fps });
    if (!created.ok) {
      throw new Error(`supervisor: cannot create sequence "${name}": ${created.error ?? "unknown"}`);
    }
  }

  /**
   * Adjudicate, execute and verify one delegation.
   *
   * The task arrives as untrusted input: the supervisor reads the few
   * fields it needs for the verdict, then validates the whole thing against
   * the schema before anything reaches a worker.
   *
   * The three ways out of a delegation are deliberate: a task that does not
   * satisfy the schema is *rejected*, a task that asks for a command the
   * role may not run is *refused*, and a task the engine cannot finish is
   * *failed* (and rolled back).
   */
  async dispatch(task: unknown): Promise<SceneVerdict> {
    const journal = this.journal;
    const peeked = peekTask(task);
    const sceneNumber = peeked.sceneNumber;
    const slug = peeked.slug;
    const workerId = peeked.agentId;

    const base: SceneVerdict = {
      sceneNumber,
      slug,
      workerId,
      status: "failed",
      delegationId: peeked.delegationId,
      completed: false,
      failedOperations: 0,
      skippedOperations: 0,
      mediaCacheMisses: 0,
      undoMarkers: [],
      clipOrderMatchesCallSheet: false,
      mismatches: [],
    };

    const parsed = DelegationTaskSchema.safeParse(task);
    if (!parsed.success) {
      journal?.append("task.rejected", {
        delegationId: peeked.delegationId,
        agentId: workerId,
        sceneNumber,
        reason: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
      });
      return { ...base, status: "rejected" };
    }

    const task0 = parsed.data;
    const role = this.roleFor(task0.agentId);
    const decision = adjudicate(role, task0.operations);
    if (!decision.allow) {
      journal?.append("policy.refused", {
        delegationId: task0.delegationId,
        agentId: task0.agentId,
        sceneNumber,
        commandId: decision.commandId,
        role: decision.role,
        reason: decision.reason,
      });
      return { ...base, status: "refused", mismatches: [decision.reason] };
    }

    const transport = this.transportFor(task0.agentId);
    await this.ensureTargetSequence(transport, task0.targetSequence);

    journal?.append("task.dispatched", {
      delegationId: task0.delegationId,
      agentId: task0.agentId,
      sceneNumber,
      targetSequence: task0.targetSequence,
      undoBoundary: task0.undoBoundary,
      operations: task0.operations.map((operation) => operation.id),
    });

    const result = await runWorker(task0, {
      transport,
      policy: this.options.policy,
      roleName: role.name,
      clock: this.clock,
    });

    journal?.append("worker.result", {
      delegationId: task0.delegationId,
      agentId: task0.agentId,
      sceneNumber,
      completed: result.completed,
      failed: result.failed,
      skipped: result.skipped,
      mediaCacheMisses: result.mediaCacheMisses,
      undoMarkers: result.undoMarkers,
      operations: task0.operations.map((operation, index) => ({
        id: operation.id,
        ok: result.results[index]?.ok ?? false,
      })),
      failures: task0.operations
        .map((operation, index) => ({
          index,
          id: operation.id,
          error: result.results[index]?.ok === true ? "" : String(result.results[index]?.result ?? ""),
        }))
        .filter((failure) => failure.error !== ""),
    });

    if (!result.completed) {
      const undone = await rollbackScene(transport, result.undoMarkers);
      journal?.append("scene.rolledback", {
        delegationId: task0.delegationId,
        agentId: task0.agentId,
        sceneNumber,
        markers: result.undoMarkers,
        undone,
      });
      return {
        ...base,
        status: "failed",
        completed: false,
        failedOperations: result.failed,
        skippedOperations: result.skipped,
        mediaCacheMisses: result.mediaCacheMisses,
        undoMarkers: result.undoMarkers,
      };
    }

    const report = await assertSceneOrder(transport, expectedMediaNames(task0));
    journal?.append("scene.verified", {
      delegationId: task0.delegationId,
      agentId: task0.agentId,
      sceneNumber,
      clipOrderMatchesCallSheet: report.ok,
      actual: report.actual,
      mismatches: report.mismatches,
    });

    return {
      ...base,
      status: report.ok ? "assembled" : "failed",
      completed: true,
      failedOperations: result.failed,
      skippedOperations: result.skipped,
      mediaCacheMisses: result.mediaCacheMisses,
      undoMarkers: result.undoMarkers,
      clipOrderMatchesCallSheet: report.ok,
      mismatches: report.mismatches,
    };
  }

  /** Run a whole call sheet. */
  async run(callSheet: CallSheet): Promise<RunManifest> {
    const startedIso = new Date(this.clock()).toISOString();
    const runDir = join(this.options.runsRoot, callSheet.runId);
    const journalPath = join(runDir, "delegations.jsonl");
    const journal = new DelegationJournal(journalPath, this.options.hmacKey);
    this.journal = journal;

    const workers = WORKER_IDS.slice(0, Math.max(1, Math.min(callSheet.workerCount, WORKER_IDS.length)));
    const assignment = assignScenes(callSheet.scenes, workers);
    const deadlineIso = new Date(this.clock() + this.deadlineMs).toISOString();

    journal.append("run.started", {
      runId: callSheet.runId,
      startedIso,
      workers,
      scenes: callSheet.scenes.length,
      fps: callSheet.fps ?? this.fps,
    });

    const verdicts: SceneVerdict[] = [];
    const postConditions: SceneAssignmentPostCondition[] = [];

    const tasks = tasksFromCallSheet(callSheet, {
      assign: (sceneNumber) => assignment.get(sceneNumber) ?? workers[0] ?? "worker-a",
      sequenceNameFor: (spec) => this.sequenceNameFor(spec),
      deadlineIso,
      delegationId: this.idFactory,
      fps: callSheet.fps ?? this.fps,
    });

    for (const [index, scene] of callSheet.scenes.entries()) {
      const task = tasks[index];
      if (!task) continue;

      journal.append("task.built", {
        delegationId: task.delegationId,
        agentId: task.agentId,
        sceneNumber: scene.number,
        slug: scene.slug,
        targetSequence: task.targetSequence,
        undoBoundary: task.undoBoundary,
        operations: task.operations.map((operation) => operation.id),
        deadlineIso,
      });

      const verdict = await this.dispatch(task);
      verdicts.push(verdict);

      // The locality invariant: every shot of the scene was cut by one
      // worker, so the scene's slip/slide/roll edits stay local.
      const sceneWorkers = new Set(
        tasks.filter((entry) => entry.scene.number === scene.number).map((entry) => entry.agentId),
      );

      postConditions.push({
        sceneNumber: scene.number,
        singleWorker: sceneWorkers.size === 1,
        workerId: verdict.workerId,
        clipOrderMatchesCallSheet: verdict.clipOrderMatchesCallSheet,
      });
    }

    const finishedIso = new Date(this.clock()).toISOString();
    const ok = verdicts.every((verdict) => verdict.status === "assembled");

    journal.append("run.finished", {
      runId: callSheet.runId,
      finishedIso,
      ok,
      scenes: verdicts.map((verdict) => ({
        sceneNumber: verdict.sceneNumber,
        workerId: verdict.workerId,
        status: verdict.status,
      })),
    });

    // The trail is verified the way the compliance auditor will verify it:
    // every signature, every link.
    const verification = DelegationJournal.verify(journalPath, this.options.hmacKey);

    const manifest: RunManifest = {
      runId: callSheet.runId,
      startedIso,
      finishedIso,
      workers,
      scenes: verdicts,
      postConditions,
      journal: { path: journalPath, entries: verification.entries, verified: verification.ok },
      ok,
    };

    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    return manifest;
  }
}
