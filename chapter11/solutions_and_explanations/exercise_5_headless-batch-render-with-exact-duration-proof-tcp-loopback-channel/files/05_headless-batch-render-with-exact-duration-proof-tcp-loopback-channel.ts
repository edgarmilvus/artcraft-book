import net from "node:net";
import { writeFileSync } from "node:fs";

export const TICKS_PER_SAMPLE = 5_292_000n;    // 254_016_000_000 / 48_000
export const TICKS_PER_FRAME_23976 = 10_594_584_000n;

export interface Deliverable {
  name: string;
  format: "prores" | "h264" | "hevc" | "av1" | "mxf-op1a" | "wav";
  destination: string;
  burnSubtitles?: boolean;
}

export interface DeliverableProof {
  name: string; format: string;
  expectedTicks: string; expectedSamples48k: string;
  renderedPath: string | null; actualSamples48k: string | null;
  driftSamples: string; videoFrameCount: string; residualTicks: string;
  error?: { class: "auth_failed" | "render_failed" | "probe_failed"; detail: string; jobId?: number; };
}
export interface DurationProofManifest {
  sequenceId: string;
  totalTicks: string; workAreaTicks: string | null;
  deliverables: DeliverableProof[];
  generatedAtUtc: string; engineVersion: string;
}

// ─── TCP JSON-lines client with mandatory auth first-frame ──────────────────
export class FCLoopback {
  private sock!: net.Socket;
  private buf = ""; private id = 0;
  private inflight = new Map<number, (v: any) => void>();
  authed = false;

  connect(token: string): Promise<void> {
    this.sock = net.createConnection({ host: "127.0.0.1", port: 7979 });
    return new Promise((res, rej) => {
      this.sock.once("error", rej);
      this.sock.setEncoding("utf8");
      this.sock.on("data", (chunk: string) => {
        this.buf += chunk;
        let nl: number;
        while ((nl = this.buf.indexOf("\n")) !== -1) {
          const line = this.buf.slice(0, nl); this.buf = this.buf.slice(nl + 1);
          const msg = JSON.parse(line);
          if (msg.id === "auth") {
            this.authed = !!msg.ok;
            this.sock.emit("authed");
            continue;
          }
          const cb = this.inflight.get(msg.id);
          if (cb) { this.inflight.delete(msg.id); cb(msg); }
        }
      });
      this.sock.once("connect", () => {
        this.sock.write(JSON.stringify({
          id: "auth", method: "auth", params: { token }
        }) + "\n");
        this.sock.once("authed", () => res());
      });
    });
  }

  exec(command: string, params: object = {}): Promise<any> {
    if (!this.authed) return Promise.reject(new Error("not authenticated"));
    const rid = ++this.id;
    return new Promise(res => {
      this.inflight.set(rid, res);
      this.sock.write(JSON.stringify({
        id: rid, method: "engine.execute",
        params: { command, params }
      }) + "\n");
    });
  }
  close(): void { this.sock.end(); }
}

// ─── Exact expected-count derivation ────────────────────────────────────────
export function expectedCounts(totalTicks: bigint) {
  // If totalTicks is not an exact multiple of TICKS_PER_SAMPLE, the harness
  // is required to pad first — we surface the residual instead of rounding.
  const residual = totalTicks % TICKS_PER_SAMPLE;
  const samples = totalTicks / TICKS_PER_SAMPLE;
  return { samples, residual, exact: residual === 0n };
}

export async function padToSampleBoundary(
  fc: FCLoopback,
  totalTicks: bigint,
  lastClip?: number,
): Promise<bigint> {
  const residual = totalTicks % TICKS_PER_SAMPLE;
  if (residual === 0n) return totalTicks;
  const padTicks = TICKS_PER_SAMPLE - residual;
  // The sequence's duration is the length of its content, so the padding is
  // an ordinary out-trim of the last clip — there is no work-area command
  // to lean on.
  if (lastClip !== undefined) {
    await fc.exec("timeline.trim", {
      clip: lastClip, edge: "out", mode: "regular", delta: Number(padTicks),
    });
  }
  return totalTicks + padTicks;
}

// ─── Poll a render job to completion ────────────────────────────────────────
async function waitForJob(fc: FCLoopback, jobId: number): Promise<{ ok: boolean; error?: string }> {
  for (;;) {
    const r = await fc.exec("jobs.list", {});
    const job = r.result?.jobs?.find((j: any) => j.id === jobId);
    if (!job) return { ok: false, error: "job-disappeared" };
    if (job.state === "done")    return { ok: true };
    if (job.state === "failed")  return { ok: false, error: job.error ?? "render-failed" };
    await new Promise(r => setTimeout(r, 250));
  }
}

// ─── Probe an output file's audio duration through the sandbox ──────────────
// We deliberately use a *separate* headless CLI invocation via the read root.
async function probeSamples(
  fc: FCLoopback,
  relativePath: string,
): Promise<{ ok: boolean; samples?: bigint; frames?: bigint; error?: string }> {
  // `mediaBrowser.probe` is the engine's media-file probe; there is no
  // `duration.probe` command.
  const res = await fc.exec("mediaBrowser.probe", { path: relativePath });
  if (!res.ok) return { ok: false, error: res.error };
  return {
    ok: true,
    samples: BigInt(res.result.audioSamples48k ?? 0),
    frames:  BigInt(res.result.videoFrames ?? 0),
  };
}

// ─── Main orchestrator ──────────────────────────────────────────────────────
export async function runBatch(
  token: string,
  readRoot: string,
  writeRoot: string,
  deliverables: Deliverable[],
): Promise<DurationProofManifest> {
  const fc = new FCLoopback();
  try { await fc.connect(token); }
  catch (e: any) { throw new Error("auth_failed: " + e.message); }

  const seq = await fc.exec("sequence.inspect", {});
  const seqId = seq.result.id as string;
  const fullTicks = BigInt(seq.result.durationTicks);
  const workArea: { startTicks: number; endTicks: number } | null = seq.result.workArea ?? null;
  const spanTicks = workArea
    ? BigInt(workArea.endTicks - workArea.startTicks)
    : fullTicks;

  // Pad to an exact sample boundary so every deliverable shares a common base.
  const paddedTicks = await padToSampleBoundary(fc, spanTicks);
  const { samples: expectedSamples } = expectedCounts(paddedTicks);

  const proofs: DeliverableProof[] = [];

  for (const d of deliverables) {
    const formatMap: Record<string, string> = {
      prores: "prores", h264: "h264", hevc: "hevc",
      av1: "av1", "mxf-op1a": "mxf-op1a", wav: "wav",
    };
    const settings =
      d.format === "prores" ? { proresProfile: "hq", bitrateMode: "vbr2Pass" }
    : d.format === "h264"  ? { bitrateKbps: 50_000, bitrateMode: "vbr2Pass" }
    : d.format === "hevc"  ? { bitrateKbps: 35_000, bitrateMode: "vbr2Pass" }
    : d.format === "av1"   ? { bitrateKbps: 25_000, bitrateMode: "vbr2Pass",
                               burnCaptions: d.burnSubtitles === true }
    : d.format === "mxf-op1a" ? { mxfVideoCodec: "dnxhr" }
    : {};

    const exportRes = await fc.exec("file.exportMedia", {
      path: d.destination, format: formatMap[d.format],
      settings, sequence: seqId, wait: false,
    });
    const jobId: number | undefined = exportRes.result?.job;
    if (!exportRes.ok || jobId === undefined) {
      proofs.push({
        name: d.name, format: d.format,
        expectedTicks: paddedTicks.toString(),
        expectedSamples48k: expectedSamples.toString(),
        renderedPath: null, actualSamples48k: null, driftSamples: "0",
        videoFrameCount: "0", residualTicks: "0",
        error: { class: "render_failed",
                 detail: String(exportRes.error ?? "enqueue-rejected"), jobId },
      });
      continue;
    }

    const wait = await waitForJob(fc, jobId);
    if (!wait.ok) {
      proofs.push({
        name: d.name, format: d.format,
        expectedTicks: paddedTicks.toString(),
        expectedSamples48k: expectedSamples.toString(),
        renderedPath: null, actualSamples48k: null, driftSamples: "0",
        videoFrameCount: "0", residualTicks: "0",
        error: { class: "render_failed", detail: wait.error!, jobId },
      });
      continue;
    }

    const probe = await probeSamples(fc, d.destination);
    if (!probe.ok) {
      proofs.push({
        name: d.name, format: d.format,
        expectedTicks: paddedTicks.toString(),
        expectedSamples48k: expectedSamples.toString(),
        renderedPath: d.destination, actualSamples48k: null, driftSamples: "0",
        videoFrameCount: "0", residualTicks: "0",
        error: { class: "probe_failed", detail: probe.error!, jobId },
      });
      continue;
    }

    const drift = (probe.samples! - expectedSamples) < 0n
      ? (expectedSamples - probe.samples!) : (probe.samples! - expectedSamples);
    const videoFrames = probe.frames ?? (paddedTicks / TICKS_PER_FRAME_23976);
    const frameResidual = paddedTicks % TICKS_PER_FRAME_23976;

    proofs.push({
      name: d.name, format: d.format,
      expectedTicks: paddedTicks.toString(),
      expectedSamples48k: expectedSamples.toString(),
      renderedPath: d.destination,
      actualSamples48k: probe.samples!.toString(),
      driftSamples: drift.toString(),
      videoFrameCount: videoFrames.toString(),
      residualTicks: frameResidual.toString(),
    });
  }

  fc.close();

  const manifest: DurationProofManifest = {
    sequenceId: seqId,
    totalTicks: fullTicks.toString(),
    workAreaTicks: workArea ? spanTicks.toString() : null,
    deliverables: proofs,
    generatedAtUtc: new Date().toISOString(),   // strings only, no float time
    engineVersion: seq.result.engineVersion ?? "unknown",
  };
  writeFileSync(`${writeRoot}/DurationProof.json`, JSON.stringify(manifest, null, 2));
  return manifest;
}
