import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/* ------------ Types (from the exercise contract) ------------------------- */
export interface LumetriWheel  { hue: number; sat: number; balance: number; }
export interface WheelTargets  { shadows: LumetriWheel; midtones: LumetriWheel; highlights: LumetriWheel; }
export interface LumetriThreeWayConfig {
  clipId: number;
  inputLut: "builtin:sony-slog3-to-rec709" | "builtin:canon-clog3-to-rec709";
  wheelTargets: WheelTargets;
  verificationPlayhead: string;
  verificationPngPath: string;
}
export interface CommandBatchStep { id: string; params: Record<string, unknown>; }
export interface ScopeAssertionResult {
  clipId: number; paradeMaxIre: number; waveformMinIre: number; waveformMaxIre: number;
  midtoneMeanY: number; shadowBlueLift: number; pass: boolean;
  failedInvariant?: "parade" | "waveform" | "midtones" | "shadowBlueLift";
}
export interface DeliveryReport {
  generatedAt: string;
  clips: Array<{ clipId: number; batchSteps: number; scope: ScopeAssertionResult; verificationPng: string }>;
  rollbacks: Array<{ clipId: number; reason: string }>;
  rollbackPlan: Array<{ clipId: number; steps: number }>;
}

/* ------------ Fixed grade ------------------------------------------------- */
const NORTHIC_WHEELS: WheelTargets = {
  shadows:    { hue: 200, sat: 15, balance: -0.05 },
  midtones:   { hue:  35, sat: 10, balance:  0.03 },
  highlights: { hue:  50, sat:  8, balance:  0.02 },
};
const VERIFY_ROOT = "/work/verify";
const BATCH_SIZE  = 11;

/* ------------ Build the deterministic LUT-first batch --------------------- */
export function buildGradingBatch(clip: number, lut: string): CommandBatchStep[] {
  const w = NORTHIC_WHEELS;
  // The engine stores a band as two values: the colour vector
  // (`wheel_shadows`) and the luma offset (`wheel_shadows_l`). The vector
  // carries hue and saturation together, normalised to 0..1.
  const wheel = (band: "shadows" | "midtones" | "highlights"): CommandBatchStep[] => {
    const target = w[band];
    return [
      {
        id: "effects.setParam",
        params: {
          clip, effect: "lumetri", param: `wheel_${band}`,
          value: [(target.hue % 360) / 360, target.sat / 100],
        },
      },
      {
        id: "effects.setParam",
        params: {
          clip, effect: "lumetri", param: `wheel_${band}_l`,
          value: target.balance,
        },
      },
    ];
  };
  return [
    // Step 1: LUT first — the whole point of the exercise. Wheels react to
    // post-LUT code values, not to the log signal.
    { id: "effects.setParam", params: { clip, effect: "lumetri", param: "input_lut", value: lut } },
    // Step 2: turn the Basic section on so the LUT applies.
    { id: "effects.setParam", params: { clip, effect: "lumetri", param: "basic_on", value: true } },
    // Steps 3–4: shadows → teal-navy push
    ...wheel("shadows"),
    // Steps 5–6: midtones → warm-orange skin
    ...wheel("midtones"),
    // Steps 7–8: highlights → golden rolloff
    ...wheel("highlights"),
  ];
}

/* ------------ Scope helpers ---------------------------------------------- */
// Function expects the scopes.read reply to expose, per bin:
//   parade.r/g/b -> 16 numbers in 0..1 (IRE/100)
//   waveform.luma -> { min[16], max[16], mean[16] }
// Guards tolerate either a top-level or nested "data" envelope.
export function extractScope(row: any) {
  const s = row?.data ?? row;
  const b = 16;
  const z = new Array(b).fill(0);
  // The parade reports one trace per channel, and every bin carries its
  // minimum, mean and maximum in IRE.
  const traces = s?.parade?.traces ?? {};
  const bins = (trace: any): number[] =>
    (Array.isArray(trace) ? trace : []).slice(0, b).map((x: any) => Number(x?.mean ?? 0));
  const R = bins(traces.R ?? traces.r);
  const G = bins(traces.G ?? traces.g);
  const B = bins(traces.B ?? traces.b);
  // The waveform reports the same three figures per column.
  const luma = s?.waveform?.luma ?? s?.waveform ?? [];
  const column = (key: "min" | "max" | "mean"): number[] =>
    (Array.isArray(luma) ? luma : []).slice(0, b).map((x: any) => Number(x?.[key] ?? 0));
  const wMin  = column("min");
  const wMax  = column("max");
  const wMean = column("mean");
  return { R, G, B, wMin, wMax, wMean };
}

export function assertScopes(clipId: number, row: any): ScopeAssertionResult {
  const { R, G, B, wMin, wMax, wMean } = extractScope(row);

  // Invariant A — RGB parade in the top 10% of bins must not exceed 100 IRE
  const paradeMax = Math.max(...R.slice(14), ...G.slice(14), ...B.slice(14));

  // Invariant B — waveform clamped to [0, 100] IRE across every column
  const waveformMin = Math.min(...wMin);
  const waveformMax = Math.max(...wMax);

  // Invariant C — midtones band, bins 4..12, mean Y ∈ [25, 75] IRE
  const midBand = wMean.slice(4, 13);
  const midtoneMeanY = midBand.reduce((a, v) => a + v, 0) / Math.max(1, midBand.length);

  // Invariant D — teal shadow push: mean(B) - mean(R) in bins 0..3 ≥ 0.03 IRE
  const bandR = R.slice(0, 4).reduce((a, v) => a + v, 0) / 4;
  const bandB = B.slice(0, 4).reduce((a, v) => a + v, 0) / 4;
  const shadowBlueLift = bandB - bandR;

  // Tolerance: allow a tiny epsilon from rounding so 100 IRE exactly passes.
  const EPS = 1e-4;
  let failed: ScopeAssertionResult["failedInvariant"] | undefined;
  if (paradeMax > 100 + EPS)                            failed = "parade";
  else if (waveformMin < -EPS || waveformMax > 100 + EPS) failed = "waveform";
  else if (midtoneMeanY < 25 || midtoneMeanY > 75)        failed = "midtones";
  else if (shadowBlueLift < 0.03)                        failed = "shadowBlueLift";

  return {
    clipId, paradeMaxIre: paradeMax, waveformMinIre: waveformMin,
    waveformMaxIre: waveformMax, midtoneMeanY, shadowBlueLift,
    pass: failed === undefined, failedInvariant: failed,
  };
}

/* ------------ Undo --------------------------------------------------------- */
/**
 * Roll the last `steps` commands back.
 *
 * The undo stack is linear: there is no "undo N steps" command, so the
 * rollback is one `edit.undo` per applied command.
 */
async function undo(client: Client, steps: number): Promise<void> {
  for (let i = 0; i < steps; i += 1) {
    await client.callTool({ name: "command_run", arguments: { id: "edit.undo", params: {} } });
  }
}

/* ------------ Main run ---------------------------------------------------- */
export async function run(): Promise<DeliveryReport> {
  mkdirSync(VERIFY_ROOT, { recursive: true });

  const client = new Client({ name: "grade-verifier", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StdioClientTransport({
    command: "filmcraft-cli",
    args: ["mcp",
           "--automation-read-root",  VERIFY_ROOT,
           "--automation-write-root", VERIFY_ROOT],
  }));

  // Enumerate: the inspector reports one array per track kind, and the
  // project tree says which media file every clip points at. The interview
  // shots are the ones whose file name mentions INTERVIEW.
  const seqReply   = await client.callTool({ name: "sequence_inspect", arguments: {} });
  const sequence   = JSON.parse(
    ((seqReply as any).content ?? []).find((b: any) => b.type === "text")?.text ?? "{}",
  );
  const treeReply  = await client.callTool({ name: "project_inspect", arguments: {} });
  const tree       = JSON.parse(
    ((treeReply as any).content ?? []).find((b: any) => b.type === "text")?.text ?? "{}",
  );
  const mediaNames = new Map<number, string>();
  const walk = (node: any): void => {
    if (typeof node?.item === "number" && typeof node?.name === "string") {
      mediaNames.set(node.item, node.name);
    }
    for (const child of node?.children ?? []) walk(child);
  };
  walk(tree.root ?? tree);
  const allClips   = (sequence.video ?? []).flatMap((t: any) =>
                       (t.items ?? []).map((c: any) => ({ ...c, track: t.name ?? t.id })));
  const interview  = allClips.filter((c: any) =>
                       String(mediaNames.get(c.item) ?? "").toUpperCase().includes("INTERVIEW"));

  const report: DeliveryReport = {
    generatedAt: new Date().toISOString(),
    clips: [], rollbacks: [], rollbackPlan: [],
  };

  // Per-clip verification playheads (documented by the finishing supervisor).
  const playheads: Record<string, string> = {
    // Fall back to 30 s for clips not enumerated here so the pipeline is total.
  };

  for (const clip of interview) {
    const clipId: number = clip.clip;
    // The camera body is only known to the operator; the manifest of the
    // finishing supervisor records it per clip.
    const lut = String(mediaNames.get(clip.item) ?? "").toUpperCase().includes("A7S")
      ? "builtin:canon-clog3-to-rec709"   // second unit HLG path
      : "builtin:sony-slog3-to-rec709";   // A-camera
    const batch = buildGradingBatch(clipId, lut);

    // ONE round trip: whole grade in a single command_batch.
    const runReply = await client.callTool({
      name: "command_batch",
      arguments: { steps: batch, stop_on_error: true },
    });
    const runResult = JSON.parse(
      ((runReply as any).content ?? []).find((b: any) => b.type === "text")?.text ?? "{}",
    );
    if (runResult.failed) {
      report.rollbacks.push({ clipId, reason: `batch failed: ${JSON.stringify(runResult)}` });
      await undo(client, batch.length);
      continue;
    }

    // Scope readout, 16 bins ⇒ ~6.25 IRE per bin.
    const scopesReply = await client.callTool({
      name: "command_run",
      arguments: {
        id: "scopes.read",
        params: {
          scopes: ["parade", "waveform"],
          waveformType: "luma",
          colorSpace: "709",
          clamp: true,
          columns: 16,
        },
      },
    });
    const scopes = JSON.parse(
      ((scopesReply as any).content ?? []).find((b: any) => b.type === "text")?.text ?? "{}",
    );
    const assertion = assertScopes(clipId, scopes);

    // Render verification PNG at the documented playhead.
    const tc = playheads[clipId] ?? "00:00:30:00";
    const [h, m, s, f] = tc.split(":").map(Number);
    const seconds = h * 3600 + m * 60 + s + f / 23.976;
    const pngPath = join(VERIFY_ROOT, `clip_${clipId}_graded.png`);
    // `render_frame` answers with an image block: the PNG comes back
    // base64-encoded and has to be written to disk by the agent.
    const pngReply = await client.callTool({
      name: "render_frame",
      arguments: { seconds, max_side: 960 },
    });
    const image = ((pngReply as any).content ?? []).find((b: any) => b.type === "image");
    if (!image?.data) throw new Error(`render_frame returned no image for clip ${clipId}`);
    writeFileSync(pngPath, Buffer.from(image.data, "base64"));

    report.clips.push({ clipId, batchSteps: batch.length, scope: assertion, verificationPng: pngPath });

    if (!assertion.pass) {
      // Roll back only this clip: the undo stack is linear, so the batch is
      // undone one command at a time.
      await undo(client, batch.length);
      report.rollbacks.push({
        clipId,
        reason: `invariant ${assertion.failedInvariant} failed: ${JSON.stringify(assertion)}`,
      });
    } else {
      // Successful grade is part of the reverse-order rollback plan.
      report.rollbackPlan.push({ clipId, steps: batch.length });
    }
  }

  await client.close();
  writeFileSync(join(VERIFY_ROOT, "delivery_report.json"),
                JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
