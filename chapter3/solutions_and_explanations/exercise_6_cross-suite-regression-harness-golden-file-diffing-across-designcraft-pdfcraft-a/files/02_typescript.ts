export interface PlanStep {
  readonly cli: "designcraft" | "pdfcraft" | "wordcraft";
  readonly command: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface Plan {
  readonly fixtureId: string;
  readonly tolerance: {
    readonly textDamerauLevenshtein: number;
    readonly renderPixelLevenshtein: number;
  };
  readonly steps: readonly PlanStep[];
}

export interface DriverResult {
  readonly ok: boolean;
  readonly commandId: string;
  readonly cli: "designcraft" | "pdfcraft" | "wordcraft";
  readonly stdout: string;
  readonly resultJson: unknown;
  readonly durationMs: number;
  readonly enabledAtRuntime: boolean;
}
