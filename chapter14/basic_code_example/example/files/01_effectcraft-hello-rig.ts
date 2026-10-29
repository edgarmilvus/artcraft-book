/**
 * @file effectcraft-hello-rig.ts
 * @packageDocumentation
 *
 * A single, self-contained TypeScript module that spins up a minimal but
 * fully *rigged* motion-graphics composition inside EffectCraft — the
 * open-source After Effects–style application from the ArtCraft suite.
 *
 * The example is deliberately small and end-to-end:
 *
 *   • one 1920×1080 @ 30 fps, 3-second composition ("Hello Rig");
 *   • one Null layer that acts as the rig's controller ("CTRL");
 *   • one Star shape layer, parented to the controller, decorated with a
 *     Trim Paths operator and a Glow effect, animated by both keyframes
 *     and a `wiggle()` expression ("Badge");
 *   • one Text layer, also parented, staggered relative to the badge in
 *     rig space ("Title");
 *   • one preview frame rendered as PNG at 0.75 s for a Vision-LLM pass.
 *
 * Everything travels over MCP using the official meta-tools
 * (`batch`, `render_frame`). The `batch` call runs as ONE undoable
 * history entry because we set `atomic: true`. The whole module is
 * structured as a Vercel AI SDK tool so it can be dropped into a
 * Next.js route handler with no glue.
 *
 * @remarks
 *   - All wire payloads are validated at runtime by Zod schemas, and
 *     every compile-time type is *inferred* from those schemas via
 *     `z.infer<typeof X>` — the validator and the type can never drift.
 *   - The MCP transport is `stdio`, which spawns `effectcraft-cli mcp`
 *     as a child process. The alternative loopback TCP channel would
 *     require an authentication frame as the *first* message on the
 *     socket; stdio has no such requirement because it is already a
 *     private pipe to a child process.
 *   - Read-only inspection tools (`get_comp`, `get layer`, `render_frame`)
 *     are safe to call in sequence; edit tools must be batched, because
 *     every non-batch tool call is its own history entry.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tool } from "ai";
import { z } from "zod";

/* ================================================================== *
 *  1.  WIRE SCHEMAS  —  the runtime validators that ARE the types.
 * ================================================================== */

/**
 * Successful payload emitted by `comp.new`. Every field is present in
 * the reply of `get_comp`, so the schema mirrors the runtime contract
 * exactly; there is no need to hand-write an interface.
 */
const CompCreatedSchema = z.object({
  id: z.number().int().nonnegative(),
  name: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  frameRate: z.number().positive(),
  duration: z.number().positive(),
});

/**
 * Successful payload emitted by every `layer.new*` command
 * (`layer.newNull`, `layer.newShape`, `layer.newText`, …). The engine
 * returns the freshly-allocated layer id in the `layer` field.
 */
const LayerCreatedSchema = z.object({
  layer: z.number().int().nonnegative(),
});

/**
 * The universal EffectCraft MCP error envelope. Every command in the
 * registry can fail with this shape; agents should test for it *before*
 * attempting to destructure a success payload.
 */
const ErrorEnvelopeSchema = z.object({
  error: z.string().min(1),
  message: z.string().optional(),
});

/**
 * One step of an MCP `batch` call. The `command` is a registry id
 * (`comp.new`, `prop.addKey`, …) and `params` is the JSON parameter
 * object described by `describe_command`. Optional because some commands
 * (e.g. `edit.undo`) take no parameters.
 */
const BatchStepSchema = z.object({
  command: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Envelope returned by the MCP `batch` tool (`engine.batch`). `steps`
 * is the count that actually ran — always compare it with the length of
 * the array you sent, or a silently-aborted batch will pass unnoticed.
 */
const BatchResultSchema = z.object({
  steps: z.number().int().nonnegative(),
  results: z.array(z.unknown()),
});

/**
 * One content block inside a generic MCP tool-call result. The union
 * narrows automatically on the discriminant `type`, which is what lets
 * `find((c) => c.type === "text")` give us a strongly-typed block.
 */
const ContentBlockSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("image"),
    data: z.string().min(1),      // base64
    mimeType: z.string().min(1),  // "image/png"
  }),
]);

/**
 * The outermost envelope delivered by `client.callTool(...)` before any
 * JSON decoding: a non-empty array of content blocks plus an optional
 * `isError` flag that the MCP runtime sets when a *tool* (not the JSON
 * payload) failed.
 */
const CallResultSchema = z.object({
  content: z.array(ContentBlockSchema).min(1),
  isError: z.boolean().optional(),
});

/* ------------------------------------------------------------------ *
 *  Inferred aliases. Each is one line; none can drift from the schema
 *  because Zod *derives* them from the same source of truth.
 * ------------------------------------------------------------------ */
type CompCreated  = z.infer<typeof CompCreatedSchema>;
type LayerCreated = z.infer<typeof LayerCreatedSchema>;
type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
type BatchStep    = z.infer<typeof BatchStepSchema>;
type BatchResult  = z.infer<typeof BatchResultSchema>;
type CallResult   = z.infer<typeof CallResultSchema>;

/* ================================================================== *
 *  2.  USER-DEFINED TYPE GUARDS  —  narrowing `unknown` safely.
 * ================================================================== */

/**
 * Narrows an arbitrary `unknown` value to the EffectCraft error
 * envelope. Because the return type is declared with an `is` predicate,
 * TypeScript narrows the value *inside the `if` branch* to
 * `ErrorEnvelope`, giving us `.error` and `.message` safely.
 *
 * @param value - Anything decoded from the JSON-RPC text block.
 * @returns `true` iff `value` matches `ErrorEnvelopeSchema`.
 */
function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  return ErrorEnvelopeSchema.safeParse(value).success;
}

/**
 * Narrows an arbitrary `unknown` to a `{ layer: number }` creation
 * payload. `safeParse` never throws, which makes it the correct choice
 * for validation of *untrusted* input from a network or a child process.
 */
function isLayerCreated(value: unknown): value is LayerCreated {
  return LayerCreatedSchema.safeParse(value).success;
}

/**
 * Narrows an arbitrary `unknown` to the top-level MCP tool-call
 * envelope. This is the guard that lets us safely access `.content`
 * and `.isError` without a manual `as` assertion.
 */
function isCallResult(value: unknown): value is CallResult {
  return CallResultSchema.safeParse(value).success;
}

/* ================================================================== *
 *  3.  SMALL DECODING HELPERS
 * ================================================================== */

/**
 * Decodes the JSON carried by the first eligible text block of an MCP
 * result. The MCP text block is the transport's container for structured
 * payloads; the structured JSON itself lives *inside* it.
 *
 * @throws TypeError  if the result contains no text block at all.
 * @throws SyntaxError if the block is not valid JSON.
 */
function decodeFirstText(r: CallResult): unknown {
  const block = r.content.find((c) => c.type === "text");
  if (!block || block.type !== "text") {
    throw new TypeError("MCP result contained no text block to decode");
  }
  return JSON.parse(block.text) as unknown;
}

/**
 * Extracts the base64 body of the first image block of an MCP result.
 * Used by `render_frame`, which returns PNG bytes as an image content
 * block rather than as inline text.
 */
function firstImageBase64(r: CallResult): string {
  const block = r.content.find((c) => c.type === "image");
  if (!block || block.type !== "image") {
    throw new TypeError("MCP result contained no image block");
  }
  return block.data;
}

/* ================================================================== *
 *  4.  PUBLIC SHAPES
 * ================================================================== */

/** Caller-tunable knobs for {@link buildHelloRig}. */
export interface HelloRigOptions {
  /** Hex accent colour of the star badge. Defaults to amber. */
  readonly accent?: string;
  /** Copy for the animated title layer. */
  readonly title?: string;
  /** Timeline position (seconds) at which the preview is rendered. */
  readonly frameTime?: number;
  /** Longest side of the returned PNG, in pixels. */
  readonly maxSide?: number;
}

/** Everything the caller needs to keep driving the rig afterwards. */
export interface HelloRigResult {
  /** Composition metadata, including the id of the new CompItem. */
  readonly comp: CompCreated;
  /** The null controller layer that drives the whole rig. */
  readonly ctrlLayer: LayerCreated;
  /** The star-shaped badge layer, parented to the controller. */
  readonly badgeLayer: LayerCreated;
  /** The text layer, parented to the controller. */
  readonly titleLayer: LayerCreated;
  /** PNG preview frame, base64-encoded, ready for a Vision-LLM. */
  readonly previewPngBase64: string;
}

/* ================================================================== *
 *  5.  THE ENTRY POINT
 * ================================================================== */

/**
 * Builds the "Hello Rig" composition inside a freshly-spawned headless
 * EffectCraft process, then returns a rendered preview frame.
 *
 * The entire construction is a single atomic MCP `batch`, so the user's
 * History panel shows exactly one undoable entry named "Hello Rig",
 * rather than fifteen.
 *
 * @param options - Optional overrides for accent, title, frame time and
 *                  preview size.
 * @returns A promise resolving to the ids of the newly-created items
 *          plus the base64 PNG of the rendered preview.
 * @throws If the MCP transport fails, the batch aborts, or the returned
 *         payload does not match the declared schemas.
 */
export async function buildHelloRig(
  options: HelloRigOptions = {},
): Promise<HelloRigResult> {
  // A) Apply caller defaults with destructuring — this is one of the
  //    few places where a per-call default is clearer than a Zod
  //    .default(), because it also documents the value in the option
  //    interface's JSDoc above.
  const {
    accent = "#f59e0b",
    title = "Hello, Motion",
    frameTime = 0.75,
    maxSide = 960,
  } = options;

  // B) Spawn the headless MCP server as a child process. Stdio is the
  //    transport of choice for serverless/CI: no TCP port, no token,
  //    no filesystem sandbox handshake. The child is torn down in the
  //    `finally` block below.
  const transport = new StdioClientTransport({
    command: "effectcraft-cli",
    args: ["mcp"],
  });

  // C) The MCP client is transport-agnostic. Identifying ourselves as
  //    `agentic-studio-agent` gives the engine a stable label to log.
  const client = new Client(
    { name: "agentic-studio-agent", version: "0.1.0" },
    { capabilities: {} },
  );

  await client.connect(transport);

  try {
    // ---------------------------------------------------------------
    // D) Compose the entire rig as ONE atomic batch. Because the batch
    //    is atomic on the engine side, a failing thirteenth step rolls
    //    back the first twelve and leaves the project untouched.
    //    The string references `"$N.path"` reach backwards into earlier
    //    step results — 1-based, unlike the 0-based `results` array in
    //    the reply. Keep an eye on that asymmetry.
    // ---------------------------------------------------------------
    const steps: BatchStep[] = [
      // Step 1: create the composition. `comp.new` makes it active, so
      // every subsequent layer command targets it without a `comp` arg.
      {
        command: "comp.new",
        params: {
          name: "Hello Rig",
          width: 1920,
          height: 1080,
          frameRate: 30,
          duration: 3,
        },
      },

      // Step 2: the null controller.  From here on we refer to it as
      // `$2.layer` (its result).
      {
        command: "layer.newNull",
        params: { name: "CTRL" },
      },

      // Step 3: park the controller at the left third of the frame so
      // the anchor point of the rig is deterministic.  This is a static
      // value; the keyframes arrive next.
      {
        command: "prop.set",
        params: {
          layer: "$2.layer",
          path: "transform/position",
          value: [320, 540],
        },
      },

      // Step 4: the first position key at t = 0 s.
      {
        command: "prop.addKey",
        params: {
          layer: "$2.layer",
          path: "transform/position",
          time: 0,
          value: [320, 540],
        },
      },

      // Step 5: the second position key at t = 1.5 s (the right third).
      {
        command: "prop.addKey",
        params: {
          layer: "$2.layer",
          path: "transform/position",
          time: 1.5,
          value: [1600, 540],
        },
      },

      // Step 6: explicitly select the two keys we just created so the
      // next step (Easy Ease) has a well-defined target.  Relying on
      // the engine's "last keyed" behaviour is fragile and version-
      // dependent; being explicit is cheaper than debugging a rig.
      {
        command: "keys.select",
        params: {
          keys: [
            { layer: "$2.layer", prop: "transform/position", time: 0 },
            { layer: "$2.layer", prop: "transform/position", time: 1.5 },
          ],
        },
      },

      // Step 7: Easy-Ease both keys. That's the F9 shortcut in After
      // Effects and the most common easing preset in motion design.
      {
        command: "keys.easyEase",
        params: { which: "both" },
      },

      // Step 8: the star badge as a live shape layer.  Buying a star
      // here rather than hand-rolling a path keeps the rig editable:
      // the `sides` and `radius` remain parameters you can tweak later.
      {
        command: "layer.newShape",
        params: {
          kind: "star",
          name: "Badge",
          size: [280, 280],
          fill: accent,
          stroke: "#111827",
          strokeWidth: 8,
        },
      },

      // Step 9: append a Trim Paths operator to the newly-created
      // shape layer.  Trim Paths is one of the classic rigging
      // primitives — keying its End from 0 to 100 reads as a draw-on
      // animation without ever touching the geometry.
      {
        command: "layer.addShapeItem",
        params: {
          layer: "$8.layer",
          kind: "trim",
        },
      },

      // Step 10: parent the badge to the controller. Everything that
      // transforms the controller now transforms the badge, without
      // the badge carrying its own position keyframes.
      {
        command: "layer.setParent",
        params: {
          layers: ["$8.layer"],
          parent: "$2.layer",
        },
      },

      // Step 11: overlay a procedural rotation on the badge.  The
      // expression is the low-rent, high-yield trick of motion
      // graphics: one line replaces a whole Rotate keyframe track.
      {
        command: "prop.setExpression",
        params: {
          layer: "$8.layer",
          path: "transform/rotation",
          expression: "wiggle(1.5, 12)",
        },
      },

      // Step 12: the title layer.  Also parented to the controller;
      // its position is in *rig space*, not comp space.
      {
        command: "layer.newText",
        params: {
          text: title,
          name: "Title",
          position: [320, 840],
          size: 96,
          fill: "#ffffff",
        },
      },

      // Step 13: parent the title to the same controller.
      {
        command: "layer.setParent",
        params: {
          layers: ["$12.layer"],
          parent: "$2.layer",
        },
      },

      // Step 14: a Glow effect on the badge.  Adding the effect to the
      // batch means the whole look is one undo, not "make the rig …
      // then separately add a glow".
      {
        command: "effect.apply",
        params: {
          effect: "Glow",
          layers: ["$8.layer"],
        },
      },

      // Step 15: park the playhead on the requested frame.  The next
      // call (render_frame) has no `time` argument, so it uses the
      // current time — this is how we get a deterministic preview.
      {
        command: "time.set",
        params: { time: frameTime },
      },
    ];

    // E) Fire the batch.  `atomic: true` guarantees rollback on error;
    //    `label` names the single undo entry the whole thing produces.
    const rawBatch: unknown = await client.callTool({
      name: "batch",
      arguments: {
        label: "Hello Rig",
        atomic: true,
        steps,
      },
    });

    // F) Narrow the outer MCP envelope with our type guard.  If the
    //    guard rejects, we throw *before* ever touching `.content`.
    if (!isCallResult(rawBatch)) {
      throw new TypeError("MCP returned an unrecognised batch envelope");
    }

    // G) `isError` indicates the tool itself failed; content is a
    //    human-readable diagnostic that is safe to surface.
    if (rawBatch.isError) {
      const block = rawBatch.content[0];
      const msg = block?.type === "text" ? block.text : "unknown error";
      throw new Error(`EffectCraft batch failed: ${msg}`);
    }

    // H) Decode the JSON payload, then check for a per-step error
    //    envelope.  `batch` can return `ok: true` for a non-atomic
    //    batch that aborted on step 3 — this is why we always test.
    const decoded: unknown = decodeFirstText(rawBatch);
    if (isErrorEnvelope(decoded)) {
      throw new Error(`Batch rejected by engine: ${decoded.error}`);
    }

    const batch: BatchResult = BatchResultSchema.parse(decoded);
    if (batch.steps !== steps.length) {
      throw new Error(
        `Batch ran ${batch.steps} of ${steps.length} steps — one or more ` +
          `silent failures were rolled back.`,
      );
    }

    // I) Extract the four results we care about.  Note the asymmetry:
    //    the wire uses 1-based `$N` references, but the `results` array
    //    is 0-based.  Step 1 (comp.new) → results[0]; step 2 (null) →
    //    results[1]; step 8 (badge) → results[7]; step 12 (title) →
    //    results[11].
    const compRes  = batch.results[0];
    const ctrlRes  = batch.results[1];
    const badgeRes = batch.results[7];
    const titleRes = batch.results[11];

    // J) The batch answers with the *id* of the new composition, not with
    //    its metadata. `get_comp` is the read side of the same contract,
    //    so the schema is checked against it.
    const compId = (compRes as { comp?: number }).comp;
    if (compId === undefined) {
      throw new Error("comp.new did not return a composition id");
    }
    const rawComp: unknown = await client.callTool({
      name: "get_comp",
      arguments: { comp: compId },
    });
    if (!isCallResult(rawComp)) {
      throw new TypeError("get_comp returned an unrecognised envelope");
    }
    const comp: CompCreated = CompCreatedSchema.parse(decodeFirstText(rawComp));

    // K) The three layer results are narrowed with the user-defined
    //    type guard, so subsequent code has access to `.layer` without
    //    a cast.
    if (!isLayerCreated(ctrlRes)) {
      throw new Error("layer.newNull did not return a layer id");
    }
    if (!isLayerCreated(badgeRes)) {
      throw new Error("layer.newShape did not return a layer id");
    }
    if (!isLayerCreated(titleRes)) {
      throw new Error("layer.newText did not return a layer id");
    }

    // L) Render a preview frame.  `max_side` bounds the PNG so a
    //    serverless response stays small; `inline: true` returns the
    //    image bytes as an MCP image content block.
    const rawRender: unknown = await client.callTool({
      name: "render_frame",
      arguments: { max_side: maxSide, inline: true },
    });

    if (!isCallResult(rawRender)) {
      throw new TypeError("render_frame returned an unrecognised envelope");
    }
    if (rawRender.isError) {
      const block = rawRender.content[0];
      const msg = block?.type === "text" ? block.text : "unknown error";
      throw new Error(`render_frame failed: ${msg}`);
    }

    // M) Return everything the caller (or the Vision-LLM audit loop)
    //    needs to keep driving the rig.
    return {
      comp,
      ctrlLayer: ctrlRes,
      badgeLayer: badgeRes,
      titleLayer: titleRes,
      previewPngBase64: firstImageBase64(rawRender),
    };
  } finally {
    // N) Always tear down the stdio child process.  Leaking an
    //    `effectcraft-cli` instance per request will eventually exhaust
    //    a serverless container's process budget.
    await client.close();
  }
}

/* ================================================================== *
 *  6.  VERCEL AI SDK TOOL WRAPPER
 * ================================================================== */

/**
 * Exposes {@link buildHelloRig} as a Vercel AI SDK tool. The `inputSchema`
 * is itself a Zod object; the SDK infers the `execute` argument
 * type from it, so the tool's signature can never drift from what the
 * LLM is told it can send.
 *
 * Drop this into a Next.js route handler and call it from any model
 * that supports tool/function calling:
 *
 * ```ts
 * import { generateText } from "ai";
 * import { openai } from "@ai-sdk/openai";
 *
 * const { text } = await generateText({
 *   model: openai("gpt-4o"),
 *   prompt: "Build the Hello Rig and describe the animation you produced.",
 *   tools: { buildHelloRigTool },
 *   maxSteps: 3,
 * });
 * ```
 */
export const buildHelloRigTool = tool({
  description:
    "Build an EffectCraft 'Hello Rig' motion-graphics composition " +
    "(null controller + star badge + parented text) and return a " +
    "rendered preview frame as PNG (base64).",
  inputSchema: z.object({
    accent: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .default("#f59e0b")
      .describe("Hex colour of the rig's star badge"),
    title: z
      .string()
      .min(1)
      .max(64)
      .default("Hello, Motion")
      .describe("Copy for the animated title layer"),
  }),
  execute: async ({ accent, title }) => buildHelloRig({ accent, title }),
});
