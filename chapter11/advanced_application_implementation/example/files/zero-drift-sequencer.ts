/**
 * @file  filmcraft/zero-drift-sequencer.ts
 * @module ZeroDriftSequencer
 *
 * Plans and dispatches a beat-aligned sequence edit. All time values inside
 * are held as `bigint` ticks; all ratios as `Rational`. The planner is a
 * pure function of its inputs; the dispatcher is the only place that talks
 * to FilmCraft, and it verifies results by re-reading the sequence.
 */

import { Rational, Timebase, FPS, FrameRate, TICKS_PER_SECOND } from "./timebase.js";
import { FilmCraftMCP, SequenceInfo, projectItems } from "./filmcraft-mcp.js";

/* ─── Inputs and outputs ──────────────────────────────────────────── */

export interface CutRequest {
  /** Human-readable name used for the sequence in the project. */
  sequenceName: string;
  /** Output resolution. */
  width: number;
  height: number;
  /** Frame rate as an exact ratio. */
  fps: FrameRate;
  /** Audio sample rate; the sequence's mix bus runs at this rate. */
  sampleRate: number;

  /** Tempo of the music bed in beats per minute. */
  bpm: number;
  /**
   * Musical meter. `beatsPerBar` defaults to 4; a waltz would be 3; a
   * cut in "every other bar" would set `barsPerCut: 2`.
   */
  beatsPerBar?: number;
  barsPerCut?: number;

  /** Where the first downbeat lands, in seconds from the top of A1. */
  downbeatSeconds: number | string;

  /** Total number of cuts to place; one clip per bar (by default). */
  cutCount: number;

  /** Absolute path to the music bed, if any. Placed on A1. */
  musicPath?: string;

  /** Clips to cycle through; one clip per cut, cycling. */
  clipPaths: string[];

  /** Optional fades (in musical beats) on every cut boundary. */
  audioCrossfadeBeats?: number;   // default 0.25
  videoCrossfadeBeats?: number;   // default 0 (hard cut)

  /** If true, run the readback verification step (recommended). */
  verify?: boolean;
}

export interface CutPlan {
  tb: Timebase;
  /** Tick position of every cut on V1. */
  cutTicks: bigint[];
  /** Tick position of every beat (including cuts). */
  beatTicks: bigint[];
  /** Exact rational beat interval in ticks. */
  beatIntervalTicks: Rational;
  /** Exact rational bar interval in ticks. */
  barIntervalTicks: Rational;
  /** Length of the sequence, in ticks. */
  totalTicks: bigint;
}

export interface CutResult {
  plan: CutPlan;
  sequence: SequenceInfo;
  verification: {
    expectedStartTicks: bigint[];
    observedStartTicks: bigint[];
    maxDeviationTicks: bigint;
    passed: boolean;
  };
  renderPath?: string;
  renderSeconds?: number;
}

/* ─── The sequencer ───────────────────────────────────────────────── */

export class ZeroDriftSequencer {
  private readonly bridge: FilmCraftMCP;

  public constructor(bridge: FilmCraftMCP) {
    this.bridge = bridge;
  }

  /* ────────────────────────────────────────────────────────────────
   *  PHASE 1 — PLAN
   *  Pure function. No I/O. Deterministic.
   * ──────────────────────────────────────────────────────────────── */

  /**
   * Compute the plan for a beat-synced edit.
   *
   * Beat math. The interval between successive beats is:
   *
   *     beatIntervalTicks = TICKS_PER_SECOND * 60 / bpm
   *
   * This value is retained as a Rational. The tick position of beat `k`,
   * relative to the downbeat offset, is:
   *
   *     beat(k) = downbeatOffsetTicks + round(k * beatIntervalTicks)
   *
   * — but the *round* is deferred to the moment the position is needed
   * at the wire. Inside the planner we keep the exact rational
   * `k * beatIntervalTicks`, so that beat N is derived from a closed
   * expression and never from beat N-1. This is the crux: N independent
   * closed-form computations do not drift; N accumulations do.
   */
  public plan(req: CutRequest): CutPlan {
    const tb = new Timebase(req.fps, req.sampleRate);
    const beatsPerBar = req.beatsPerBar ?? 4;
    const barsPerCut = req.barsPerCut ?? 1;

    // Exact rational interval between two adjacent beats.
    const beatIntervalTicks = Rational.of(TICKS_PER_SECOND)
      .mul(Rational.of(60))
      .div(Rational.of(req.bpm));

    // Exact rational interval between bar lines.
    const barIntervalTicks = beatIntervalTicks.mul(Rational.of(beatsPerBar));

    // Downbeat offset in ticks (as the caller specified it — never
    // accumulated from a starting zero).
    const downbeatTicks = tb.secondsToTicks(req.downbeatSeconds);

    const totalBeats = req.cutCount * barsPerCut * beatsPerBar;

    // Beat positions. `k` is expressed as a BigInt before multiplication
    // so that `k * beatIntervalTicks` is exact — no float ever touches it.
    const beatTicks: bigint[] = [];
    for (let k = 0; k < totalBeats; k++) {
      const exactTicks = Rational.of(BigInt(k))
        .mul(beatIntervalTicks)
        .add(Rational.of(downbeatTicks));
      beatTicks.push(exactTicks.toBigIntRound());
    }

    // Cut positions are every `barsPerCut` bars (i.e. every
    // beatsPerBar * barsPerCut beats), inclusive of bar 0.
    const beatsPerCut = beatsPerBar * barsPerCut;
    const cutTicks: bigint[] = [];
    for (let i = 0; i < req.cutCount; i++) {
      const k = i * beatsPerCut;
      const exactTicks = Rational.of(BigInt(k))
        .mul(beatIntervalTicks)
        .add(Rational.of(downbeatTicks));
      cutTicks.push(exactTicks.toBigIntRound());
    }

    // The sequence runs from the downbeat to the last bar line.
    const lastBarLine = Rational.of(BigInt(totalBeats)).mul(beatIntervalTicks)
      .add(Rational.of(downbeatTicks));
    const totalTicks = lastBarLine.toBigIntRound();

    return { tb, cutTicks, beatTicks, beatIntervalTicks, barIntervalTicks, totalTicks };
  }

  /* ────────────────────────────────────────────────────────────────
   *  PHASE 2 — DISPATCH
   *  Talks to FilmCraft. Verifies results by re-reading.
   * ──────────────────────────────────────────────────────────────── */

  /**
   * Materialize the plan inside FilmCraft. Returns the final sequence
   * state plus a verification summary. The dispatcher is the *only* place
   * in this module where a `Rational` crosses into JSON.
   */
  public async dispatch(req: CutRequest, plan: CutPlan): Promise<CutResult> {
    // 1. Create the sequence and open it as the active timeline.
    const seq = await this.bridge.newSequence({
      name: req.sequenceName,
      width: req.width,
      height: req.height,
      fps: Number(plan.tb.fps.n) / Number(plan.tb.fps.d),
      sampleRate: req.sampleRate,
      videoTracks: 3,
      audioTracks: 3,
      mix: "Stereo",
    });
    // `file.newSequence` answers with the id of the new sequence.
    await this.bridge.openSequence(seq.sequence);

    // 2. Import all clips plus the music bed in a single call. FilmCraft
    //    returns the project tree, which we re-read by name to resolve
    //    the IDs of the newly created items.
    const allFiles = [...req.clipPaths];
    if (req.musicPath) allFiles.push(req.musicPath);
    await this.bridge.import(allFiles);

    // 3. Inspect the project to retrieve item IDs by basename. The tree
    //    hangs under `project.root.children`, and a media item is named by
    //    its `item` id.
    const project = await this.bridge.run("project.inspect");
    const itemByName = new Map<string, number>();
    for (const it of projectItems(project)) itemByName.set(it.name, it.id);

    // 4. Place the music bed on A1 at tick 0 with a full-length duration.
    if (req.musicPath) {
      const musicId = itemByName.get(basename(req.musicPath));
      if (musicId === undefined) {
        throw new Error(`Imported music not found in project: ${req.musicPath}`);
      }
      await this.bridge.placeClip({
        item: musicId,
        videoTrack: "V1",
        audioTrack: "A1",
        time: 0n,
        duration: plan.totalTicks,
        video: false,
        audio: true,
      });
    }

    // 5. Lay the video clips end-to-end at the computed cut ticks.
    const clipIds: number[] = [];
    const observedStarts: bigint[] = [];
    const crossfadeFrames = req.audioCrossfadeBeats
      ? Math.max(1, Math.round(
          Number(plan.beatIntervalTicks.n) / Number(plan.beatIntervalTicks.d) *
          req.audioCrossfadeBeats / Number(plan.tb.ticksPerFrame.n) * Number(plan.tb.ticksPerFrame.d)
        ))
      : 0;

    for (let i = 0; i < req.cutCount; i++) {
      const clipPath = req.clipPaths[i % req.clipPaths.length];
      const clipItem = itemByName.get(basename(clipPath));
      if (clipItem === undefined) {
        throw new Error(`Imported clip not found in project: ${clipPath}`);
      }

      const start = plan.cutTicks[i];
      const end   = i + 1 < plan.cutTicks.length ? plan.cutTicks[i + 1] : plan.totalTicks;
      const duration = end - start;

      const placed = await this.bridge.placeClip({
        item: clipItem,
        videoTrack: "V1",
        audioTrack: "A2",         // clip audio goes on its own track
        time: start,
        duration,
        video: true,
        audio: true,
      });
      clipIds.push(placed.clip);
      observedStarts.push(start);

      // 5a. Sample-accurate audio crossfade on every cut except the last.
      if (crossfadeFrames > 0 && i < req.cutCount - 1) {
        await this.bridge.applyAudioTransition(placed.clip, "constant_power", crossfadeFrames);
      }
      // 5b. Optional video crossfade.
      if (req.videoCrossfadeBeats && req.videoCrossfadeBeats > 0 && i < req.cutCount - 1) {
        const vFrames = Math.max(1, Math.round(
          req.videoCrossfadeBeats *
          Number(plan.tb.fps.n) / Number(plan.tb.fps.d)
        ));
        await this.bridge.applyVideoTransition(placed.clip, "cross_dissolve", vFrames);
      }
    }

    // 6. Place sequence markers at each cut (visible in the Timeline).
    for (let i = 0; i < plan.cutTicks.length; i++) {
      await this.bridge.run("markers.add", {
        target: "program",
        time: Number(plan.cutTicks[i]),
        name: `Cut ${i + 1}`,
        color: "green",
      });
    }

    // 7. Verification — read the sequence back and compare.
    const sequence = await this.bridge.inspectSequence(seq.sequence);
    // The video track carries the cuts; the music bed lives on an audio track
    // and would otherwise shift the list by one.
    const videoTrackId = sequence.tracks.find((t) => t.kind === "video")?.id;
    const observedTick = (i: number): bigint => {
      const match = sequence.clips
        .filter((c) => c.track === videoTrackId)
        .sort((a, b) => Number(a.start - b.start))[i];
      return match ? match.start : 0n;
    };
    const observedStartsFromInspect = plan.cutTicks.map((_, i) => observedTick(i));
    const maxDeviation = observedStartsFromInspect.reduce((acc, v, i) => {
      const d = v > plan.cutTicks[i] ? v - plan.cutTicks[i] : plan.cutTicks[i] - v;
      return d > acc ? d : acc;
    }, 0n);

    const verification = {
      expectedStartTicks: plan.cutTicks,
      observedStartTicks: observedStartsFromInspect,
      maxDeviationTicks: maxDeviation,
      passed: maxDeviation === 0n,
    };

    if (req.verify !== false && !verification.passed) {
      throw new Error(
        `Zero-drift verification failed: max deviation ${maxDeviation} ticks ` +
        `(${Number(maxDeviation) / Number(TICKS_PER_SECOND) * 1000} ms)`,
      );
    }

    return { plan, sequence, verification };
  }
}

/* ─── Small utility ──────────────────────────────────────────────── */

function basename(p: string): string {
  const normalized = p.replace(/\\/g, "/");
  const i = normalized.lastIndexOf("/");
  return i === -1 ? normalized : normalized.slice(i + 1);
}
