// --- recovery.contract.ts
/** The recovery budget for one run is spent. */
export class RecoveryBudgetExceeded extends Error {
  constructor() { super("RecoveryBudgetExceeded"); this.name = "RecoveryBudgetExceeded"; }
}

/** The loop needs a human: it stops and reports what it could not decide. */
export class HumanRequired extends Error {
  constructor(message: string) { super(message); this.name = "HumanRequired"; }
}

/** The vision gate still disagrees after every retry. */
export class VisionMismatchAfterRetries extends Error {
  constructor() { super("VisionMismatchAfterRetries"); this.name = "VisionMismatchAfterRetries"; }
}

export interface MciCall {
  readonly tool: "effectcraft" | "photocraft" | "tcp-photocraft";
  readonly method: string;      // e.g. "command_run", "doc_new", "ui.screenshot"
  readonly params: Readonly<Record<string, unknown>>;
  readonly reasoning: string;   // why this call, in ≤ 240 chars
}

export interface UnmappedAsset {
  readonly id: string;          // assets[i].id from Lottie
  readonly originalPath: string;
  readonly suspectedFormat: "png" | "jpg" | "unknown";
  readonly reason: "missing" | "absolute-path" | "wrong-platform";
}

export interface RecoveryPlan {
  readonly assets: readonly UnmappedAsset[];
  readonly replacements: ReadonlyArray<{
    readonly assetId: string;
    readonly generatedFile: string;   // content-addressed
    readonly sha256_16: string;
  }>;
  readonly budgetUsed: number;
  readonly aborted: false;
}

export interface RecoveryAbort {
  readonly reason: RecoveryBudgetExceeded | HumanRequired | VisionMismatchAfterRetries;
  readonly budgetUsed: number;
  readonly aborted: true;
}
