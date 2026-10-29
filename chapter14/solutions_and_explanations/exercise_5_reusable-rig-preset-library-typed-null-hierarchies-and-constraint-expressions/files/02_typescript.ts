// presets/pushFollow.json (abbreviated for brevity; all five files follow this shape)
export const PUSH_FOLLOW_PRESET = {
  name: "pushFollow",
  version: 1,
  params: {
    dampX:       { type: "number", default: 0.85, since: 1, min: 0,    max: 1 },
    dampY:       { type: "number", default: 0.85, since: 1, min: 0,    max: 1 },
    delayFrames: { type: "number", default: 3,    since: 1, min: 0,    max: 60 }
  },
  preconditions: ["targetLayerExists"]
} as const;

// The script's expected return shape.
export interface PushFollowDetail {
  createdLayers: number[];
  expressions: Record<string, string[]>;
  essentialProperties: Array<{ layer: number; control: string }>;
  reused: boolean;
  nullLayer: number;
}

export interface TrimWipeDetail {
  createdLayers: number[];
  expressions: Record<string, string[]>;
  essentialProperties: Array<{ layer: number; control: string }>;
  reused: boolean;
  trimPath: string;            // property path as returned by get_layer
  wipeDuration: number;
}

// Result type used across the library.
export type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export interface PresetError {
  code:
    | "PresetPreconditionFailed"
    | "PresetParameterMismatch"
    | "PresetVersionTooNew"
    | "PresetScriptFailed"
    | "SandboxViolation";
  hint: string;
  message: string;
}
