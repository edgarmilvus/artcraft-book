// ---------------------------------------------------------------------------
// compiler.ts — lowers a validated TemplateRequest into a rigged composition.
// ---------------------------------------------------------------------------
import type { TemplateRequest } from "./contracts.js";
import { compileTrack, type CompiledTrack } from "./graph.js";
import {
  attachExpression,
  barWidthFromText,
  overshoot,
  seededWiggle,
} from "./expressions.js";
import { buildLowerThirdRig, type LowerThirdRig } from "./rig.js";
import { animateTrim, buildTrimmedRect, type ShapeRig } from "./shape.js";
import type { EffectCraftSession } from "./session.js";
import { PropertyPathResolver } from "./resolver.js";

/** Everything the render stage needs to know about the compiled comp. */
export interface CompiledTemplate {
  compId: number | string;
  rig: LowerThirdRig;
  accentShape: ShapeRig;
  /** Total composition duration in seconds. */
  durationSec: number;
  /** Deterministic seed derived from the request, reused by every expression. */
  seed: number;
}

/**
 * Derives a 31-bit deterministic seed from the request id.
 *
 * FNV-1a is chosen over a cryptographic hash because it is allocation-free,
 * dependency-free, and the seed's only job is to make noise fields stable
 * across replays of the same request — it is not a security boundary.
 */
function seedFrom(requestId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < requestId.length; i++) {
    h ^= requestId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h & 0x7fffffff;
}

/**
 * Compiles the workspace template.
 *
 * @param session  Connected MCP session (one per worker).
 * @param req      Already-validated request.
 */
export async function compileTemplate(
  session: EffectCraftSession,
  req: TemplateRequest,
): Promise<CompiledTemplate> {
  const resolver = new PropertyPathResolver(session);
  const seed = seedFrom(req.requestId);

  // ------------------------------------------------------------------
  // 1. Composition. Duration is entry + hold + exit, converted to seconds
  //    and padded by two frames so the final held frame is never clipped.
  // ------------------------------------------------------------------
  const framePad = 2 / req.frameRate;
  const durationSec =
    (req.content.enterMs + req.content.holdMs + req.content.exitMs) / 1000 + framePad;

  const comp = await session.runCommand<{ comp: number | string }>("comp.new", {
    name: `${req.tenantId} · lower-third/v3`,
    width: req.width,
    height: req.height,
    frameRate: req.frameRate,
    duration: durationSec,
    background: [0, 0, 0, 0], // transparent; the scrim supplies the tone
    renderer: "advanced3D",
  });

  // ------------------------------------------------------------------
  // 2. Rig topology. Origin is the card's anchor: left-of-centre, sitting a
  //    little below the optical centre line, which is where a lower-third
  //    reads best on a 16:9 frame with a lower safe area.
  // ------------------------------------------------------------------
  const rig = await buildLowerThirdRig(session, {
    originX: req.width * 0.33,
    originY: req.height * 0.72,
    cardWidth: req.width * 0.44,
    primaryInk: req.tokens.ink,
    accentColor: req.tokens.accent,
    fontFamily: req.tokens.fontFamily,
    eyebrowText: req.content.eyebrow,
    headlineText: req.content.headline,
    subheadText: req.content.subhead,
    scrimColor: "#000000",
  });

  // ------------------------------------------------------------------
  // 3. Accent underline: a stroked shape with a trim-path operator.
  // ------------------------------------------------------------------
  const accentShape = await buildTrimmedRect(session, resolver, {
    name: "SHAPE · Underline",
    position: [0, 108],
    size: [req.width * 0.44, 6],
    strokeColor: req.tokens.accent,
    strokeWidth: 6,
    cornerRadius: 3,
  });

  // ------------------------------------------------------------------
  // 4. Parent the underline to the text column so it tracks the copy.
  //    Done AFTER construction so the shape's own coordinates stay authored
  //    in the column's local space, which is much easier to reason about.
  // ------------------------------------------------------------------
  await session.runCommand("layer.setParent", {
    layers: [accentShape.layer],
    parent: rig.textColumn,
  });

  // ------------------------------------------------------------------
  // 5. Value-graph tracks. Every track is compiled the same way: authored
  //    keys in, engine-ready key list plus per-side easing out.
  // ------------------------------------------------------------------
  const enterEnd = req.content.enterMs;
  const holdEnd = enterEnd + req.content.holdMs;
  const exitEnd = holdEnd + req.content.exitMs;

  const tracks: CompiledTrack[] = [
    // Master slide-in from the left, with a soft overshoot landing.
    compileTrack(
      "transform/position",
      [
        { atMs: 0, value: [-140, 0], out: { kind: "cubicBezier", p1x: 0.16, p1y: 1.0, p2x: 0.3, p2y: 1.0 }, in: { kind: "easyEase" } },
        { atMs: enterEnd, value: [0, 0], out: { kind: "linear" }, in: { kind: "linear" } },
      ],
      0,
    ),
    // Scrim fade-up and fade-down.
    compileTrack(
      "transform/opacity",
      [
        { atMs: 0, value: 0, out: { kind: "easyEase" }, in: { kind: "easyEase" } },
        { atMs: enterEnd * 0.6, value: 34, out: { kind: "linear" }, in: { kind: "linear" } },
        { atMs: holdEnd, value: 34, out: { kind: "easyEaseOut" }, in: { kind: "easyEase" } },
        { atMs: exitEnd, value: 0, out: { kind: "linear" }, in: { kind: "linear" } },
      ],
      0,
    ),
  ];

  // Emit every track. Values arrive as parallel arrays so a single batch can
  // carry them; the engine keys them onto the correct property.
  //
  // The engine writes one key per call, so a track of four keys is four
  // `prop.addKey` steps. The easing is applied afterwards: `keys.setEase`
  // writes the influence and the speed of one side of one key, while the
  // interpolation itself is a property of the *selection*, so it needs a
  // `keys.select` first.
  await session.batch(
    tracks.flatMap((t) => [
      {
        command: "prop.set",
        params: {
          layer: "RIG · Master",
          path: t.path,
          value: t.path === "transform/opacity" ? 0 : [0, 0],
          time: 0,
        },
      },
      ...t.keys.map((k) => ({
        command: "prop.addKey",
        params: {
          layer: "RIG · Master",
          path: t.path,
          time: k.time,
          value: k.value,
        },
      })),
      ...t.eases.flatMap((e) => {
        const key = { layer: "RIG · Master", prop: t.path, time: e.time };
        const steps: Array<{ command: string; params: Record<string, unknown> }> = [
          {
            command: "keys.setEase",
            params: {
              layer: "RIG · Master",
              path: t.path,
              time: e.time,
              side: e.side,
              influence: e.influence,
              ...(e.speed === undefined ? {} : { speed: e.speed }),
            },
          },
        ];
        // The interpolation is written to the selected keys, so the key has
        // to be selected first.
        steps.push({ command: "keys.select", params: { keys: [key] } });
        steps.push({
          command: "keys.interpolation",
          params: { [e.side]: e.interpolation },
        });
        return steps;
      }),
    ]),
    "Graph: master slide and scrim fade",
    /* atomic */ true,
  );

  // ------------------------------------------------------------------
  // 6. Trim-path draw and retract on the underline.
  // ------------------------------------------------------------------
  await animateTrim(
    session,
    accentShape,
    {
      drawStartMs: Math.round(enterEnd * 0.55),
      drawEndMs: enterEnd,
      retractStartMs: holdEnd,
      retractEndMs: exitEnd,
    },
    {
      draw: { kind: "cubicBezier", p1x: 0.22, p1y: 1.0, p2x: 0.36, p2y: 1.0 },
      retract: { kind: "easyEaseIn" },
    },
  );

  // ------------------------------------------------------------------
  // 7. Expressions. The accent bar's WIDTH tracks the headline's measured
  //    width, so a long headline reflows the bar without re-authoring.
  // ------------------------------------------------------------------
  await attachExpression(
    session,
    resolver,
    accentShape.layer,
    /^scale$/i,
    [
      `var $text = thisComp.layer("TXT · Headline");`,
      `var $w = $text.sourceRectAtTime(time, false).width;`,
      `var $target = Math.max(220, $w + 40);`,
      `var $base = ${JSON.stringify(req.width * 0.44)};`,
      `var $pct = ($target / $base) * 100;`,
      `[100, 100].map(function (v, i) { return i === 0 ? $pct : v; });`,
    ].join("\n"),
  );

  // Subtle seeded jitter on the accent bar's vertical offset gives the card
  // a "hand-placed" feel without introducing per-render randomness.
  await attachExpression(
    session,
    resolver,
    accentShape.layer,
    /^position$/i,
    [
      `var $base = value;`,
      seededWiggle(seed, 0.9, 1.5),
      `[$base[0], $base[1] + $wiggle];`,
    ].join("\n"),
  );

  // ------------------------------------------------------------------
  // 8. Markers. Downstream tooling — caption burn-in, social trims, the
  //    live preview scrubber — reads these instead of re-deriving timing.
  // ------------------------------------------------------------------
  await session.batch(
    [
      { command: "markers.set", params: { new: true, at: 0, comment: "ENTER", label: "Green" } },
      { command: "markers.set", params: { new: true, at: enterEnd / 1000, comment: "SETTLED", label: "Green" } },
      { command: "markers.set", params: { new: true, at: holdEnd / 1000, comment: "EXIT", label: "Red" } },
      { command: "markers.set", params: { new: true, at: exitEnd / 1000, comment: "CLEAR", label: "Red" } },
    ],
    "Markers: editorial beats",
    /* atomic */ false, // markers are independent; a partial set is still useful
  );

  // ------------------------------------------------------------------
  // 9. Emit one expression-driven overshoot on the text column's Y, proving
  //    the mixed keyframe/expression path works on the same rig.
  // ------------------------------------------------------------------
  await attachExpression(
    session,
    resolver,
    rig.textColumn,
    /^position$/i,
    overshoot(24, 0, enterEnd / 1000, 0.14, 6.1),
  );

  return {
    compId: comp.comp,
    rig,
    accentShape,
    durationSec,
    seed,
  };
}
