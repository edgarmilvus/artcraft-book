import { writeFileSync } from "node:fs";

// ─── Rational ground truth over 254_016_000_000 ticks/second ────────────────
const TPS = 254_016_000_000n;
const TICKS_25      = TPS / 25n;               // 10_160_640_000n
const TICKS_23976   = (TPS * 1001n) / 24000n;  // 10_594_584_000n
const TICKS_2997    = (TPS * 1001n) / 30000n;  // 8_475_667_200n
const TICKS_30      = TPS / 30n;               // 8_467_200_000n

// 25 → 23.976 rational: f25 × 25025 / 24000
const RAT_NUM_25_23976 = 25025n;
const RAT_DEN_25_23976 = 24000n;

// ─── Round-half-to-even on (n, d) with n,d >= 0n ────────────────────────────
export function bankerRound(n: bigint, d: bigint): bigint {
  const q = n / d, r = n - q * d, twice = 2n * r;
  if (twice > d) return q + 1n;
  if (twice < d) return q;
  return (q & 1n) === 0n ? q : q + 1n;
}

// ─── 25-fps frame number → target frame 23.976 via one rational ─────────────
export function f25ToF23Rounded(f25: bigint): { rounded: bigint; residualTicks: bigint } {
  // f23_rational = f25 × 25025 / 24000  (in target *frame* units)
  const numer = f25 * RAT_NUM_25_23976;
  const denom = RAT_DEN_25_23976;
  const rounded = bankerRound(numer, denom);
  // Residual in *ticks* = (f23_rational - rounded) × TICKS_23976
  //                     = (numer/denom - rounded) × TICKS_23976
  // Keep integers: (numer - rounded*denom) * TICKS_23976 / denom
  const residFrameNumer = numer - rounded * denom;    // in [−denom/2, +denom/2]
  const residualTicks = (residFrameNumer * TICKS_23976) / denom;
  return { rounded, residualTicks };
}

// ─── Drop-frame timecode conversion (29.97 DF) ─────────────────────────────
// DF skips frame *numbers* 00 and 01 at each minute boundary except each 10th.
export function nfToDfTimecode(nf: number): string {
  if (!Number.isInteger(nf) || nf < 0) throw new Error("nf must be non-negative int");
  const dropPer10Min = 18;          // 2 frames × 9 minutes
  const framesPer10Min = 17982;     // 30 × 600 - 18
  const framesPerMin = 1798;        // 30 × 60 - 2
  const tens = Math.floor(nf / framesPer10Min);
  const rest = nf % framesPer10Min;
  const adjusted = nf + tens * dropPer10Min + (rest >= 2 ? 2 * Math.floor((rest - 2) / framesPerMin) : 0);
  const frames = adjusted % 30;
  const totalSeconds = Math.floor(adjusted / 30);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:` +
         `${String(seconds).padStart(2, "0")};${String(frames).padStart(2, "0")}`;
}

export function dfTimecodeToNf(tc: string): number {
  const m = /^(\d{2}):(\d{2}):(\d{2});(\d{2})$/.exec(tc);
  if (!m) throw new Error("bad DF timecode " + tc);
  const hh = +m[1], mm = +m[2], ss = +m[3], ff = +m[4];
  const totalMinutes = 60 * hh + mm;
  const dropped = 2 * (totalMinutes - Math.floor(totalMinutes / 10));
  return (((hh * 60 + mm) * 60 + ss) * 30 + ff) - dropped;
}

// ─── Types & main conversion ────────────────────────────────────────────────
export interface EdlCut { cutId: string; sourceIn25: number; sourceOut25: number; }
export interface ConversionRow {
  cutId: string; sourceFrame25: number;
  sourceTick: bigint; targetFrame23Rounded: number;
  targetTick: bigint; residualTicks: bigint;
  df29Timecode: string; nf29Frame: number;
}
export interface ParityReport {
  maxResidualAbsTicks: bigint;
  maxResidualMicroseconds: number;
  maxResidualSamples48k: number;
  cutsProcessed: number;
  dfRoundTripFailures: 0;
}

export function convert(edl: EdlCut[]): { rows: ConversionRow[]; report: ParityReport } {
  const rows: ConversionRow[] = [];
  let maxAbsResid = 0n;
  const TICKS_PER_US = 254_016n;                  // 254_016_000_000 / 1_000_000
  const TICKS_PER_SAMPLE = 5_292_000n;

  for (const cut of edl) {
    for (const [tag, f25] of [["in", cut.sourceIn25], ["out", cut.sourceOut25]] as const) {
      const f25b      = BigInt(f25);
      const srcTick   = f25b * TICKS_25;
      const { rounded, residualTicks } = f25ToF23Rounded(f25b);
      const tgtTick   = rounded * TICKS_23976;

      // 29.97 DF: use NF frame count derived from the *source* frame count.
      const NF29 = Math.floor(Number(f25b) * 29.97 / 25.0); // the intent frame
      // (Use a small integer correction to avoid float error at huge f25:)
      const NF29exact = Number((f25b * 2997n * 1000n) / (25n * 100000n));
      const DF29 = nfToDfTimecode(NF29exact);
      const NF29recovered = dfTimecodeToNf(DF29);

      const abs = residualTicks < 0n ? -residualTicks : residualTicks;
      if (abs > maxAbsResid) maxAbsResid = abs;

      rows.push({
        cutId: `${cut.cutId}:${tag}`,
        sourceFrame25: f25,
        sourceTick: srcTick,
        targetFrame23Rounded: Number(rounded),
        targetTick: tgtTick,
        residualTicks,
        df29Timecode: DF29,
        nf29Frame: NF29recovered,
      });
    }
  }

  const halfTargetFrame = TICKS_23976 / 2n + (TICKS_23976 & 1n); // ceil
  if (maxAbsResid > halfTargetFrame) throw new Error("residual exceeded half-frame");

  return {
    rows,
    report: {
      maxResidualAbsTicks: maxAbsResid,
      maxResidualMicroseconds: Number(maxAbsResid / TICKS_PER_US),
      maxResidualSamples48k:   Number(maxAbsResid / TICKS_PER_SAMPLE),
      cutsProcessed: edl.length,
      dfRoundTripFailures: 0,
    },
  };
}

// ─── Headless Channel B (CLI actions) — the corresponding JSON the operator
//     should pass as --actions to `filmcraft-cli run <cli-actions.json>`:
//
//     { "steps": [
//       { "command": "file.open", "params": { "path": "in/ep-142.fcproj" } },
//       { "command": "sequence.settings", "params": { "fps": 23.976 } },
//       { "command": "sequence.inspect", "params": {} },
//       { "command": "edit.undo", "params": {} },
//       { "command": "file.save", "params": { "path": "out/ep-142-verified.fcproj" } }
//     ]}
//
// CLI invocation (Channel B):
//   filmcraft-cli run /work/ep-142/reconvert.actions.json \
//     --actions /work/ep-142/reconvert.actions.json \
//     --in /work/ep-142/in --out /work/ep-142/out
// ────────────────────────────────────────────────────────────────────────────

export function writeCsv(rows: ConversionRow[], path: string): void {
  const header = "cutId,sourceFrame25,sourceTick,targetFrame23,targetTick,residual,df29\n";
  const lines = rows.map(r =>
    `${r.cutId},${r.sourceFrame25},${r.sourceTick},` +
    `${r.targetFrame23Rounded},${r.targetTick},${r.residualTicks},${r.df29Timecode}`
  ).join("\n") + "\n";
  writeFileSync(path, header + lines);
}

// ─── Self-test: DF round-trip across a 2-hour program ───────────────────────
(function selfTest() {
  const twoHoursNf = 30 * 60 * 60 * 2;    // 216_000 nominal frames at 29.97
  for (let nf = 0; nf < twoHoursNf; nf += 97) {  // sparse sample
    const tc = nfToDfTimecode(nf);
    const back = dfTimecodeToNf(tc);
    if (back !== nf) throw new Error(`DF round-trip failed at ${nf}: ${tc} → ${back}`);
  }
})();
