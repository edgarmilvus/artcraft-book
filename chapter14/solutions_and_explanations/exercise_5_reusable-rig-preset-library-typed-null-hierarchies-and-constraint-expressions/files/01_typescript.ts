// The library's public surface: one entry point that applies a named
// preset to a layer and reports what it did.
export interface CompRef {
  id: number | string;
}

export interface LayerRef {
  id: number | string;
  name?: string;
}

export type PresetName =
  | "pushFollow"
  | "trimWipe"
  | "counterSpin"
  | "springScale"
  | "typeOn";

export interface PresetParams {
  [key: string]: number | string | boolean;
}

export interface AppliedPreset {
  ok: boolean;
  preset: PresetName;
  detail?: unknown;
}
