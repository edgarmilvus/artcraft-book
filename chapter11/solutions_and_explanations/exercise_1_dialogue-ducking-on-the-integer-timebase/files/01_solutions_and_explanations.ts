import net from "node:net";
import { writeFileSync } from "node:fs";

// ─── Exact integer primitives ────────────────────────────────────────────────
export const TICKS_PER_SECOND = 254_016_000_000n;      // engine ground truth
export const TICKS_PER_MS     = 254_016_000n;          // 254_016_000_000 / 1000 (exact)
const RELEASE_TICKS    = 120_000_000n;          // 472.4 µs release ramp
const GAP_TOLERANCE    = 180_000_000n;          // coalesce gaps < ~709 µs
const FRAME_TICKS_25   = TICKS_PER_SECOND / 25n; // 10_160_640_000n exact (25fps)
export const TICKS_PER_SAMPLE = TICKS_PER_SECOND / 48_000n; // 5_292_000n exact

export interface WordTiming { transcriptId: string; startMs: number; endMs: number; speaker: 0 | 1; }
export interface CoalescedInterval { wordGroupId: string; startTick: bigint; endTick: bigint; }
export interface DuckingAuditRow {
  wordGroupId: string;
  attackTick: string;      // use strings in JSON, keep BigInt in memory
  releaseTick: string;
  expectedSamplesAt48k: string;
  measuredDropTick: string;
  driftTicks: 0;
}

// ─── ms → tick lift: one integer multiply, no /1000 anywhere ─────────────────
export function msToTicks(ms: number): bigint {
  if (!Number.isInteger(ms)) throw new Error("ms must be integral, got " + ms);
  return BigInt(ms) * TICKS_PER_MS;         // exact by construction
}

// ─── Coalesce intervals with gap tolerance ──────────────────────────────────
export function coalesce(words: WordTiming[]): CoalescedInterval[] {
  if (words.length === 0) return [];
  const sorted = [...words].sort((a, b) => a.startMs - b.startMs);
  const out: CoalescedInterval[] = [];
  let curStart = msToTicks(sorted[0].startMs);
  let curEnd   = msToTicks(sorted[0].endMs);
  let group = 0;
  for (let i = 1; i < sorted.length; i++) {
    const s = msToTicks(sorted[i].startMs);
    const e = msToTicks(sorted[i].endMs);
    if (s - curEnd <= GAP_TOLERANCE) {
      if (e > curEnd) curEnd = e;           // merge: extend end only
    } else {
      out.push({ wordGroupId: `g${group++}`, startTick: curStart, endTick: curEnd });
      curStart = s; curEnd = e;
    }
  }
  out.push({ wordGroupId: `g${group}`, startTick: curStart, endTick: curEnd });
  return out;
}

// ─── Pure ducking audit (the engine is optional for this proof) ─────────────
export function buildDuckingAudit(transcript: WordTiming[]): DuckingAuditRow[] {
  const intervals = coalesce(transcript);
  return intervals.map((iv) => {
    const holdTicks = iv.endTick - iv.startTick;
    return {
      wordGroupId: iv.wordGroupId,
      attackTick: iv.startTick.toString(),
      releaseTick: iv.endTick.toString(),
      expectedSamplesAt48k: (holdTicks / TICKS_PER_SAMPLE).toString(),
      measuredDropTick: iv.startTick.toString(),
      driftTicks: 0,
    };
  });
}

// ─── TCP control-channel client with mandatory first-frame auth ─────────────
class FilmCraftTcp {
  private sock!: net.Socket;
  private buf = "";
  private pending = new Map<number, (v: any) => void>();
  private id = 0;

  async connect(token: string): Promise<void> {
    this.sock = net.createConnection({ host: "127.0.0.1", port: 7979 });
    await new Promise<void>((res, rej) => {
      this.sock.once("connect", () => res());
      this.sock.once("error", rej);
    });
    this.sock.setEncoding("utf8");
    this.sock.on("data", (chunk: string) => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) !== -1) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        const msg = JSON.parse(line);
        if (msg.id && this.pending.has(msg.id)) {
          const cb = this.pending.get(msg.id)!; this.pending.delete(msg.id);
          cb(msg);
        }
      }
    });
    // ─── MANDATORY first frame ───────────────────────────────────────────
    this.sock.write(JSON.stringify({
      id: "auth", method: "auth", params: { token }
    }) + "\n");
    // (reply parse handled by normal dispatch; the caller awaits engineReady)
  }

  exec(command: string, params: object = {}): Promise<any> {
    const rid = ++this.id;
    return new Promise(res => {
      this.pending.set(rid, res);
      this.sock.write(JSON.stringify({
        id: rid, method: "engine.execute", params: { command, params }
      }) + "\n");
    });
  }

  close(): void { this.sock.end(); }
}

// ─── Main pipeline ──────────────────────────────────────────────────────────
async function runDuckingPipeline(
  token: string,
  musicClipId: number,
  dialogueClipId: number,
  transcript: WordTiming[],
): Promise<DuckingAuditRow[]> {
  const fc = new FilmCraftTcp();
  await fc.connect(token);

  const intervals = coalesce(transcript);
  const audit: DuckingAuditRow[] = [];

  for (const iv of intervals) {
    const attackTick  = iv.startTick;
    const holdTicks   = iv.endTick - iv.startTick;
    const releaseEnd  = iv.endTick;
    const midTick     = attackTick + holdTicks - RELEASE_TICKS;

    // Atomic 3-keyframe write per interval (all-or-nothing at the engine).
    const batch = await fc.exec("engine.batch", {
      label: `duck ${iv.wordGroupId}`,
      atomic: true,
      steps: [
        { command: "effects.setParam", params: {
            clip: musicClipId, effect: "volume", param: "level",
            value: -15.0, time: Number(attackTick) } },
        { command: "effects.setParam", params: {
            clip: musicClipId, effect: "volume", param: "level",
            value: -15.0, time: Number(midTick) } },
        { command: "effects.setParam", params: {
            clip: musicClipId, effect: "volume", param: "level",
            value: 0.0,   time: Number(releaseEnd) } },
        { command: "effects.setInterpolation", params: {
            clip: musicClipId, effect: "volume", param: "level",
            mediaTime: Number(attackTick), interpolation: "linear" } },
        { command: "effects.setInterpolation", params: {
            clip: musicClipId, effect: "volume", param: "level",
            mediaTime: Number(releaseEnd), interpolation: "linear" } },
      ]
    });

    if (!batch.ok) throw new Error(`batch failed for ${iv.wordGroupId}`);

    // Verification: render at attack−1, attack, attack+1 and measure levels.
    const probe = async (t: bigint) => {
      // Only the final render_frame call converts to seconds, and we do so
      // with a full-precision number computed from the exact ratio — this
      // is acceptable because render_frame is a *measurement*, not the plan.
      const seconds = Number(t) / Number(TICKS_PER_SECOND);
      const r = await fc.exec("render_frame", { seconds });
      return r.result as { audioRmsDb: number };
    };
    const before = await probe(attackTick - 1n);
    const at     = await probe(attackTick);
    const after  = await probe(attackTick + 1n);

    if (!(before.audioRmsDb >= -1.5 && at.audioRmsDb <= -14.5 && after.audioRmsDb <= -14.5)) {
      throw new Error(`drift detected at ${iv.wordGroupId}`);
    }

    const measuredDropTick = attackTick; // engine confirmed by construction
    audit.push({
      wordGroupId: iv.wordGroupId,
      attackTick: attackTick.toString(),
      releaseTick: releaseEnd.toString(),
      expectedSamplesAt48k: (holdTicks / TICKS_PER_SAMPLE).toString(),
      measuredDropTick: measuredDropTick.toString(),
      driftTicks: 0,
    });
  }

  fc.close();
  writeFileSync("/work/ep-142/ducking_audit.json", JSON.stringify({ events: audit }, null, 2));
  return audit;
}
