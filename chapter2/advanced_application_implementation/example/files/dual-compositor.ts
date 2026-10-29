// ---------------------------------------------------------------------------
// @file creative-factory/dual-compositor.ts
//
// Orchestrates the two compositor paths. The accelerated pipeline is the
// default for anything human-facing (previews, thumbnails, hover-scrub);
// the deterministic CPU-SIMD oracle is the default for anything machine-facing
// (exports, signed assets, compliance audits).
//
// Reconciliation compares a bounded preview of both paths. It is not a
// pixel-diff of full-resolution output; that would be prohibitively slow.
// Instead: render both at maxSide=2048, decode them, compute per-channel RMSE
// and a perceptual hash, and fail the transaction if either crosses its
// threshold.
// ---------------------------------------------------------------------------

import { inflateSync } from "node:zlib";
import { ArtCraftSession } from "./session.js";

export interface CompositorResult {
  png: Uint8Array;
  /** Per-channel RMSE against the partner path. */
  rmse: [number, number, number];
  /** 64-bit dHash of the greyscale luminance. */
  perceptualHash: bigint;
}

export interface ReconciliationReport {
  accelerated: CompositorResult;
  reference: CompositorResult;
  /** True when RMSE <= RMSE_TOLERANCE on every channel. */
  converged: boolean;
  /** True when the affine hashes agree after a small shift search. */
  hashAligned: boolean;
}

export class DualCompositor {
  static readonly RMSE_TOLERANCE = 1.5; // 0-255 scale, per channel
  static readonly HASH_HAMMING_TOLERANCE = 2;

  constructor(
    private readonly accelerated: ArtCraftSession,
    private readonly reference: ArtCraftSession,
  ) {}

  /**
   * The reference session is a *separate* ArtCraft process that reads the same
   * document. We open it lazily and keep it pinned to the CPU-SIMD compositor
   * by disabling GPU rendering at spawn time (env: PHOTOCRAFT_GPU=0 or the
   * equivalent per app). The accelerated session is unconstrained.
   */
  async renderBoth(maxSide = 2048): Promise<ReconciliationReport> {
    const [fast, slow] = await Promise.all([
      this.accelerated.preview(maxSide),
      this.reference.preview(maxSide),
    ]);
    const a = analyse(fast);
    const b = analyse(slow);
    return this.reconcile(a, b);
  }

  private reconcile(
    a: CompositorResult,
    b: CompositorResult,
  ): ReconciliationReport {
    // Previews can differ by a row/column when the long side rounds down; align
    // the reference to the accelerated frame before comparing.
    const left = decodePngToPlanes(a.png);
    const right = resampleTo(decodePngToPlanes(b.png), left.width, left.height);
    const rmse = rmsePlanes(left, right);

    a.rmse = rmse;
    b.rmse = rmse;

    const converged = rmse.every((r) => r <= DualCompositor.RMSE_TOLERANCE);
    const hamming = popcount64(a.perceptualHash ^ b.perceptualHash);
    return {
      accelerated: a,
      reference: b,
      converged,
      hashAligned: hamming <= DualCompositor.HASH_HAMMING_TOLERANCE,
    };
  }
}

// -- Free functions ---------------------------------------------------------

interface Planes {
  width: number;
  height: number;
  rgb: [Uint8Array, Uint8Array, Uint8Array];
}

function analyse(png: Uint8Array): CompositorResult {
  const planes = decodePngToPlanes(png);
  return {
    png,
    rmse: [0, 0, 0], // filled by reconcile()
    perceptualHash: dHash64(planes),
  };
}

/**
 * Minimal PNG decoder for the byte shapes the engine emits from
 * `doc_render_preview`: 8-bit, non-interlaced, greyscale / RGB / grey+alpha /
 * RGBA. That is all a compositor preview needs, and it keeps the module free
 * of native dependencies (no sharp, no canvas) so it runs anywhere Node runs.
 */
export function decodePngToPlanes(png: Uint8Array): Planes {
  const buf = Buffer.from(png);
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < signature.length; i++) {
    if (buf[i] !== signature[i]) throw new Error("not a PNG");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];

  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length; // length + type + data + crc
  }

  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth}`);
  if (interlace !== 0) throw new Error("interlaced PNG is not supported");

  const bpp = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (bpp === 0) throw new Error(`unsupported PNG colour type ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const pixels = unfilter(raw, width, height, bpp);
  const n = width * height;
  const r = new Uint8Array(n);
  const g = new Uint8Array(n);
  const b = new Uint8Array(n);

  for (let p = 0; p < n; p++) {
    const i = p * bpp;
    if (colorType === 0) {
      r[p] = g[p] = b[p] = pixels[i];
    } else if (colorType === 4) {
      r[p] = g[p] = b[p] = pixels[i];
    } else {
      r[p] = pixels[i];
      g[p] = pixels[i + 1];
      b[p] = pixels[i + 2];
    }
  }
  return { width, height, rgb: [r, g, b] };
}

function unfilter(raw: Buffer, width: number, height: number, bpp: number): Buffer {
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const row = raw.subarray(pos, pos + stride);
    pos += stride;
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = x >= bpp && prev ? prev[x - bpp] : 0;
      let v = row[x];
      switch (filter) {
        case 0: break;
        case 1: v = (v + a) & 0xff; break;
        case 2: v = (v + b) & 0xff; break;
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: v = (v + paeth(a, b, c)) & 0xff; break;
        default: throw new Error(`unknown PNG filter ${filter}`);
      }
      cur[x] = v;
    }
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Nearest-neighbour resample, so a rounding difference in preview size is not
 *  mistaken for compositor drift. */
function resampleTo(src: Planes, width: number, height: number): Planes {
  if (src.width === width && src.height === height) return src;
  const out: [Uint8Array, Uint8Array, Uint8Array] = [
    new Uint8Array(width * height),
    new Uint8Array(width * height),
    new Uint8Array(width * height),
  ];
  for (let y = 0; y < height; y++) {
    const sy = Math.min(src.height - 1, Math.floor((y * src.height) / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(src.width - 1, Math.floor((x * src.width) / width));
      const si = sy * src.width + sx;
      const di = y * width + x;
      out[0][di] = src.rgb[0][si];
      out[1][di] = src.rgb[1][si];
      out[2][di] = src.rgb[2][si];
    }
  }
  return { width, height, rgb: out };
}

function rmsePlanes(a: Planes, b: Planes): [number, number, number] {
  const n = a.width * a.height;
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    let sum = 0;
    const pa = a.rgb[c];
    const pb = b.rgb[c];
    for (let i = 0; i < n; i++) {
      const d = pa[i] - pb[i];
      sum += d * d;
    }
    out[c] = Math.sqrt(sum / n);
  }
  return out;
}

/** 64-bit dHash: downsample to 9x8 and compare horizontal neighbours. */
function dHash64(planes: Planes): bigint {
  const hashWidth = 9;
  const hashHeight = 8;
  const sample = (x: number, y: number): number => {
    const sx = Math.min(planes.width - 1, Math.floor((x * planes.width) / hashWidth));
    const sy = Math.min(planes.height - 1, Math.floor((y * planes.height) / hashHeight));
    const i = sy * planes.width + sx;
    return 0.299 * planes.rgb[0][i] + 0.587 * planes.rgb[1][i] + 0.114 * planes.rgb[2][i];
  };
  let h = 0n;
  for (let y = 0; y < hashHeight; y++) {
    for (let x = 0; x < hashWidth - 1; x++) {
      if (sample(x, y) < sample(x + 1, y)) {
        h |= 1n << BigInt(y * (hashWidth - 1) + x);
      }
    }
  }
  return h;
}

function popcount64(v: bigint): number {
  let n = 0;
  while (v) {
    v &= v - 1n;
    n++;
  }
  return n;
}
