// src/model.ts — the inference shim the exercise leaves to the harness.
//
// The book declares `loadOnnxSession` / `decodeJpegToTensor` as "provided by
// the harness (compile-time injected shim, not shown)" and expects an ONNX
// runtime. Neither `onnxruntime-node` nor a native JPEG decoder is available
// in this environment, so this file supplies a *deterministic* stand-in with
// the same shape: it decodes an 8-bit PNG (stdlib zlib), resizes to 224×224,
// and returns a 10-float head — six category logits, RGB palette, confidence.
//
// The point of the exercise is the pool, not the model: swapping this file for
// a real `onnxruntime-node` session changes nothing in worker.ts.
import { inflateSync } from "node:zlib";
import { readFile } from "node:fs/promises";

export interface Session {
  run(input: Float32Array, dims: readonly number[]): Promise<Float32Array>;
  dispose(): Promise<void>;
}

export interface ModelCard {
  readonly name?: string;
  readonly version?: string;
}

/** Read the model card; a missing file is not an error (the shim has defaults). */
export async function loadOnnxSession(path: string): Promise<Session> {
  let card: ModelCard = { name: "palette-shim", version: "1" };
  try {
    card = JSON.parse(await readFile(path, "utf8")) as ModelCard;
  } catch {
    // Fall back to the built-in card: the container ever only ships this shim.
  }
  void card;

  return {
    async run(input: Float32Array, dims: readonly number[]): Promise<Float32Array> {
      const [n, c, h, w] = [dims[0] ?? 1, dims[1] ?? 3, dims[2] ?? 224, dims[3] ?? 224];
      if (n !== 1 || c !== 3) throw new Error(`unsupported dims ${dims.join("x")}`);
      const px = h * w;
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < px; i++) {
        r += input[i] ?? 0;
        g += input[px + i] ?? 0;
        b += input[2 * px + i] ?? 0;
      }
      r /= px; g /= px; b /= px;
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      // Deterministic, explainable head: a hue/brightness rule, not a model.
      const logits = new Float32Array(6).fill(0);
      const idx = luma < 0.25 ? 5 : (b > r && b > g ? 1 : (r > g && r > b ? 0 : 2));
      logits[idx] = 4.0;
      const confidence = Math.min(1, 0.55 + Math.abs(luma - 0.5));
      const out = new Float32Array(10);
      out.set(logits, 0);
      out[6] = r * 255;
      out[7] = g * 255;
      out[8] = b * 255;
      out[9] = confidence;
      return out;
    },
    async dispose(): Promise<void> {
      /* nothing to release */
    },
  };
}

/** Decode an 8-bit non-interlaced PNG into a 224×224×3 NCHW float tensor. */
export async function decodeJpegToTensor(buf: ArrayBuffer): Promise<Float32Array> {
  const bytes = new Uint8Array(buf);
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    // No JPEG decoder ships with Node; the harness sends PNG instead.
    throw new Error("JPEG input is not supported by the shim: POST image/png");
  }
  if (bytes.length < 33 || bytes[0] !== 0x89 || bytes[1] !== 0x50) {
    throw new Error("not a PNG (bad signature)");
  }

  const view = new DataView(buf);
  let off = 8;
  let width = 0, height = 0, depth = 0, color = 0;
  const idat: Uint8Array[] = [];
  while (off + 8 <= bytes.length) {
    const len = view.getUint32(off);
    const type = String.fromCharCode(bytes[off + 4]!, bytes[off + 5]!, bytes[off + 6]!, bytes[off + 7]!);
    const data = bytes.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = view.getUint32(off + 8);
      height = view.getUint32(off + 12);
      depth = data[8]!;
      color = data[9]!;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  if (depth !== 8 || ![0, 2, 4, 6].includes(color)) {
    throw new Error(`unsupported PNG (depth ${depth}, colour type ${color})`);
  }
  const bpp = color === 0 ? 1 : color === 2 ? 3 : color === 4 ? 2 : 4;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat.map((d) => Buffer.from(d))));
  const prev = new Uint8Array(stride);
  const row = new Uint8Array(stride);
  const T = 224;
  const tensor = new Float32Array(3 * T * T);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filt = raw[pos++]!;
    row.set(raw.subarray(pos, pos + stride));
    pos += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp]! : 0;
      const b = prev[x]!;
      const c = x >= bpp ? prev[x - bpp]! : 0;
      let v = row[x]!;
      if (filt === 1) v = (v + a) & 0xff;
      else if (filt === 2) v = (v + b) & 0xff;
      else if (filt === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filt === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
      row[x] = v;
    }
    prev.set(row);

    const ty = Math.min(T - 1, Math.floor((y * T) / height));
    for (let tx = 0; tx < T; tx++) {
      const x = Math.min(width - 1, Math.floor((tx * width) / T)) * bpp;
      const r = row[x]!;
      const g = bpp === 1 ? r : row[x + 1]!;
      const bl = bpp === 1 ? r : row[x + 2]!;
      const i = ty * T + tx;
      tensor[i] = r / 255;
      tensor[T * T + i] = g / 255;
      tensor[2 * T * T + i] = bl / 255;
    }
  }
  return tensor;
}
