/**
 * @file vectorforge-logo-synthesis.ts
 * @summary
 *   VectorForge is the vector-synthesis worker for a multi-tenant SaaS brand
 *   asset API. It drives the VectorCraft headless engine over the Model
 *   Context Protocol using a stdio transport, generating parametric logo
 *   geometry from cubic Bézier primitives, live blends, and Pathfinder
 *   booleans, then exporting SVG and PNG artifacts to the tenant's workspace.
 *
 *   The client is intentionally deterministic: for a given request payload,
 *   the same bytes come out of `document.export` every time. This property is
 *   what makes the SaaS layer able to cache artifacts by request hash and to
 *   reproduce an asset months later during a branded-content audit.
 *
 * @see  vectorcraft-cli mcp        (stdio JSON-RPC session)
 * @see  "COMPILED RUNTIME SCHEMAS" (ground-truth parameter names)
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

// ============================================================================
// 1. SCHEMAS — every cross-boundary object is validated with Zod so a
//    malformed tenant request never reaches the engine and a malformed
//    engine response never reaches the persistence layer.
// ============================================================================

/**
 * A single anchor on a cubic Bézier path. `in` and `out` are the tangent
 * handles in absolute document coordinates (points, y-down, origin at the
 * first artboard's top-left corner). Omitting both handles makes the anchor
 * a hard corner; supplying both makes it a smooth (C1) join unless
 * `smooth: false` is set.
 */
const AnchorSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  in: z.tuple([z.number(), z.number()]).optional(),
  out: z.tuple([z.number(), z.number()]).optional(),
  smooth: z.boolean().optional(),
});
type Anchor = z.infer<typeof AnchorSchema>;

/** A gradient stop as consumed by `paint.setFill`. */
const GradientStopSchema = z.object({
  offset: z.number().min(0).max(1),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  opacity: z.number().min(0).max(1).optional(),
  midpoint: z.number().min(0.13).max(0.87).optional(),
});

/** Parameters accepted by `paint.setFill` for a linear gradient. */
const GradientSchema = z.object({
  kind: z.enum(["linear", "radial", "freeform"]).default("linear"),
  stops: z.array(GradientStopSchema).min(2).max(32),
  angle: z.number().min(-360).max(360).default(90),
  aspect: z.number().optional(),
});

/**
 * The tenant-facing request payload. This is the schema enforced by the
 * public `/v1/logos` API endpoint; the worker reads it verbatim from the
 * job queue.
 */
const LogoRequestSchema = z.object({
  tenantId: z.string().min(1).max(64),
  sku: z.string().min(1).max(64),
  correlationId: z.string().uuid(),

  // Palette
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  secondaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),

  // Geometry
  petals: z.number().int().min(3).max(24).default(10),
  blendSteps: z.number().int().min(2).max(64).default(24),
  offsetDistance: z.number().min(0).max(48).default(5),

  // Canvas
  artboardWidth: z.number().int().positive().max(8192).default(1200),
  artboardHeight: z.number().int().positive().max(8192).default(1200),

  // Storage
  exportDir: z.string().min(1).default("/work/vectorforge/out"),
});
type LogoRequest = z.infer<typeof LogoRequestSchema>;

// ============================================================================
// 2. RESULT SHAPES — VectorCraft returns `{id: number}` from creation
//    commands and `{ids: number[]}` from bulk operations. We wrap them so
//    that downstream code never touches untyped JSON.
// ============================================================================

const CreatedObjectSchema = z.object({ id: z.number().int().nonnegative() });
const ObjectListSchema = z.object({ ids: z.array(z.number().int().nonnegative()) });
const DocumentNodeSchema = z.object({
  id: z.number().int().nonnegative(),
  name: z.string(),
  kind: z.string(),
  bounds: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    })
    .optional(),
});

// ============================================================================
// 3. THE SERVICE
// ============================================================================

/**
 * VectorForgeService
 * ------------------
 * Owns a single MCP session to one VectorCraft process. It is *not* thread
 * safe in isolation — the SaaS layer instantiates one instance per worker
 * child process and relies on Node's worker_threads isolation for parallel
 * jobs. That gives us clean teardown semantics: killing the child kills the
 * engine and all its scratch memory.
 */
export class VectorForgeService {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;

  /** Per-request monotonically increasing counter used for idempotency logs. */
  private seq = 0;

  /**
   * Bootstraps the stdio transport and completes the MCP initialization
   * handshake. Must be awaited before any `synthesize()` call.
   *
   * @param binary  Absolute path to `vectorcraft-cli` (default: PATH lookup).
   * @param readRoot  Sandbox read root; the engine refuses reads outside it.
   * @param writeRoot Sandbox write root; the engine refuses writes outside it.
   */
  async connect(opts: {
    binary?: string;
    readRoot: string;
    writeRoot: string;
  }): Promise<void> {
    this.transport = new StdioClientTransport({
      command: opts.binary ?? "vectorcraft-cli",
      args: [
        "mcp",
        "--automation-read-root",
        opts.readRoot,
        "--automation-write-root",
        opts.writeRoot,
      ],
      // Inherit stderr so engine warnings surface in the worker log.
      stderr: "inherit",
    });

    this.client = new Client(
      { name: "vectorforge-worker", version: "1.4.0" },
      { capabilities: {} }
    );

    await this.client.connect(this.transport);
  }

  /**
   * Disposes the session cleanly. Always invoke this from a `finally` block
   * so a hung child process never blocks a pool slot.
   */
  async disconnect(): Promise<void> {
    try {
      await this.client?.close();
    } finally {
      this.client = null;
      this.transport = null;
    }
  }

  /**
   * Low-level wrapper around `command_run`. It parses the MCP content
   * envelope, extracts the JSON payload, and returns it as `unknown`.
   *
   * @throws If the engine returned an error, the call is re-thrown with the
   *         command id prepended so logs immediately show which registry
   *         entry failed.
   */
  private async run<T = unknown>(
    id: string,
    params: Record<string, unknown> = {}
  ): Promise<T> {
    if (!this.client) throw new Error("VectorForgeService: not connected");

    const started = Date.now();
    try {
      const res = await this.client.callTool({
        name: "command_run",
        arguments: { id, params },
      });

      // MCP returns `content: [{type:"text", text:"<json>"}]`. VectorCraft
      // also returns `isError` when the engine refused the command.
      const first = Array.isArray(res.content) ? res.content[0] : undefined;
      const text =
        first && typeof first === "object" && "text" in first
          ? String((first as { text: unknown }).text)
          : "{}";

      if (res.isError) {
        throw new Error(`[${id}] engine refused: ${text}`);
      }

      return JSON.parse(text) as T;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `command_run(${id}) failed after ${Date.now() - started}ms: ${message}`
      );
    } finally {
      this.seq += 1;
    }
  }

  /**
   * Atomic batch dispatcher. Every step inside a single `command_batch`
   * call is one undoable transaction; if one step throws, the engine rolls
   * the document back to the pre-batch state, leaving no half-built geometry.
   *
   * @param steps  Ordered list of `{id, params}` pairs.
   * @param label  Undo-step label recorded in the engine's history ring.
   */
  private async batch(
    steps: Array<{ id: string; params?: Record<string, unknown> }>,
    label?: string
  ): Promise<unknown[]> {
    if (!this.client) throw new Error("VectorForgeService: not connected");
    const res = await this.client.callTool({
      name: "command_batch",
      arguments: { steps, label, atomic: true },
    });
    const first = Array.isArray(res.content) ? res.content[0] : undefined;
    const text =
      first && typeof first === "object" && "text" in first
        ? String((first as { text: unknown }).text)
        : "{}";
    const parsed = JSON.parse(text) as { results?: unknown[] };
    return parsed.results ?? [];
  }

  // --------------------------------------------------------------------------
  // 3.1 Bézier primitives
  // --------------------------------------------------------------------------

  /**
   * Rotates a polar coordinate into Cartesian document space.
   *
   * The engine operates in a y-down coordinate system identical to SVG and
   * PDF, so a positive angle sweeps clockwise on screen. We keep all our
   * geometry in this system and never convert; the pipeline is consistent
   * from the first Bézier anchor to the exported SVG `d=""` attribute.
   */
  private static polar(
    cx: number,
    cy: number,
    r: number,
    thetaRadians: number
  ): [number, number] {
    return [cx + r * Math.cos(thetaRadians), cy + r * Math.sin(thetaRadians)];
  }

  /**
   * Builds one "petal" — a closed cubic Bézier outline approximating a
   * teardrop with a sharp interior cusp and a softened outer arc.
   *
   * The petal is defined in isolation, centred at the origin, then placed
   * on the canvas via the `transform` tool. This decouples the *shape* of
   * the petal (pure math) from its *rotation and translation* (an affine
   * matrix applied by the engine). It is the same technique the desktop
   * Pen tool uses, and it is what makes the parallel loop further down so
   * cheap: each petal is a fresh path command plus one matrix.
   *
   * @param length   Distance from the cusp to the tip of the petal.
   * @param halfW    Half-width of the petal at its widest point.
   * @param bulge    How much the outer arc bulges outward (0 = flat, 1 = round).
   */
  private static petalAnchors(
    length: number,
    halfW: number,
    bulge: number
  ): Anchor[] {
    // Cusp anchor: sharp, no handles.
    const cusp: Anchor = { x: 0, y: 0 };

    // Right side of the petal — a smooth anchor with an "in" handle that
    // continues the curve from the cusp radius and an "out" handle that
    // launches it toward the tip.
    const right: Anchor = {
      x: halfW,
      y: length * 0.35,
      in: [halfW * 0.9, length * 0.1],
      out: [halfW * (1 + bulge * 0.35), length * 0.6],
      smooth: true,
    };

    // Tip anchor: a smooth apex. The two handles both point inward along
    // the axis, ensuring the tangent at the tip is horizontal (perpendicular
    // to the petal axis).
    const tip: Anchor = {
      x: 0,
      y: length,
      in: [halfW * (1 - bulge * 0.55), length * 0.96],
      out: [-halfW * (1 - bulge * 0.55), length * 0.96],
      smooth: true,
    };

    // Left side: mirror of `right` across the axis.
    const left: Anchor = {
      x: -halfW,
      y: length * 0.35,
      in: [-halfW * (1 + bulge * 0.35), length * 0.6],
      out: [-halfW * 0.9, length * 0.1],
      smooth: true,
    };

    return [cusp, right, tip, left];
  }

  /**
   * Builds a background "shield" path: a rounded nonagon defined entirely
   * by cubic Béziers. It demonstrates a second Bézier topology — many
   * anchors arranged in a ring, each with handles tangent to the ring —
   * which produces a smooth, organic container for the petals.
   *
   * @param cx      Centre x.
   * @param cy      Centre y.
   * @param radius  Ring radius.
   * @param sides   Number of anchors around the ring.
   * @param k       Tangent handle length as a fraction of the chord.
   */
  private static shieldAnchors(
    cx: number,
    cy: number,
    radius: number,
    sides: number,
    k = 0.36
  ): Anchor[] {
    const anchors: Anchor[] = [];
    const step = (Math.PI * 2) / sides;
    // Chord length between adjacent anchors.
    const chord = 2 * radius * Math.sin(step / 2);
    const handle = chord * k;

    for (let i = 0; i < sides; i++) {
      const theta = i * step - Math.PI / 2;
      const [x, y] = VectorForgeService.polar(cx, cy, radius, theta);

      // Tangent direction: perpendicular to the radius vector.
      // For a circle centred at (cx, cy) traced counter-clockwise, the
      // tangent vector at theta is (-sin, cos) scaled by the ring radius.
      const tx = -Math.sin(theta);
      const ty = Math.cos(theta);

      anchors.push({
        x,
        y,
        in: [x - tx * handle, y - ty * handle],
        out: [x + tx * handle, y + ty * handle],
        smooth: true,
      });
    }
    return anchors;
  }

  // --------------------------------------------------------------------------
  // 3.2 Synthesis pipeline
  // --------------------------------------------------------------------------

  /**
   * The top-level synthesis entry point. Consumes a validated `LogoRequest`
   * and returns the case-relative paths of the two exported artifacts.
   *
   * The pipeline is strictly ordered: document creation → background layer →
   * background geometry → petal layer → N petals → blend accents → Pathfinder
   * booleans → gradient paint → outline offset → export. Every step that
   * mutates the document is a discrete engine command, so any intermediate
   * state can be inspected with `inspect_document` for debugging.
   */
  async synthesize(request: z.input<typeof LogoRequestSchema>): Promise<{
    svg: string;
    png: string;
    rootIds: number[];
    bytes: { svg: number; png: number };
  }> {
    const req = LogoRequestSchema.parse(request);
    const {
      artboardWidth: W,
      artboardHeight: H,
      petals,
      blendSteps,
      offsetDistance,
      exportDir,
      primaryColor,
      secondaryColor,
      accentColor,
      sku,
      correlationId,
    } = req;

    const cx = W / 2;
    const cy = H / 2;

    // ------------------------------------------------------------------
    // Step 1 — Create the artboard. Everything downstream assumes the
    // document reports artboard 0 as W×H in points (72 ppi). We use
    // `colorMode: "rgb"` because the whole pipeline is screen-first;
    // CMYK is only applied further downstream if the tenant asks for
    // print-ready output, at which point a separate exporter runs.
    // ------------------------------------------------------------------
    await this.run("file.new", {
      name: `vectorforge-${sku}`,
      width: W,
      height: H,
      artboards: 1,
      units: "Pixels",
      colorMode: "rgb",
      backgroundContents: "transparent",
      rasterEffectsPpi: 300,
    });

    // ------------------------------------------------------------------
    // Step 2 — Background layer. Layers keep the object graph organised
    // and, more importantly for us, they make the exported PSD (if the
    // tenant asks for it) trivially decomposable.
    // ------------------------------------------------------------------
    // `layer.new { top: true }` inserts the new layer *directly above the
    // current one*, so the layer created last ends up lower in the stack.
    // The petals are therefore created first: they have to sit above the
    // background shield, and the aura has to sit below both.
    await this.run("layer.new", { name: "petals", top: true });
    await this.run("layer.new", { name: "background", top: true });

    // Background shield geometry — 9-sided rounded nonagon, sized to sit
    // inside the ring of petals rather than to cover it.
    const shield = VectorForgeService.shieldAnchors(cx, cy, Math.min(W, H) * 0.22, 9);
    const shieldRes = CreatedObjectSchema.parse(
      await this.run("path.create", {
        anchors: shield,
        closed: true,
      })
    );

    // Paint the shield with a two-stop linear gradient derived from the
    // tenant palette. The engine stores the gradient as an unnamed local
    // fill on the shield object; it is not promoted to a document swatch
    // because the SaaS layer treats each request as fully self-contained.
    await this.run("paint.setFill", {
      ids: [shieldRes.id],
      gradient: {
        kind: "linear",
        angle: 135,
        stops: [
          { offset: 0.0, color: primaryColor },
          { offset: 1.0, color: secondaryColor },
        ],
      },
    });

    // No stroke on the shield — the outline treatment comes later, on the
    // composite, so that the offset path wraps the *union* rather than
    // the shield in isolation.
    await this.run("paint.setStroke", { ids: [shieldRes.id], none: true });

    // ------------------------------------------------------------------
    // Step 3 — Petal layer. All petals live in their own layer so that a
    // single `object.pathfinder.unite` can select the whole layer's
    // contents, or, as we do below, so that we can iterate over ids.
    // ------------------------------------------------------------------
    const petalLength = Math.min(W, H) * 0.36;
    const petalHalfW = petalLength * 0.26;
    const baseAnchors = VectorForgeService.petalAnchors(petalLength, petalHalfW, 0.6);

    const petalIds: number[] = [];
    for (let i = 0; i < petals; i++) {
      // Alternate the petal silhouette based on index parity to break the
      // perfect symmetry that a purely polar construction would produce.
      // Even petals are slim and tall; odd petals are short and wide.
      const scale = i % 2 === 0 ? 1.0 : 0.78;
      const rotDeg = (360 / petals) * i + (i % 2 === 0 ? 0 : 180 / petals);

      const created = CreatedObjectSchema.parse(
        await this.run("path.create", {
          anchors: baseAnchors.map((a) => ({
            x: a.x * scale,
            y: a.y * scale,
            in: a.in ? [a.in[0] * scale, a.in[1] * scale] : undefined,
            out: a.out ? [a.out[0] * scale, a.out[1] * scale] : undefined,
            smooth: a.smooth,
          })),
          closed: true,
        })
      );

      // The transform tool applies a Cartesian composition to the object
      // relative to `origin`. Because our petals are authored at (0, 0),
      // rotating them about (0, 0) and then translating to (cx, cy)
      // places each petal with a single command. The engine has no
      // `object.transform` command: the geometry lives in the `transform`
      // tool and in the `transform.set` / `transform.scale` commands, and
      // the high-level tool is preferred because it round-trips through the
      // UI's transform panel identically, which keeps the two paths
      // bit-for-bit compatible.
      await this.client!.callTool({
        name: "transform",
        arguments: {
          ids: [created.id],
          rotate: rotDeg,
          origin: [0, 0],
        },
      });
      await this.client!.callTool({
        name: "transform",
        arguments: {
          ids: [created.id],
          dx: cx,
          dy: cy,
        },
      });

      petalIds.push(created.id);
    }

    // ------------------------------------------------------------------
    // Step 4 — Live blend. A blend node preserves the interpolation as a
    // non-destructive operation: the anchor counts of the two key objects
    // do not have to match, and editing either key re-evaluates the whole
    // sequence. This is the vector equivalent of a tween in a timeline,
    // except it is stored *inside* the artwork, not produced by a script.
    //
    // We blend two accent stars — a 5-point and a 7-point — behind the
    // shield, producing an aura of 24 intermediate interpolations. The
    // blend result is left live (we do not expand it) so the export
    // pipeline can still refine it at print time.
    // ------------------------------------------------------------------
    await this.run("layer.new", { name: "aura", top: false });

    const starA = CreatedObjectSchema.parse(
      await this.run("shape.star", {
        cx,
        cy,
        radius1: Math.min(W, H) * 0.48,
        radius2: Math.min(W, H) * 0.30,
        points: 5,
        rotation: -90,
      })
    );
    const starB = CreatedObjectSchema.parse(
      await this.run("shape.star", {
        cx,
        cy,
        radius1: Math.min(W, H) * 0.40,
        radius2: Math.min(W, H) * 0.26,
        points: 7,
        rotation: 90,
      })
    );

    // Assign the two keys the tenant's accent colours so the blend sweeps
    // through the palette. Key A gets the primary, key B the accent.
    await this.run("paint.setFill", {
      ids: [starA.id],
      color: primaryColor,
    });
    await this.run("paint.setFill", {
      ids: [starB.id],
      color: accentColor,
    });
    await this.run("paint.setStroke", {
      ids: [starA.id, starB.id],
      none: true,
    });

    // `object.blend.make` requires the keys to be in paint order; we
    // pass ids explicitly to avoid depending on the current selection.
    const blendResult = CreatedObjectSchema.parse(
      await this.run("object.blend.make", {
        ids: [starA.id, starB.id],
        steps: blendSteps,
        orientation: "page",
      })
    );

    // Set the blend to "steps" spacing so the intermediate count is
    // exactly `blendSteps`, not a distance-derived approximation. The
    // default when no options are set is "smooth" which can produce
    // visibly uneven distributions on non-uniform geometry.
    await this.run("object.blend.options", {
      spacing: "steps",
      steps: blendSteps,
      orientation: "page",
    });

    await this.run("object.setProps", {
      ids: [blendResult.id],
      name: "aura-blend",
      opacity: 0.22,
      blend: "screen",
      isolate: true,
    });

    // ------------------------------------------------------------------
    // Step 5 — Pathfinder: union the petals into a single composite path.
    // Union is computed as a planar arrangement in the engine, not as a
    // raster OR, and the result carries the topology forward: the anchor
    // order survives, holes are preserved as subpaths, and the winding
    // rule is corrected to non-zero where the union requires it.
    // ------------------------------------------------------------------
    await this.run("select.set", { ids: petalIds });

    const united = ObjectListSchema.parse(
      await this.run("object.pathfinder.unite", {})
    );
    const compositeId = united.ids[0]!;

    // ------------------------------------------------------------------
    // Step 6 — Pathfinder: subtract a small circular well from the centre
    // of the composite to create the "eye" of the mandala. `minusFront`
    // removes the topmost selected object from what lies below.
    // ------------------------------------------------------------------
    const eyeHole = CreatedObjectSchema.parse(
      await this.run("shape.ellipse", {
        x: cx - petalLength * 0.14,
        y: cy - petalLength * 0.14,
        width: petalLength * 0.28,
        height: petalLength * 0.28,
      })
    );

    // A destructive Pathfinder command consumes its operands: the composite
    // that came out of the union no longer exists once the well is punched
    // out of it, and the engine returns the id of the new shape.
    await this.run("select.set", { ids: [eyeHole.id, compositeId] });
    const punched = ObjectListSchema.parse(
      await this.run("object.pathfinder.minusFront", {})
    );
    const punchedId = punched.ids[0]!;

    // ------------------------------------------------------------------
    // Step 7 — Pathfinder: intersect the punched composite with a
    // larger circular mask so that everything outside the brand
    // circumference is trimmed. This gives the composite a crisp outer
    // boundary without a clipping mask — a real geometric edit.
    // ------------------------------------------------------------------
    const maskCircle = CreatedObjectSchema.parse(
      await this.run("shape.ellipse", {
        x: cx - Math.min(W, H) * 0.46,
        y: cy - Math.min(W, H) * 0.46,
        width: Math.min(W, H) * 0.92,
        height: Math.min(W, H) * 0.92,
      })
    );

    await this.run("select.set", { ids: [punchedId, maskCircle.id] });
    const trimmed = ObjectListSchema.parse(
      await this.run("object.pathfinder.intersect", {})
    );
    const finalCompositeId = trimmed.ids[0]!;

    // ------------------------------------------------------------------
    // Step 8 — Offset path for the outer ornament. The offset command
    // generates a *new* path object whose geometry is the Minkowski
    // sum of the input with a disc of radius `offset` (or the exact
    // parallel curve with miter joins if joins: "miter"). We use
    // `object.path.offsetPath`, which is the same primitive the desktop
    // Object → Path → Offset Path… dialog drives.
    // ------------------------------------------------------------------
    await this.run("select.set", { ids: [finalCompositeId] });

    const offsets = ObjectListSchema.parse(
      await this.run("object.path.offsetPath", {
        offset: offsetDistance,
        joins: "round",
      })
    );
    const outlineId = offsets.ids[0]!;

    await this.run("paint.setStroke", {
      ids: [outlineId],
      color: accentColor,
    });
    await this.run("stroke.set", {
      ids: [outlineId],
      weight: 2,
      align: "outside",
      join: "round",
    });
    await this.run("paint.setFill", { ids: [outlineId], none: true });

    // ------------------------------------------------------------------
    // Step 9 — Fill the composite with a radial gradient. The gradient
    // vector is anchored to the composite's visual bounds automatically
    // because we omit `start`/`end`; the engine fits the gradient to
    // each object's own bounding box, which is the behaviour the
    // Gradient panel's "Apply to each object independently" toggle
    // exposes.
    // ------------------------------------------------------------------
    await this.run("paint.setFill", {
      ids: [finalCompositeId],
      gradient: {
        kind: "radial",
        stops: [
          { offset: 0.0, color: accentColor },
          { offset: 0.55, color: primaryColor },
          { offset: 1.0, color: secondaryColor },
        ],
      },
    });

    // ------------------------------------------------------------------
    // Step 10 — Cleanup with an atomic batch. Isolating every final
    // cosmetic mutation inside one `command_batch` call means the
    // undo history of the artwork records "VectorForge: finish" as a
    // single step, not ten, and any failure rolls back cleanly. This
    // matters for the UI-embedded preview case: an operator can open
    // the synthesized document in the desktop app and undo the last
    // cosmetic pass in one keystroke.
    // ------------------------------------------------------------------
    await this.batch(
      [
        {
          id: "object.setProps",
          params: { ids: [finalCompositeId], name: "composite", opacity: 1 },
        },
        {
          id: "object.setProps",
          params: { ids: [outlineId], name: "ornament", opacity: 0.9 },
        },
        {
          id: "object.align",
          params: { horizontal: "center", vertical: "center", to: "artboard" },
        },
      ],
      "VectorForge: finish"
    );

    // ------------------------------------------------------------------
    // Step 11 — Export. SVG is the primary artifact; PNG is a raster
    // fallback for preview cards in the SaaS UI. Both files land under
    // the sandboxed write root; the paths returned by the engine are
    // absolute, but we rebase them for the caller.
    // ------------------------------------------------------------------
    const svgPath = `${exportDir}/${sku}.svg`;
    const pngPath = `${exportDir}/${sku}.png`;

    const svgExport = await this.run<{ path: string; bytes: number }>(
      "document.export",
      {
        path: svgPath,
        format: "svg",
        artboard: 0,
        outlineText: true, // no live text at this point, but harmless
      }
    );

    const pngExport = await this.run<{ path: string; bytes: number }>(
      "document.export",
      {
        path: pngPath,
        format: "png",
        artboard: 0,
        scale: 2, // 2× raster for retina previews
      }
    );

    // ------------------------------------------------------------------
    // Step 12 — Final structural inspection. The `doc_inspect` (VectorCraft
    // exposes it as `inspect_document`) response is the canonical source
    // of truth that the SaaS layer records alongside the artifact hash
    // so that future audits can validate that the on-disk SVG matches
    // the intended document tree.
    // ------------------------------------------------------------------
    const inspected = await this.client!.callTool({
      name: "inspect_document",
      arguments: { depth: 2 },
    });

    // Real production code would persist `inspected` to a Postgres JSONB
    // column, keyed by correlationId. Here we simply log a compact digest.
    const inspectText =
      Array.isArray(inspected.content) && inspected.content[0]
        ? JSON.stringify(inspected.content[0]).slice(0, 512)
        : "{}";
    console.log(
      `[vectorforge] correlationId=${correlationId} sku=${sku} ` +
        `svg=${svgExport.bytes}B png=${pngExport.bytes}B digest=${inspectText.slice(0, 128)}`
    );

    return {
      svg: svgExport.path,
      png: pngExport.path,
      rootIds: [shieldRes.id, finalCompositeId, outlineId, blendResult.id],
      bytes: { svg: svgExport.bytes, png: pngExport.bytes },
    };
  }
}

// ============================================================================
// 4. CLI ENTRY POINT
// ----------------------------------------------------------------------------
// The worker is designed to be launched by the SaaS job runner as a
// short-lived child process. It reads a single JSON request from stdin,
// synthesizes the asset, and exits. This "one job per process" model is
// deliberate: it eliminates shared mutable state, guarantees that engine
// memory is fully reclaimed by the OS on exit, and makes horizontal
// scaling a matter of spawning more workers.
// ============================================================================

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();

  if (!raw) {
    console.error("vectorforge: expected a JSON request on stdin");
    process.exit(2);
  }

  const parsed = LogoRequestSchema.parse(JSON.parse(raw));

  const service = new VectorForgeService();
  const readRoot = process.env.VECTORFORGE_READ_ROOT ?? "/work/vectorforge";
  const writeRoot = process.env.VECTORFORGE_WRITE_ROOT ?? "/work/vectorforge/out";

  try {
    await service.connect({ readRoot, writeRoot });
    const result = await service.synthesize(parsed);

    // The job runner consumes a JSON line on stdout; keep it on a single line.
    process.stdout.write(
      JSON.stringify({ ok: true, correlationId: parsed.correlationId, ...result }) + "\n"
    );
  } catch (err) {
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    process.stderr.write(`vectorforge: synthesis failed\n${message}\n`);
    process.stdout.write(
      JSON.stringify({
        ok: false,
        correlationId: parsed.correlationId,
        error: message,
      }) + "\n"
    );
    process.exitCode = 1;
  } finally {
    await service.disconnect();
  }
}

// Execute when invoked directly (`node dist/vectorforge-logo-synthesis.js`).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
