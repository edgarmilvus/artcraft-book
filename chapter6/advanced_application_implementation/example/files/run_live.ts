/**
 * Live run of the Brand Forge worker: the same job the harness sends, with
 * the vision audit enabled, so the reply carries a real `vision` verdict.
 *
 *   OPENAI_COMPATIBLE_API_KEY=… OPENAI_COMPATIBLE_BASE_URL=… \
 *   OPENAI_COMPATIBLE_VISION_MODEL=… npx tsx run_live.ts
 *
 * Not printed in the book: the book shows `runVisionQa` inside the worker.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "brand-forge-live-"));
const job = {
  jobId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  tenantId: "acme",
  canvas: { width: 800, height: 600 },
  palette: { backdrop: "#101014", matte: "#f8f5ef", base: "#1d4ed8", accent: "#f97316" },
  headline: { text: "Storytold", fontFamily: "Helvetica", sizePt: 72, color: "#f8f5ef", xPt: 64, yPt: 360 },
  oklchCurve: {
    stops: [
      { inputL: 0.0, outputL: 0.06, chromaMultiplier: 1.1 },
      { inputL: 0.5, outputL: 0.52, chromaMultiplier: 1.25 },
      { inputL: 1.0, outputL: 0.97, chromaMultiplier: 1.0 },
    ],
  },
  paths: { psd: "brand-kit.psd", preview: "brand-kit.png" },
};

try {
  const child = spawn(process.execPath, ["--import", "tsx", "01_psd-brand-forge.ts"], {
    env: { ...process.env, PHOTOCRAFT_READ_ROOT: scratch, PHOTOCRAFT_WRITE_ROOT: scratch },
  });

  const out = await new Promise<string>((resolve, reject) => {
    let buf = "";
    child.stdout.on("data", (d) => { buf += d; });
    child.stderr.on("data", (d) => { buf += d; });
    child.on("error", reject);
    child.on("close", () => resolve(buf));
    child.stdin.end(JSON.stringify({ requestId: "live", job }) + "\n");
    setTimeout(() => child.kill(), 180_000);
  });

  const envelope = JSON.parse(
    out.trim().split("\n").filter((l) => l.startsWith("{")).pop() ?? "null",
  ) as { ok?: boolean; error?: string; report?: { visionVerdict?: unknown } } | null;

  if (!envelope?.ok) {
    console.error(out.slice(0, 800));
    console.error(`worker failed: ${envelope?.error ?? "no reply"}`);
    process.exit(1);
  }
  if (!envelope.report?.visionVerdict) {
    console.error("the worker ran but produced no vision verdict");
    process.exit(1);
  }

  console.log(JSON.stringify(envelope.report.visionVerdict, null, 2));
  console.log("vision audit ok");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
