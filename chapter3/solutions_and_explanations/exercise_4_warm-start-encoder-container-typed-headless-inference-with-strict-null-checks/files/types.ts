// src/types.ts — Branded, discriminated, no `any`.
export type Confidence = number & { readonly __brand: "Confidence" };

export const Confidence = {
  from(value: number): Confidence {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError(`Confidence must be in [0,1], got ${value}`);
    }
    return value as Confidence;    // the ONLY assertion allowed on the brand
  },
} as const;

export interface Classification {
  readonly category: "apparel" | "electronics" | "home" | "beauty" | "food" | "unknown";
  readonly dominantPalette: readonly [number, number, number];
  readonly confidence: Confidence;
}

export type WorkerRequest =
  | { readonly kind: "classify"; readonly id: number; readonly jpeg: ArrayBuffer }
  | { readonly kind: "shutdown" };

export type WorkerResponse =
  | { readonly kind: "ready"; readonly modelLoadMs: number }
  | { readonly kind: "result"; readonly id: number; readonly classification: Classification }
  | { readonly kind: "error"; readonly id: number; readonly message: string }
  | { readonly kind: "shutdown"; readonly drained: number };
