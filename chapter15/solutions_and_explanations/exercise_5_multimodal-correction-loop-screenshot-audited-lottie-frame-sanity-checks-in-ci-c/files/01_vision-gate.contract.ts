// --- vision-gate.contract.ts
import { z } from "zod";

export const VisionResponseSchema = z.object({
  observedHex: z.string().regex(/^#[0-9A-F]{6}$/i),
  confidence: z.number().min(0).max(1),
  notes: z.string().max(240),
});

export type VisionResponse = z.infer<typeof VisionResponseSchema>;

export interface VisionGateResult {
  readonly expectedHex: string;
  readonly observedSamples: readonly [string, string, string];
  readonly agreedHex: string | null;      // null when samples diverge
  readonly deltaE2000: number;
  readonly pass: boolean;
  readonly fallbackUsed: false | "signalstats";
}

export interface AuditArtifacts {
  readonly proofFrame: "dist/audit/proof-frame-30.png";
  readonly guiStartup: "dist/audit/gui-startup.png";
  readonly visionGate: "dist/audit/vision-gate.json";
  readonly signalStats?: "dist/audit/signalstats.txt";
}

export interface VisionGateOptions {
  readonly brandHex: `#${string}`;
  readonly deltaEMax: number;             // default 4.0
  readonly temperature: 0;
  readonly samples: 3;
  readonly dryRun: boolean;
  readonly onRateLimit: "backoff-once" | "abort";
  readonly numericFallback: boolean;
}
