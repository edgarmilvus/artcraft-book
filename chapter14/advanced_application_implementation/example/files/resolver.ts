// ---------------------------------------------------------------------------
// resolver.ts — turns human-readable names into canonical engine paths.
// ---------------------------------------------------------------------------
import {
  EffectCraftError,
  type EffectCraftSession,
  type LayerPropertyNode,
} from "./session.js";

/** A flattened, searchable view of one layer's property tree. */
interface FlatNode {
  path: string;
  name: string;
  matchId: string;
  type: string;
  keyframeCount: number;
  hasExpression: boolean;
}

/**
 * Depth-first walk of a `get_layer` tree, emitting one row per node.
 *
 * Iterative rather than recursive: shape rigs routinely nest four or five
 * levels (group → rect → trim → …) and a runaway recursion inside a render
 * worker is a process-killer, not a stack trace.
 */
function flattenTree(layer: LayerPropertyNode): FlatNode[] {
  const out: FlatNode[] = [];
  // The layer's property tree hangs under `properties`; the node itself is
  // the layer, not a property.
  const root = (layer as unknown as { properties?: LayerPropertyNode }).properties ?? layer;
  const stack: LayerPropertyNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    out.push({
      path: node.path,
      name: node.name,
      matchId: node.matchId,
      type: node.type,
      keyframeCount: node.keyframes?.length ?? 0,
      hasExpression: Boolean(node.expression),
    });
    if (node.children) {
      // Push in reverse so the traversal order is stable and predictable.
      for (let i = node.children.length - 1; i >= 0; i--) {
        const child = node.children[i];
        if (child) stack.push(child);
      }
    }
  }
  return out;
}

/**
 * Resolves property paths for a document, memoised per layer.
 *
 * The cache is keyed by layer id and invalidated explicitly whenever the
 * compiler structurally changes a layer (adding shape items, applying an
 * effect). Structural mutation is the *only* thing that can invalidate a
 * path, so coarse invalidation is correct here and far simpler than trying
 * to diff property trees.
 */
export class PropertyPathResolver {
  private readonly cache = new Map<string, FlatNode[]>();

  constructor(private readonly session: EffectCraftSession) {}

  /** Drops the cached tree for a layer, or for everything. */
  public invalidate(layer?: number | string): void {
    if (layer === undefined) this.cache.clear();
    else this.cache.delete(String(layer));
  }

  private async tree(layer: number | string): Promise<FlatNode[]> {
    const key = String(layer);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const root = await this.session.getLayer({ layer, flat: false });
    const flat = flattenTree(root);
    this.cache.set(key, flat);
    return flat;
  }

  /**
   * Finds the canonical `path` of a property by regex against its node name.
   *
   * @param layer   Layer id, `"#n"` index, or layer name.
   * @param nameRe  Case-insensitive pattern, e.g. /^trim end$/i
   * @param opts.nth  1-based occurrence, for documents with repeats.
   * @throws EffectCraftError when the property does not exist — always better
   *         than silently writing to a wrong path.
   */
  public async resolve(
    layer: number | string,
    nameRe: RegExp,
    opts: { nth?: number; requireKeyframable?: boolean } = {},
  ): Promise<string> {
    const rows = await this.tree(layer);
    const matches = rows.filter((r) => nameRe.test(r.name));
    const nth = opts.nth ?? 1;
    const hit = matches[nth - 1];
    if (!hit) {
      throw new EffectCraftError(
        `Property matching ${nameRe} (#${nth}) not found on layer ${String(layer)}; ` +
          `available: ${rows.map((r) => r.name).slice(0, 40).join(", ")}`,
        "get_layer",
      );
    }
    return hit.path;
  }

  /**
   * Finds the canonical `path` of a property by regex against the path.
   *
   * The path is the unambiguous identifier: a layer can carry a dozen
   * properties called "Start" — one per group — but only one
   * `contents/trim/start`.
   *
   * @param layer   Layer id, `"#n"` index, or layer name.
   * @param pathRe  Case-insensitive pattern, e.g. /^contents\/trim\/end$/i
   * @throws EffectCraftError when the property does not exist.
   */
  public async resolvePath(
    layer: number | string,
    pathRe: RegExp,
  ): Promise<string> {
    const rows = await this.tree(layer);
    const hit = rows.find((r) => pathRe.test(r.path));
    if (!hit) {
      throw new EffectCraftError(
        `Property path matching ${pathRe} not found on layer ${String(layer)}; ` +
          `available: ${rows.map((r) => r.path).slice(0, 40).join(", ")}`,
        "get_layer",
      );
    }
    return hit.path;
  }

  /**
   * Returns every effect-instance path on a layer, in stack order.
   * Effect paths are stable (`effects/#1`, `effects/#2`, …) but the *index*
   * depends on application order, so we indirection through this helper.
   */
  public async effectPaths(layer: number | string): Promise<string[]> {
    const rows = await this.tree(layer);
    return rows
      .filter((r) => /^effects\/#\d+$/.test(r.path))
      .map((r) => r.path)
      .sort((a, b) => {
        const ai = Number((a.split("/")[1] ?? "0").slice(1));
        const bi = Number((b.split("/")[1] ?? "0").slice(1));
        return ai - bi;
      });
  }
}
