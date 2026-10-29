/**
 * @file filmcraft-threeway-ducking.ts
 *
 * Hello-world agentic pipeline for Chapter 13:
 *   three-way colour wheels (shadows / midtones / highlights)
 *   + sidechain-style audio ducking
 *   + LUFS / true-peak loudness governance.
 *
 * The worker talks to `filmcraft-cli mcp` over stdio using the official MCP
 * meta-tools (`command_run`, `command_batch`, `doc_inspect`, `render_frame`).
 * Every mutation is an undoable engine command from the FilmCraft registry.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/* ================================================================== *
 * 1. WIRE TYPES
 * ================================================================== */

/** A single engine command invocation, exactly as `command_batch` expects it. */
export interface FilmCraftStep {
  /** Engine command id, e.g. `effects.setParam`, `essentialSound.generateDucking`. */
  id: string;
  /** Command parameters — see `command_list` for the authoritative `params` doc. */
  params?: Record<string, unknown>;
}

/** Outcome of one step inside a `command_batch` envelope. */
interface BatchStepResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** The `command_batch` reply envelope. */
interface BatchEnvelope {
  completed: number;
  failed: number;
  results: BatchStepResult[];
}

/** A node in the project-panel tree returned by `project_inspect` / `doc_inspect`. */
interface ProjectItem {
  /** A media item is identified by `item`; a bin or a folder by `id`. */
  id?: number;
  item?: number;
  name: string;
  /** "Composition" | "Footage" | "Solid" | "Folder" */
  type?: string;
  children?: ProjectItem[];
}

/** A content block in an MCP tool reply. */
interface McpContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

interface McpToolResult {
  content: McpContentBlock[];
  isError?: boolean;
}

/** FilmCraft's fixed timebase: 254 016 000 000 ticks == 1 second. */
export const TICKS_PER_SECOND = 254_016_000_000n;

/** Convert seconds to FilmCraft engine ticks (bigint → number at the boundary). */
export function ticks(seconds: number): number {
  const whole = BigInt(Math.trunc(seconds));
  const frac = seconds - Math.trunc(seconds);
  const fracTicks = BigInt(Math.round(frac * Number(TICKS_PER_SECOND)));
  return Number(whole * TICKS_PER_SECOND + fracTicks);
}

/** The loudness contract a studio standardises on for a given delivery target. */
export interface LoudnessTargets {
  /** Integrated loudness for spoken word, in LUFS (e.g. -16 for web dialogue). */
  dialogueLufs: number;
  /** Integrated loudness for the music bed *before* ducking, in LUFS. */
  musicBedLufs: number;
  /** True-peak ceiling in dBTP the delivery must respect. */
  truePeakDbtp: number;
  /** How far the music drops under dialogue, in dB (negative). */
  duckDepthDb: number;
  /** Integrated loudness of the finished programme, in LUFS (e.g. -14 for web). */
  deliveryLufs: number;
}

/* ================================================================== *
 * 2. THE MCP CLIENT WRAPPER
 * ================================================================== */

/**
 * Thin, strongly-typed wrapper over `filmcraft-cli mcp`.
 *
 * The MCP server exposes a *lean* set of meta-tools rather than 500+ individual
 * tools, so this class only needs to know five of them:
 *   command_run, command_batch, doc_inspect, project_inspect, render_frame.
 */
export class FilmCraftMCP {
  private readonly client: Client;
  private readonly transport: StdioClientTransport;

  /**
   * @param projectRoot Filesystem sandbox root. Both the read root and the write
   *                    root are pinned here so the agent can never escape the job
   *                    directory — a hard requirement for multi-tenant SaaS workers.
   */
  constructor(readonly projectRoot: string) {
    this.transport = new StdioClientTransport({
      command: "filmcraft-cli",
      args: [
        "mcp",
        "--automation-read-root", projectRoot,
        "--automation-write-root", projectRoot,
      ],
    });

    this.client = new Client(
      { name: "threeway-ducking-agent", version: "1.0.0" },
      { capabilities: {} },
    );
  }

  async connect(): Promise<void> {
    await this.client.connect(this.transport);
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  /**
   * Low-level MCP call. Parses the first text block as JSON when it is JSON,
   * and throws when the server flags `isError`.
   */
  private async call(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const raw = (await this.client.callTool({
      name: tool,
      arguments: args,
    })) as unknown as McpToolResult;

    const text = raw.content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n");

    if (raw.isError) {
      throw new Error(`[${tool}] ${text || "unknown MCP error"}`);
    }

    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }

  /** Run exactly one engine command. */
  async run(id: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.call("command_run", params === undefined ? { id } : { id, params });
  }

  /**
   * Run several engine commands in order.
   * FilmCraft's `command_batch` is *not* a transaction: earlier successful steps
   * stay applied. `stop_on_error` defaults to true, so the first failure halts
   * the run and we can reconcile from the returned `completed` index.
   */
  async batch(steps: FilmCraftStep[], stopOnError = true): Promise<BatchEnvelope> {
    return (await this.call("command_batch", {
      steps,
      stop_on_error: stopOnError,
    })) as BatchEnvelope;
  }

  /** Project tree + active sequence, in one round trip. */
  async inspect(): Promise<Record<string, unknown>> {
    return (await this.call("doc_inspect", {})) as Record<string, unknown>;
  }

  /** Render the active sequence frame at `seconds` (default: the playhead). */
  async renderFrame(seconds?: number, maxSide = 960): Promise<McpToolResult> {
    const args: Record<string, unknown> = { max_side: maxSide };
    if (seconds !== undefined) args.seconds = seconds;
    return (await this.client.callTool({
      name: "render_frame",
      arguments: args,
    })) as unknown as McpToolResult;
  }
}

/* ================================================================== *
 * 3. TREE HELPERS
 * ================================================================== */

/** Depth-first flatten of the project-panel tree. */
function flattenItems(nodes: ProjectItem[], out: ProjectItem[] = []): ProjectItem[] {
  for (const node of nodes) {
    out.push(node);
    if (node.children?.length) flattenItems(node.children, out);
  }
  return out;
}

/**
 * Resolve a clip's project-item id by its file base name.
 *
 * The project tree hangs under `root.children`, and the id `timeline.place`
 * wants is the item's `item` field.
 */
export function findItemId(tree: Record<string, unknown>, fileName: string): number {
  const project = (tree.project ?? tree) as Record<string, unknown>;
  const root = (project.root ?? project) as { children?: ProjectItem[] };
  const all = flattenItems(root.children ?? []);
  const hit = all.find((i) => i.name === fileName || i.name.endsWith(`/${fileName}`));
  const id = hit?.item ?? hit?.id;
  if (id === undefined) {
    throw new Error(
      `Project item "${fileName}" not found. Known names: ${all.map((i) => i.name).join(", ")}`,
    );
  }
  return id;
}

/**
 * The short alias the engine commands use for a track label.
 *
 * The inspector reports "Video 1" and "Audio 2"; `timeline.place` and the
 * mixer commands want "V1" and "A2".
 */
export function trackAlias(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (
    parts.length === 2 &&
    /^(video|audio|caption)$/i.test(parts[0] ?? "") &&
    /^\d+$/.test(parts[1] ?? "")
  ) {
    const prefix =
      (parts[0] ?? "").toLowerCase() === "video" ? "V" : (parts[0] ?? "").toLowerCase() === "audio" ? "A" : "C";
    return prefix + parts[1];
  }
  return name;
}

/* ================================================================== *
 * 4. THREE-WAY COLOUR WHEELS
 * ================================================================== */

export type WheelBand = "shadows" | "midtones" | "highlights";

/**
 * The parameters of one band.
 *
 * The engine stores a band as two values: the colour vector
 * (`wheel_shadows`) and the luma offset (`wheel_shadows_l`). There is no
 * separate hue and saturation parameter — the vector carries both.
 */
interface WheelChannelIds {
  colour: string;
  luma: string;
}

export type WheelParamMap = Record<WheelBand, WheelChannelIds>;

/** The effect id the parameter commands want. */
export interface LumetriEffect {
  /** "lumetri" — `effects.setParam` only accepts the id. */
  readonly id: string;
  /** "Lumetri Color" — `effects.apply` accepts the display name. */
  readonly name: string;
}

const BANDS: readonly WheelBand[] = ["shadows", "midtones", "highlights"] as const;

/**
 * Discover the three-way wheel parameters of the Lumetri Color effect.
 *
 * FilmCraft exposes the *authoritative* parameter list through `effects.list`
 * with `detail: true`. Never hard-code a parameter name you have not confirmed;
 * resolve it once at worker start-up and cache it.
 */
export async function resolveWheelParams(
  fc: FilmCraftMCP,
  effectName = "Lumetri Color",
): Promise<{ effect: LumetriEffect; wheels: WheelParamMap }> {
  const listed = (await fc.run("effects.list", {
    kind: "Video",
    detail: true,
  })) as { effects?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;

  const effects = Array.isArray(listed) ? listed : (listed.effects ?? []);
  const hit = effects.find(
    (e) =>
      e.name === effectName ||
      e.id === effectName ||
      String(e.id ?? "").toLowerCase().endsWith("lumetri"),
  );

  if (!hit) {
    throw new Error(`Effect "${effectName}" is not present in this FilmCraft build.`);
  }

  // With `detail: true` the effect answers with the parameter names it
  // accepts, as an array.
  const raw = hit.params;
  const available = new Set(
    Array.isArray(raw) ? raw.map((p) => String(p)) : Object.keys((raw as Record<string, unknown>) ?? {}),
  );
  if (available.size === 0) {
    throw new Error(`"${effectName}" reported no parameters; check effects.list output shape.`);
  }

  const wheels = {} as WheelParamMap;
  for (const band of BANDS) {
    const colour = `wheel_${band}`;
    const luma = `${colour}_l`;
    if (!available.has(colour) || !available.has(luma)) {
      throw new Error(
        `Could not resolve "${colour}" on "${effectName}". Available: ${[...available].join(", ")}`,
      );
    }
    wheels[band] = { colour, luma };
  }

  return {
    effect: { id: String(hit.id ?? "lumetri"), name: String(hit.name ?? effectName) },
    wheels,
  };
}

/** One colour push on one band of the three-way wheels. */
export interface WheelPush {
  band: WheelBand;
  /** Hue angle in turns: 0.00 = red, 0.33 = green, 0.66 = blue. */
  hue: number;
  /** Saturation push, 0..1. */
  sat: number;
  /** Luminance lift/drop, -1..1. */
  lum: number;
}

/**
 * Apply one colour push to every clip in `clips`.
 *
 * When `atSeconds` is supplied the value lands as a keyframe at that time,
 * arming the stopwatch first (`effects.toggleAnimation`) so that a later call
 * at a different time produces an interpolation between the two.
 */
export async function pushWheel(
  fc: FilmCraftMCP,
  clips: number[],
  effect: LumetriEffect,
  wheels: WheelParamMap,
  push: WheelPush,
  atSeconds?: number,
): Promise<void> {
  const channel = wheels[push.band];
  const t = atSeconds === undefined ? undefined : ticks(atSeconds);
  const steps: FilmCraftStep[] = [];

  for (const clip of clips) {
    // The parameter commands address the effect by its id, not by the
    // display name the apply command accepts.
    const base = { clip, effect: effect.id } as const;

    if (t !== undefined) {
      // Arm the stopwatch first, so the next write at another time
      // interpolates instead of replacing the value.
      for (const param of [channel.colour, channel.luma]) {
        steps.push({
          id: "effects.toggleAnimation",
          params: { ...base, param },
        });
      }
    }

    steps.push({
      id: "effects.setParam",
      params: {
        ...base,
        param: channel.colour,
        // The engine wants the colour as [hue, saturation], normalised to
        // 0..1. The wheel push speaks in turns and per cent.
        value: [push.hue % 1, push.sat],
        merge: true,
        ...(t !== undefined ? { time: t } : {}),
      },
    });
    steps.push({
      id: "effects.setParam",
      params: {
        ...base,
        param: channel.luma,
        value: push.lum,
        merge: true,
        ...(t !== undefined ? { time: t } : {}),
      },
    });
  }

  const envelope = await fc.batch(steps, true);
  if (envelope.failed > 0) {
    throw new Error(
      `Wheel push ${push.band} failed at step ${envelope.completed}: ` +
        `${envelope.results[envelope.completed]?.error ?? "unknown"}`,
    );
  }
}

/* ================================================================== *
 * 5. LOUDNESS GOVERNANCE + DUCKING
 * ================================================================== */

/**
 * Classify the stems, anchor their loudness, then generate the ducking pass.
 *
 * Essential Sound needs a *type* before any of its heuristics apply: dialogue
 * repair and clarity are gated on `type: "dialogue"`, ducking is gated on
 * `type: "music"`. Ordering is therefore load-bearing.
 */
export async function governMix(
  fc: FilmCraftMCP,
  dialogueClips: number[],
  musicClips: number[],
  targets: LoudnessTargets,
): Promise<void> {
  const envelope = await fc.batch(
    [
      /* --- 5a. Classify the stems ------------------------------------ */
      { id: "essentialSound.setType", params: { clips: dialogueClips, type: "dialogue" } },
      { id: "essentialSound.setType", params: { clips: musicClips, type: "music" } },

      /* --- 5b. Dialogue chain: repair -> clarity -> loudness anchor --- */
      {
        id: "essentialSound.set",
        params: {
          clips: dialogueClips,
          values: {
            "repair.noise.on": true,
            "repair.noise.amount": 40,
            "repair.humHz": 50,
            // The engine names its EQ presets: "Balanced Voice" is the
            // one that lifts speech without colouring it.
            "clarity.eqPreset": "Balanced Voice",
          },
        },
      },
      {
        id: "essentialSound.autoMatch",
        params: { clips: dialogueClips, target: targets.dialogueLufs },
      },

      /* --- 5c. Music bed: trim, then anchor below dialogue ------------ */
      {
        id: "essentialSound.set",
        params: {
          clips: musicClips,
          values: {
            // The engine ships three room presets: "Small Room",
            // "Medium Room" and "Large Hall". The reverb itself stays
            // off — the preset only chooses the room the amount applies to.
            "creative.reverbPreset": "Small Room",
            "volume.levelDb": -6,
          },
        },
      },
      {
        id: "essentialSound.autoMatch",
        params: { clips: musicClips, target: targets.musicBedLufs },
      },

      /* --- 5d. Sidechain-style gain automation ----------------------- */
      {
        id: "essentialSound.set",
        params: {
          clips: musicClips,
          values: { "ducking.reduceDb": targets.duckDepthDb },
        },
      },
      { id: "essentialSound.generateDucking", params: { clips: musicClips } },
    ],
    true,
  );

  if (envelope.failed > 0) {
    throw new Error(
      `Mix governance failed at step ${envelope.completed}: ` +
        `${envelope.results[envelope.completed]?.error ?? "unknown"}`,
    );
  }
}

/* ================================================================== *
 * 6. THE PIPELINE
 * ================================================================== */

export interface GradeSpec {
  /** Push applied to the shadow band across the whole programme. */
  shadows: WheelPush;
  /** Push applied to the midtone band at the cold open. */
  midtonesOpen: WheelPush;
  /** Push applied to the midtone band at the button (same band, later time). */
  midtonesClose: WheelPush;
  /** Push applied to the highlight band across the whole programme. */
  highlights: WheelPush;
  /** Time, in seconds, of the cold-open midtone keyframe. */
  openAt: number;
  /** Time, in seconds, of the button midtone keyframe. */
  closeAt: number;
}

export interface JobRequest {
  projectRoot: string;
  dialogueFile: string;
  musicFile: string;
  brollFiles: string[];
  grade: GradeSpec;
  loudness: LoudnessTargets;
  deliveryPath: string;
  /** Where the studio keeps the project file. Optional: without it the
   *  job ends with the delivery and the project is not saved. */
  projectPath?: string;
}

/**
 * The whole job: build a timeline, grade it, govern it, deliver it.
 */
export async function runAutoFinish(req: JobRequest): Promise<void> {
  const fc = new FilmCraftMCP(req.projectRoot);
  await fc.connect();

  try {
    /* ---- Phase A: project + sequence ---------------------------------- */
    const setup = await fc.batch([
      { id: "file.newProject", params: { name: "Ep13_AutoFinish" } },
      {
        id: "file.newSequence",
        params: {
          name: "Ep13",
          width: 1920,
          height: 1080,
          fps: 24,
          sampleRate: 48000,
          video: 1,
          audio: 2,
          mix: "Stereo",
        },
      },
    ]);
    if (setup.failed > 0) throw new Error("Could not create the sequence.");

    /* ---- Phase B: ingest + resolve project-item ids ------------------- */
    await fc.run("file.import", {
      paths: [req.dialogueFile, req.musicFile, ...req.brollFiles],
    });

    const tree = await fc.inspect();
    const dialogueItem = findItemId(tree, "dialogue.wav");
    const musicItem = findItemId(tree, "music.wav");
    const brollItems = req.brollFiles.map((p) =>
      findItemId(tree, p.split("/").pop() as string),
    );

    /* ---- Phase C: lay the timeline ------------------------------------ */
    const laid = await fc.batch(
      [
        ...brollItems.map((item, i) => ({
          id: "timeline.place",
          params: {
            item,
            track: "V1",
            time: ticks(i * 4),
            insert: false,
            video: true,
            audio: false,
          },
        })),
        {
          id: "timeline.place",
          params: {
            item: dialogueItem,
            track: "A1",
            time: ticks(0),
            insert: false,
            video: false,
            audio: true,
          },
        },
        {
          id: "timeline.place",
          params: {
            item: musicItem,
            track: "A2",
            time: ticks(0),
            insert: false,
            video: false,
            audio: true,
          },
        },
      ],
      true,
    );
    if (laid.failed > 0) throw new Error("Timeline assembly failed.");

    /* ---- Phase D: discover clip ids on the sequence -------------------- */
    // The inspector reports one array per track kind, and every track
    // carries its `items`. A clip is identified by `clip`.
    const seq = (await fc.inspect()).sequence as
      | {
          video?: Array<{ name: string; items?: Array<{ clip: number }> }>;
          audio?: Array<{ name: string; items?: Array<{ clip: number }> }>;
        }
      | null;
    if (!seq?.video) throw new Error("No active sequence returned by doc_inspect.");

    const videoClipIds: number[] = [];
    const dialogueClipIds: number[] = [];
    const musicClipIds: number[] = [];

    for (const track of seq.video) {
      for (const clip of track.items ?? []) videoClipIds.push(clip.clip);
    }
    for (const track of seq.audio ?? []) {
      const alias = trackAlias(track.name);
      for (const clip of track.items ?? []) {
        if (alias === "A1") dialogueClipIds.push(clip.clip);
        else if (alias === "A2") musicClipIds.push(clip.clip);
      }
    }

    if (videoClipIds.length === 0) throw new Error("No video clips on the sequence.");

    /* ---- Phase E: three-way grade ------------------------------------- */
    const { effect, wheels } = await resolveWheelParams(fc, "Lumetri Color");

    await fc.run("effects.apply", {
      clips: videoClipIds,
      effect: effect.name,
    });

    // Static bands: shadow crush + cool, highlight roll-off + warm.
    await pushWheel(fc, videoClipIds, effect, wheels, req.grade.shadows);
    await pushWheel(fc, videoClipIds, effect, wheels, req.grade.highlights);

    // Animated midtone band: cold open -> warm button.
    await pushWheel(fc, videoClipIds, effect, wheels, req.grade.midtonesOpen, req.grade.openAt);
    await pushWheel(fc, videoClipIds, effect, wheels, req.grade.midtonesClose, req.grade.closeAt);

    /* ---- Phase F: audio governance ------------------------------------ */
    await governMix(fc, dialogueClipIds, musicClipIds, req.loudness);

    /* ---- Phase G: verify visually ------------------------------------- */
    const frame = await fc.renderFrame(req.grade.closeAt, 960);
    const hasImage = frame.content.some((b) => b.type === "image");
    if (!hasImage) {
      console.warn("[warn] render_frame returned no image block; skipping vision audit.");
    }

    /* ---- Phase H: deliver with loudness normalisation ------------------ */
    await fc.run("file.exportMedia", {
      path: req.deliveryPath,
      format: "h264",
      width: 1920,
      height: 1080,
      fps: 24,
      bitrateKbps: 12000,
      bitrateMode: "vbr2Pass",
      audio: true,
      loudnessLufs: req.loudness.deliveryLufs,
      range: "entire",
      wait: true,
    });

    /* ---- Phase I: keep the project ------------------------------------- */
    // The studio keeps the project: the next revision starts from it, and a
    // reviewer can open the graded timeline without re-running the job.
    if (req.projectPath) {
      await fc.run("file.save", { path: req.projectPath });
    }

    console.log(
      `[ok] graded + ducked + normalised to ${req.loudness.deliveryLufs} LUFS ` +
        `(ceiling ${req.loudness.truePeakDbtp} dBTP) -> ${req.deliveryPath}`,
    );
  } finally {
    await fc.close();
  }
}

/* ================================================================== *
 * 7. HELLO WORLD ENTRY POINT
 * ================================================================== */

if (import.meta.url === `file://${process.argv[1]}`) {
  void runAutoFinish({
    projectRoot: process.cwd(),
    dialogueFile: "stems/dialogue.wav",
    musicFile: "stems/music.wav",
    brollFiles: ["broll/01.mp4", "broll/02.mp4", "broll/03.mp4", "broll/04.mp4"],
    grade: {
      shadows: { band: "shadows", hue: 0.58, sat: 0.35, lum: -0.12 },
      midtonesOpen: { band: "midtones", hue: 0.6, sat: 0.22, lum: -0.06 },
      midtonesClose: { band: "midtones", hue: 0.08, sat: 0.3, lum: 0.05 },
      highlights: { band: "highlights", hue: 0.1, sat: 0.18, lum: 0.08 },
      openAt: 0,
      closeAt: 16,
    },
    loudness: {
      dialogueLufs: -16,
      musicBedLufs: -26,
      truePeakDbtp: -1.0,
      duckDepthDb: -12,
      deliveryLufs: -14,
    },
    deliveryPath: "deliveries/ep13_master.mp4",
  }).catch((err: unknown) => {
    console.error("[fatal]", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
