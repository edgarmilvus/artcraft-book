// src/services/ducking-engine.ts
import type { FilmCraftSession, SequenceSnapshot, ClipSnapshot } from "../mcp/session.js";
import { trackAlias } from "../mcp/session.js";
import type { DuckingPolicy } from "../contracts/ducking.js";
import { DuckingPolicySchema } from "../contracts/ducking.js";

export interface DuckingReport {
  readonly dialogueClipIds: readonly number[];
  readonly duckedClipIds: readonly number[];
  readonly generatedKeyframePasses: number;
  readonly strategy: "managed" | "authored";
}

/**
 * One tick in the FilmCraft time base. FilmCraft exposes time as ticks at
 * 254_016_000_000 per second (per the MCP tool reference), which is the
 * standard "samples-per-second × common-fps-LCM" triplet used by the
 * engine to keep A/V sync across 23.976 / 24 / 25 / 29.97 / 30 / 50 / 60.
 */
export const TICKS_PER_SECOND = 254_016_000_000n;

export function secondsToTicks(seconds: number): number {
  // Use BigInt to avoid fp drift then narrow back to a safe number.
  const ticks = BigInt(Math.round(seconds * 1e6)) * (TICKS_PER_SECOND / 1_000_000n);
  const result = Number(ticks);
  if (!Number.isSafeInteger(result)) {
    throw new RangeError(`secondsToTicks overflow for ${seconds}s`);
  }
  return result;
}

/**
 * DuckingEngine inspects the sequence, classifies audio clips by their
 * Essential Sound type (dialogue/music/sfx/ambience), and applies the
 * ducking policy. It is deterministic: running it twice with the same
 * policy yields the same tick values, so the checkpointer can dedupe.
 */
export class DuckingEngine {
  constructor(private readonly session: FilmCraftSession) {}

  public async applyPolicy(rawPolicy: unknown): Promise<DuckingReport> {
    const policy: DuckingPolicy = DuckingPolicySchema.parse(rawPolicy);

    const sequence = await this.session.sequenceInspect();
    const classify = await this.classifyAudioClips(sequence);

    if (policy.requireDialogue && classify.dialogue.length === 0) {
      throw new Error(
        "ducking: requireDialogue is true but the sequence has no dialogue clips",
      );
    }

    // Music and SFX are the conventional ducking targets. Ambience is
    // deliberately excluded: bedroom-mix rules-of-thumb say not to duck
    // ambience because it collapses the sense of place.
    const targets = policy.applyToSfx
      ? [...classify.music, ...classify.sfx]
      : classify.music;

    if (targets.length === 0 || classify.dialogue.length === 0) {
      return {
        dialogueClipIds: classify.dialogue.map((c) => c.clip),
        duckedClipIds: [],
        generatedKeyframePasses: 0,
        strategy: "managed",
      };
    }

    // Step 1: tell FilmCraft that these clips are dialogue. Essential
    // Sound needs an explicit type assignment before Auto-Ducking will
    // compute a sidechain envelope for them.
    const dialogueIds = classify.dialogue.map((c) => c.clip);
    const musicIds = targets.map((c) => c.clip);

    const classificationSteps = [
      {
        id: "essentialSound.setType",
        params: { clips: dialogueIds, type: "dialogue" as const },
      },
      {
        id: "essentialSound.setType",
        params: {
          clips: musicIds,
          type: policy.applyToSfx ? ("sfx" as const) : ("music" as const),
        },
      },
    ];
    await this.session.batch(classificationSteps, true);

    // Step 2: request the managed ducking pass. The engine computes the
    // gain reduction envelope; the reduceDb value is a *ceiling* — the
    // engine will not reduce more than this amount even for tight pauses.
    await this.session.run("essentialSound.set", {
      clips: musicIds,
      key: "ducking.enabled",
      value: true,
    });
    await this.session.run("essentialSound.set", {
      clips: musicIds,
      key: "ducking.reduceDb",
      value: policy.reduceDb,
    });
    await this.session.run("essentialSound.set", {
      clips: musicIds,
      key: "ducking.sensitivity",
      // Sensitivity is a 0..100 dial that controls how aggressively the
      // engine treats speech energy as a trigger. The published preset
      // is 50; we nudge toward 65 for well-recorded dialogue.
      value: 65,
    });

    // Step 3: run the actual keyframe generator, once per target clip.
    let passes = 0;
    for (const clip of targets) {
      const result = await this.session.run(
        "essentialSound.generateDucking",
        { clips: [clip.clip] },
      );
      if (!result.ok) {
        throw new Error(
          `ducking: generateDucking failed for clip ${clip.clip}: ${result.error}`,
        );
      }
      passes += 1;
    }

    // Step 4: author the attack/release values explicitly. Auto-ducking
    // produces a fixed knee; tenants who have tuned the timings want
    // hard edges, so we write keyframes on the clip-mixer lane.
    await this.authorAttackRelease(musicIds, policy, sequence, classify.dialogue);

    return {
      dialogueClipIds: dialogueIds,
      duckedClipIds: musicIds,
      generatedKeyframePasses: passes,
      strategy: "authored",
    };
  }

  /**
   * Read the Essential Sound type of every audio clip and sort the clips
   * into the four categories the ducking policy knows about.
   */
  private async classifyAudioClips(sequence: SequenceSnapshot): Promise<ClassifiedAudio> {
    const dialogue: ClipSnapshot[] = [];
    const music: ClipSnapshot[] = [];
    const sfx: ClipSnapshot[] = [];
    const ambience: ClipSnapshot[] = [];

    const clips = sequence.audio.flatMap((track) => track.items);
    if (clips.length === 0) return { dialogue, music, sfx, ambience };

    const inspected = await this.session.run<{
      clips?: Array<{ clip: number; settings?: { kind?: string } }>;
    }>("essentialSound.inspect", { clips: clips.map((c) => c.clip) });
    if (!inspected.ok) {
      throw new Error(`ducking: essentialSound.inspect failed: ${inspected.error}`);
    }
    const kinds = new Map<number, string>();
    for (const entry of inspected.result.clips ?? []) {
      const kind = entry.settings?.kind;
      if (kind) kinds.set(entry.clip, kind);
    }

    // A clip that has not been typed yet falls back to the name of the
    // media it points at: the project tree is the only place that knows
    // which file is the dialogue and which is the music bed.
    const names = await this.mediaNames();

    for (const clip of clips) {
      const kind = (kinds.get(clip.clip) ?? names.get(clip.item ?? -1) ?? "").toLowerCase();
      if (/\b(?:dx|dial(?:ogue)?)\b/.test(kind)) dialogue.push(clip);
      else if (/\b(?:mus(?:ic)?|bgm)\b/.test(kind)) music.push(clip);
      else if (/\b(?:sfx|fx)\b/.test(kind)) sfx.push(clip);
      else ambience.push(clip);
    }
    return { dialogue, music, sfx, ambience };
  }

  /** The file name of every media item, keyed by item id. */
  private async mediaNames(): Promise<Map<number, string>> {
    const project = await this.session.projectInspect();
    const names = new Map<number, string>();
    const walk = (node: {
      readonly item?: number;
      readonly name?: string;
      readonly children?: readonly unknown[];
    }): void => {
      if (typeof node.item === "number" && typeof node.name === "string") {
        names.set(node.item, node.name);
      }
      for (const child of (node.children ?? []) as ReadonlyArray<{
        readonly item?: number;
        readonly name?: string;
        readonly children?: readonly unknown[];
      }>) {
        walk(child);
      }
    };
    for (const child of project.root?.children ?? []) walk(child);
    return names;
  }

  /**
   * Replace the engine's smooth attack/release with explicit keyframes at
   * ±(attack | release) around each dialogue clip's boundary. This is what
   * actually produces the "ducked" feel the reviewer expects; the managed
   * engine alone produces a low-shelf style reduction that is too slow.
   */
  private async authorAttackRelease(
    musicClipIds: readonly number[],
    policy: DuckingPolicy,
    sequence: SequenceSnapshot,
    dialogue: readonly ClipSnapshot[],
  ): Promise<void> {
    const attackTicks = secondsToTicks(policy.attackSeconds);
    const releaseTicks = secondsToTicks(policy.releaseSeconds);
    const holdTicks = secondsToTicks(policy.holdSeconds);

    for (const dialogueClip of dialogue) {
      const start = dialogueClip.start;
      const end = dialogueClip.start + dialogueClip.duration;

      for (const musicId of musicClipIds) {
        // Begin the duck `attackTicks` before speech, hold through end,
        // begin release `holdTicks` after end, finish `releaseTicks` later.
        // The automation cannot start before the timeline does, so the
        // attack is clamped to zero.
        const duckStart = Math.max(0, start - attackTicks);
        const duckEnd   = end + holdTicks;
        const releaseEnd = duckEnd + releaseTicks;

        // The mixer authors the automation lane of the audio strip that
        // carries the music: `mixer.writeAutomation` writes the whole ramp
        // in one call, and the points are read back with `mixer.inspect`.
        const strip = trackOf(sequence, musicId) ?? "A2";
        const written = await this.session.run("mixer.writeAutomation", {
          strip,
          lane: "volume",
          points: [
            [duckStart, 0],
            [duckEnd, policy.reduceDb],
            [releaseEnd, 0],
          ],
        });
        if (!written.ok) {
          throw new Error(
            `ducking: could not author the automation on ${strip}: ${written.error}`,
          );
        }
      }
    }
  }
}

/**
 * Partition an audio snapshot into Essential Sound categories.
 *
 * The categories come from the engine itself: `essentialSound.inspect`
 * reports the type of every clip it knows ("Dialogue", "Music", "SFX",
 * "Ambience"), which is the same classification the ducking pass uses.
 */
interface ClassifiedAudio {
  readonly dialogue: ClipSnapshot[];
  readonly music: ClipSnapshot[];
  readonly sfx: ClipSnapshot[];
  readonly ambience: ClipSnapshot[];
}

/** Find the track alias ("A1", "A2"...) containing a given clip. */
function trackOf(sequence: SequenceSnapshot, clipId: number): string | undefined {
  for (const track of sequence.audio) {
    if (track.items.some((c) => c.clip === clipId)) return trackAlias(track.name);
  }
  return undefined;
}
