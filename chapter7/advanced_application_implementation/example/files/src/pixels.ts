// ─── src/pixels.ts ───────────────────────────────────────────────────────────
// Minimal PNG decode using the `pngjs` package; kept isolated so it can be
// swapped for `sharp` or a WASM decoder without touching the loop.

import { PNG } from 'pngjs';

export interface RgbaFrame {
  data: Uint8Array;
  width: number;
  height: number;
}

/**
 * Decode base64 PNG to a raw RGBA frame. The orchestrator renders
 * previews at 1536 px on the long edge, so this is roughly 5 MB per
 * cycle — small enough to diff in memory, big enough to be meaningful.
 */
export function decodePngToRgba(base64: string): RgbaFrame {
  const buf = Buffer.from(base64, 'base64');
  const png = PNG.sync.read(buf);
  return {
    data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength),
    width: png.width,
    height: png.height,
  };
}

/**
 * Mean absolute difference between two RGBA buffers of the SAME length,
 * normalised to 0..1. If lengths differ, returns 1 (maximal delta).
 */
export function meanAbsoluteDelta(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return 1;
  if (a.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += Math.abs(a[i] - b[i]);
  }
  const mean = sum / a.length;      // 0..255
  return mean / 255;
}
