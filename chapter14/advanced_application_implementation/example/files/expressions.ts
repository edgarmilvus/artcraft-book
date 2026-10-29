// ---------------------------------------------------------------------------
// expressions.ts — reusable, deterministic expression fragments.
// ---------------------------------------------------------------------------
import type { EffectCraftSession } from "./session.js";
import type { PropertyPathResolver } from "./resolver.js";

/**
 * A seeded, deterministic wiggle.
 *
 * `wiggle()` in the base expression language draws from an internal noise
 * field keyed on the layer's index. Layer indices are stable within a
 * compilation but NOT across compilations, which would make renders
 * non-reproducible — unacceptable for a cache keyed on request content.
 * We therefore derive the seed from the request id and pass it through the
 * `seedRandom` call, pinning the noise field to the tenant's request.
 */
export function seededWiggle(
  requestSeed: number,
  frequencyPerSecond: number,
  amplitudePx: number,
): string {
  return [
    `seedRandom(${requestSeed}, true);`,
    `wiggle(${frequencyPerSecond}, ${amplitudePx});`,
  ].join("\n");
}

/**
 * A bounce-out overshoot with a settable amplitude and settle time.
 *
 * This is a hand-rolled critically-underdamped spring rather than a keyframe
 * curve, because the number of overshoot cycles should scale with the
 * available time — a 300 ms entry gets one crisp overshoot, a 900 ms entry
 * gets three decaying ones, and the author should not have to author both.
 */
export function overshoot(
  fromPx: number,
  toPx: number,
  durationSec: number,
  overshootRatio = 0.18,
  damping = 5.2,
): string {
  const delta = toPx - fromPx;
  return [
    `var $t = Math.min(1, (time - inPoint) / ${durationSec});`,
    `var $omega = ${damping} * Math.PI * 2;`,
    `var $decay = Math.exp(-$omega * $t);`,
    `var $osc = Math.cos($omega * $t) + ${damping} * Math.sin($omega * $t);`,
    `${fromPx} + ${delta} * (1 - $decay * $osc) + $decay * ${overshootRatio} * ${delta};`,
  ].join("\n");
}

/**
 * Loops a pre-comp's time so a background gradient cycles forever regardless
 * of the host composition's duration. `loopOut("cycle")` is the idiomatic
 * form; we wrap it so the intent is documented at the call site.
 */
export function infiniteCycle(): string {
  return `loopOut("cycle");`;
}

/**
 * The headline-width coupling used by the accent-bar rig. `sourceText` is
 * read from the text layer and measured in the composition's own units, then
 * padded. If the text layer reflows (font substitution, tracking change),
 * the bar follows automatically on the very next evaluated frame.
 */
export function barWidthFromText(
  sourceLayerName: string,
  horizontalPaddingPx: number,
  minWidthPx: number,
): string {
  return [
    `var $src = thisComp.layer(${JSON.stringify(sourceLayerName)});`,
    `var $w = $src.sourceRectAtTime(time, false).width;`,
    `Math.max(${minWidthPx}, $w + ${horizontalPaddingPx * 2});`,
  ].join("\n");
}

/**
 * Attaches an expression to a property, resolving the path first.
 *
 * Expressions are attached with `set_property`'s `expression` field rather
 * than with the `prop.setExpression` command, because `set_property` also
 * returns the resulting property node — one round trip instead of two.
 */
export async function attachExpression(
  session: EffectCraftSession,
  resolver: PropertyPathResolver,
  layer: number | string,
  nameRe: RegExp,
  expression: string,
  opts: { nth?: number } = {},
): Promise<void> {
  const path = await resolver.resolve(layer, nameRe, opts);
  await session.setProperty({ layer, path, expression });
  resolver.invalidate(layer);
}
