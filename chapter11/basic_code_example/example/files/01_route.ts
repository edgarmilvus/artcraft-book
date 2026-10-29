/**
 * app/api/hello-timebase/route.ts
 *
 * A minimal, self-contained example demonstrating FilmCraft's integer
 * timebase from outside the engine: a headless agent talks to
 * `filmcraft-cli mcp` over stdio, and every position it sends or receives
 * is a BigInt tick carried across the wire as a decimal string.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/* ================================================================== *
 * 1. The timebase itself                                             *
 * ================================================================== */

/**
 * Number of integer ticks in exactly one wall-clock second.
 *
 *   254_016_000_000 = 2^12 · 3^4 · 5^6 · 7^2
 *
 * This factorisation is deliberately over-complete: it divides evenly by
 * every standard video frame rate (24, 25, 30, 48, 50, 60, 90, 120 and
 * the NTSC 1000/1001 families 24000/1001, 30000/1001, 60000/1001) and by
 * every standard audio sample rate (8000, 11025, 16000, 22050, 32000,
 * 44100, 48000, 88200, 96000, 176400, 192000).  At 24 fps one frame is
 * 10_584_000_000 ticks; at 48 kHz one sample is 5_292_000 ticks.
 */
export const TICKS_PER_SECOND = 254_016_000_000n;

/** A rational frame rate.  24/1 for 24 fps, 24000/1001 for 23.976. */
export interface Fps {
  readonly num: bigint;
  readonly den: bigint;
}

/** The simplest common case — exactly twenty-four frames per second. */
export const FPS_24: Fps = { num: 24n, den: 1n };

/**
 * Convert a frame index to its tick position, exact to the tick.
 *
 *   ticks = frame · den · TICKS_PER_SECOND / num
 *
 * Because TICKS_PER_SECOND is divisible by every standard `num`, the
 * final division never truncates.  For 24 fps the divisor is 24 and the
 * quotient is 10_584_000_000 ticks per frame; multiplying by a frame
 * index gives the unique integer tick at which that frame begins.
 */
export function framesToTicks(frame: bigint, fps: Fps): bigint {
  return (frame * fps.den * TICKS_PER_SECOND) / fps.num;
}

/**
 * Recover the frame index that *contains* a given tick (floor division,
 * i.e. the frame whose start is the greatest frame start <= `ticks`).
 * Useful for showing "we are on frame 47" without ever leaving integer
 * arithmetic.
 */
export function ticksToFrames(ticks: bigint, fps: Fps): bigint {
  return (ticks * fps.num) / (fps.den * TICKS_PER_SECOND);
}

/** Whole seconds to ticks — exact for any |n| < 2^63. */
export function secondsToTicks(seconds: bigint): bigint {
  return seconds * TICKS_PER_SECOND;
}

/* ================================================================== *
 * 2. Tiny MCP plumbing — one helper, one wrapper                     *
 * ================================================================== */

/**
 * Call any MCP tool and return its JSON payload.  FilmCraft returns
 * structured JSON for its inspect tools and a single JSON text block for
 * `command_run`; both shapes are unwrapped here so callers see plain
 * objects.
 */
async function call<T = Record<string, unknown>>(
  mcp: Client,
  tool: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const reply = await mcp.callTool({ name: tool, arguments: args });

  // Preferred path: the server populated `structuredContent`.
  const sc = (reply as { structuredContent?: unknown }).structuredContent;
  if (sc && typeof sc === "object") return sc as T;

  // Fallback: parse the first text content block that is valid JSON.
  const blocks = (reply.content ?? []) as Array<{ type: string; text?: string }>;
  for (const b of blocks) {
    if (b.type === "text" && typeof b.text === "string") {
      try {
        return JSON.parse(b.text) as T;
      } catch {
        /* not JSON — keep looking */
      }
    }
  }
  return {} as T;
}

/**
 * Run one FilmCraft engine command through the `command_run` meta-tool.
 * The whole 500-command registry is reachable this way, so an agent never
 * needs a separate MCP tool per verb.
 */
async function run(
  mcp: Client,
  id: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return call(mcp, "command_run", { id, params });
}

/* ================================================================== *
 * 3. Inspect-payload walkers (defensive, shape-tolerant)             *
 * ================================================================== */

/**
 * Walk a `project_inspect` tree and collect the numeric ids of every
 * footage item, in bin order.
 *
 * The tree names a media item by `item` (the id `timeline.place` takes) and
 * types it `Movie`; the walker accepts `item`/`id` and `type`/`kind` so it
 * survives a rename.
 */
function collectFootageItems(tree: unknown): number[] {
  const out: number[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    const kind = String(n.type ?? n.kind ?? "").toLowerCase();
    const id = n.item ?? n.id;
    if (
      (kind === "movie" || kind === "footage" || kind === "clip") &&
      typeof id === "number"
    ) {
      out.push(id);
    }
    const kids = (n.children ?? n.items ?? n.bins) as unknown[] | undefined;
    if (Array.isArray(kids)) kids.forEach(visit);
  };
  // The project tree hangs under `root`.
  visit((tree as Record<string, unknown>)?.root ?? tree);
  return out;
}

interface PlacedClip {
  readonly id: number;
  readonly startTicks: string;
}

/**
 * Collect every clip on every track of a `sequence_inspect` payload.
 *
 * The payload has one array per track kind — `video` and `audio` — and each
 * track carries its `items`. Clip `start` may arrive as a number or a
 * string, so it is coerced to a canonical decimal string for comparison with
 * our own BigInt output.
 */
function collectClips(seq: unknown): PlacedClip[] {
  const out: PlacedClip[] = [];
  const payload = seq as Record<string, unknown>;
  const tracks = [
    ...((payload?.video ?? []) as unknown[]),
    ...((payload?.audio ?? []) as unknown[]),
    ...((payload?.tracks ?? []) as unknown[]),
  ];
  for (const track of tracks) {
    const clips = ((track as Record<string, unknown>)?.items ??
      (track as Record<string, unknown>)?.clips ??
      []) as Array<Record<string, unknown>>;
    for (const c of clips) {
      const raw = c.start ?? c.startTicks;
      if (typeof c.clip === "number" && raw != null) {
        out.push({ id: c.clip, startTicks: String(raw) });
      }
    }
  }
  return out;
}

/* ================================================================== *
 * 4. The Hello World                                                 *
 * ================================================================== */

export interface HelloResult {
  /** Tick where the second clip was placed (decimal string for JSON). */
  readonly clipBTicks: string;
  /** The same instant rounded down to a frame index. */
  readonly clipBFrame: string;
  /** Frame index where the render was taken. */
  readonly renderedAtFrame: string;
}

/**
 * Build a tiny two-clip sequence whose second clip starts at exactly two
 * seconds (frame 48 of a 24 fps sequence), verify that FilmCraft reports
 * the same tick back, and take a frame render there.
 */
export async function helloTimebase(): Promise<HelloResult> {
  /* 4.1  Launch the headless MCP server over stdio. ----------------- */
  const transport = new StdioClientTransport({
    command: "filmcraft-cli",
    args: [
      "mcp",
      "--automation-read-root",
      process.cwd(),
      "--automation-write-root",
      process.cwd(),
    ],
  });

  const mcp = new Client(
    { name: "hello-timebase", version: "1.0.0" },
    { capabilities: {} },
  );

  await mcp.connect(transport);

  try {
    /* 4.2  A brand-new, empty project. ---------------------------- */
    await run(mcp, "file.newProject", { name: "HelloTimebase" });

    /* 4.3  A 24 fps / 48 kHz sequence with two video and two audio
             tracks. ------------------------------------------------ */
    await run(mcp, "file.newSequence", {
      name: "Main",
      width: 1920,
      height: 1080,
      fps: 24,
      sampleRate: 48000,
      video: 2,
      audio: 2,
      mix: "Stereo",
    });

    /* 4.4  Two pieces of built-in footage to make the timeline real. */
    await run(mcp, "file.importDemoFootage", { scene: "OceanSunset" });
    await run(mcp, "file.importDemoFootage", { scene: "Aurora" });

    /* 4.5  Discover the ids of what we just imported. -------------- */
    const tree = await call(mcp, "project_inspect");
    const items = collectFootageItems(tree);
    if (items.length < 2) {
      throw new Error(`expected at least two footage items, got ${items.length}`);
    }
    const [clipA, clipB] = items;

    /* 4.6  Compute the two tick positions with BigInt arithmetic. --- */
    const tickAtFrameZero = framesToTicks(0n, FPS_24); // 0n
    const tickAtFrame48 = framesToTicks(48n, FPS_24); // 2 s exactly

    /* 4.7  Place clip A at the origin on V1 + A1. ------------------- */
    await run(mcp, "timeline.place", {
      item: clipA,
      track: "V1",
      audioTrack: "A1",
      time: Number(tickAtFrameZero),
      video: true,
      audio: true,
    });

    /* 4.8  Place clip B at exactly frame 48 on V2 + A2. ------------ */
    await run(mcp, "timeline.place", {
      item: clipB,
      track: "V2",
      audioTrack: "A2",
      time: Number(tickAtFrame48),
      video: true,
      audio: true,
    });

    /* 4.9  Read the sequence back and confirm the tick we asked for. */
    const seq = await call(mcp, "sequence_inspect");
    const placed = collectClips(seq).find(
      (c) => c.startTicks === tickAtFrame48.toString(),
    );
    if (!placed) {
      throw new Error(
        `FilmCraft did not report a clip starting at tick ${tickAtFrame48}`,
      );
    }

    /* 4.10 Park the playhead on exactly frame 48 and render. -------
       `playhead.set` takes ticks; `render_frame` without a `seconds`
       argument renders the playhead's frame. */
    await run(mcp, "playhead.set", { time: Number(tickAtFrame48) });
    await mcp.callTool({
      name: "render_frame",
      arguments: { max_side: 480 },
    });

    /* 4.11 Prove the round trip is an identity function. ----------- */
    const frames = ticksToFrames(tickAtFrame48, FPS_24);
    const reTicks = framesToTicks(frames, FPS_24);
    if (reTicks !== tickAtFrame48) {
      throw new Error(
        `frame round-trip drifted: ${tickAtFrame48} -> ${frames} -> ${reTicks}`,
      );
    }

    return {
      clipBTicks: tickAtFrame48.toString(),
      clipBFrame: frames.toString(),
      renderedAtFrame: frames.toString(),
    };
  } finally {
    /* 4.12 Always tear the MCP server down, even on error. --------- */
    await mcp.close();
  }
}

/* ================================================================== *
 * 5. Next.js App Router handler                                      *
 * ================================================================== */

/**
 * A plain GET handler so the route can be exercised from a browser or
 * `curl`.  In production this would be a Server Component calling
 * `helloTimebase()` directly, or a server action invoked from the client
 * — either way the MCP transport never crosses to the browser bundle.
 */
export async function GET(): Promise<Response> {
  const result = await helloTimebase();
  return Response.json(result);
}
