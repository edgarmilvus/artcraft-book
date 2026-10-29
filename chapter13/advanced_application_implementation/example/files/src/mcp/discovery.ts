// src/mcp/discovery.ts
import type { FilmCraftSession } from "./session.js";

export type WheelBand = "shadows" | "midtones" | "highlights";

/**
 * The concrete Lumetri parameter ids for the running binary.
 *
 * The engine exposes one colour vector per band (`wheel_shadows`) and one
 * luma offset per band (`wheel_shadows_l`). There is no separate hue and
 * saturation parameter: the colour vector carries both.
 */
export interface WheelParameterMap {
  readonly shadows: { readonly colour: string; readonly luma: string };
  readonly midtones: { readonly colour: string; readonly luma: string };
  readonly highlights: { readonly colour: string; readonly luma: string };
}

export interface LumetriDiscovery {
  /** The effect id the parameter commands want: "lumetri". */
  readonly effectId: string;
  /** The effect's display name: "Lumetri Color". */
  readonly effectName: string;
  readonly applyEffectId: string;
  readonly setParamId: string;
  readonly toggleAnimationId: string;
  readonly addKeyframeId: string;
  readonly wheelParams: WheelParameterMap;
}

interface EffectListing {
  readonly name?: string;
  readonly id?: string;
  readonly params?: unknown;
}

/**
 * Discover the concrete Lumetri parameter ids by asking the running engine.
 *
 * `effects.list { detail: true }` reports every effect with the parameter
 * names it accepts, so the mapping is resolved once at start-up instead of
 * being hard-coded. If a build renames a parameter, this is the single
 * place that has to change.
 */
export async function discoverLumetri(
  session: FilmCraftSession,
): Promise<LumetriDiscovery> {
  const listed = await session.run<EffectListing[] | { effects?: EffectListing[] }>(
    "effects.list",
    { kind: "Video", detail: true },
  );
  if (!listed.ok) {
    throw new Error(`lumetri: effects.list failed: ${listed.error}`);
  }

  const effects = Array.isArray(listed.result) ? listed.result : (listed.result.effects ?? []);
  const hit = effects.find(
    (e) =>
      e.name === "Lumetri Color" ||
      e.id === "lumetri" ||
      String(e.id ?? "").toLowerCase().endsWith("lumetri"),
  );
  if (!hit) {
    throw new Error("lumetri: this FilmCraft build has no Lumetri Color effect.");
  }

  // `detail: true` answers with the parameter names as an array.
  const names = new Set(
    Array.isArray(hit.params)
      ? hit.params.map((p) => String(p))
      : Object.keys(hit.params ?? {}),
  );

  const resolve = (band: WheelBand): { colour: string; luma: string } => {
    const colour = `wheel_${band}`;
    const luma = `${colour}_l`;
    if (!names.has(colour) || !names.has(luma)) {
      throw new Error(
        `lumetri: the build does not expose ${colour}/${luma}. Known: ${[...names].join(", ")}`,
      );
    }
    return { colour, luma };
  };

  return {
    effectId: hit.id ?? "lumetri",
    effectName: hit.name ?? "Lumetri Color",
    applyEffectId: "effects.apply",
    setParamId: "effects.setParam",
    toggleAnimationId: "effects.toggleAnimation",
    addKeyframeId: "effects.addKeyframe",
    wheelParams: {
      shadows: resolve("shadows"),
      midtones: resolve("midtones"),
      highlights: resolve("highlights"),
    },
  };
}
