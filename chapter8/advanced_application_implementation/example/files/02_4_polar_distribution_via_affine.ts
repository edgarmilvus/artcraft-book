/**
 * polar-distribution.ts (excerpt from the worker's placement stage)
 * ------------------------------------------------------------------
 * A petal is created at the origin and then moved onto the ring: first it
 * is rotated by its polar angle, then translated by the centre of the
 * artboard. The two calls are separate because `transform` applies one
 * transformation per command.
 */

export interface TransformCall {
  ids: number[];
  rotate?: number;
  origin?: [number, number];
  dx?: number;
  dy?: number;
}

export type Transform = (call: TransformCall) => Promise<unknown>;

export async function placeOnRing(
  transform: Transform,
  created: { id: number },
  rotDeg: number,
  cx: number,
  cy: number,
): Promise<void> {
  await transform({ ids: [created.id], rotate: rotDeg, origin: [0, 0] });
  await transform({ ids: [created.id], dx: cx, dy: cy });
}
