// Chapter 1, Exercise 3 — The Undoable Grade.
//
// The MCP payloads that rebuild a flattened 3-shot sequence as a live FilmCraft
// project: three linked V1 clips, a per-clip Lumetri instance pointing at the
// neutral show LUT, a V2 adjustment layer carrying the warm grade, and a
// razor + ripple delete that moves the timeline without re-rendering a pixel.
//
// Everything here is data plus pure helpers; `run_ex3.ts` dispatches it to a
// real `filmcraft-cli mcp` session and asserts the resulting sequence.

export type EngineStep = { id: string; params: Record<string, unknown> };

/** FilmCraft ticks: 254_016_000_000 ticks = 1 second. */
export const TICKS_PER_SECOND = 254_016_000_000n;

export const SEQUENCE = {
  name: 'Skincare-30s-Hero',
  width: 1920,
  height: 1080,
  fps: 23.976,
  video: 2,
  audio: 2,
  mix: 'Stereo',
} as const;

/** The two show LUTs, relative to the exercise's read root. */
export const LUTS = {
  neutral: 'luts/Neutral-Studio.cube',
  warm: 'luts/Warm-Market-v2.cube',
} as const;

/** Demo footage stands in for the exercise's `clips/shot-0N.mp4` files. */
export const DEMO_SCENES = ['OceanSunset', 'Aurora', 'CityNight'] as const;

/**
 * The layout the exercise specifies: 0 / 6.0 / 12.5 s, so there is a
 * deliberate half-second gap before the third shot.
 */
export const LAYOUT = {
  shot1: { start: 0n, duration: 6n * TICKS_PER_SECOND },
  shot2: { start: 6n * TICKS_PER_SECOND, duration: 6n * TICKS_PER_SECOND },
  shot3: { start: 12n * TICKS_PER_SECOND + TICKS_PER_SECOND / 2n, duration: 6n * TICKS_PER_SECOND },
} as const;

const seconds = (ticks: bigint): number => Number(ticks);

/** Create the sequence and import the three sources as linked project items. */
export const IMPORT_STEPS: EngineStep[] = DEMO_SCENES.map((scene) => ({
  id: 'file.importDemoFootage',
  params: { scene },
}));

/** Place each imported item on V1 at its scripted time, keeping the 0.5 s gap. */
export const placeSteps = (itemIds: number[]): EngineStep[] => {
  const layout = [LAYOUT.shot1, LAYOUT.shot2, LAYOUT.shot3];
  return itemIds.map((item, index) => ({
    id: 'timeline.place',
    params: {
      item,
      track: 'V1',
      time: seconds(layout[index].start),
      duration: seconds(layout[index].duration),
      video: true,
      audio: true,
    },
  }));
};

/**
 * Put a live Lumetri instance on every V1 clip and point it at the neutral
 * LUT. The clip ids must come from `sequence_inspect`: the ids returned by
 * `timeline.place` live in a different namespace and later edits reject them.
 */
export const gradeSteps = (clipIds: number[]): EngineStep[] =>
  clipIds.flatMap((clip) => [
    { id: 'effects.apply', params: { clips: [clip], effect: 'Lumetri Color' } },
    { id: 'lumetri.setInputLut', params: { clip, path: LUTS.neutral } },
  ]);

/** Build the sequence-wide adjustment layer that carries the warm grade. */
export const adjustmentSteps = (itemId: number): EngineStep[] => [
  { id: 'timeline.place', params: {
    item: itemId,
    track: 'V2',
    time: 0,
    duration: seconds(20n * TICKS_PER_SECOND),
    video: true,
    audio: false,
  } },
];

/** Point an adjustment clip at the warm-market LUT. */
export const warmGradeStep = (clipId: number): EngineStep => ({
  id: 'lumetri.setInputLut',
  params: { clip: clipId, path: LUTS.warm },
});

/**
 * Razor at the shot-3 boundary, unlock V2 so the sync-locked adjustment layer
 * does not block the ripple, delete the middle V1 clip, then relock.
 */
export const rippleSteps = (shot2ClipId: number, razorTicks: bigint): EngineStep[] => [
  { id: 'timeline.razor', params: { time: seconds(razorTicks), track: 'V1' } },
  { id: 'timeline.setTrack', params: { track: 'V2', syncLock: false } },
  { id: 'edit.rippleDelete', params: { clips: [shot2ClipId] } },
  { id: 'timeline.setTrack', params: { track: 'V2', syncLock: true } },
];

/**
 * What `sequence_inspect` must prove after the ripple: the surviving V1 clips
 * keep their own durations and their live neutral grade, and the second one
 * starts exactly one deleted-clip duration earlier than it did before.
 *
 * The shift is expressed against the *actual* duration read from the
 * sequence, not the scripted 6 s constant: demo footage can be a few
 * milliseconds longer than the requested placement duration, and the ripple
 * moves downstream clips by that real duration.
 */
export const expectedRipple = (shot3Start: number, shot2Duration: number): number =>
  shot3Start - shot2Duration;
