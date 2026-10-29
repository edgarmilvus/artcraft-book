// src/09_motion.ts
import type { CraftClient } from "./03_craft-client.js";
import type { Budget } from "./06_budget.js";
import type { Brief } from "./04_types.js";

export interface MotionOutput {
  readonly compName: string;
  /** Directory of rendered PNG frames: <dir>/frame-0000.png ... */
  readonly framesDir: string;
  /** Suggested fps for downstream muxing. */
  readonly fps: number;
  readonly durationSeconds: number;
  /** The number of frames actually written to disk. */
  readonly frames: number;
}

const DEFAULT_PALETTE = {
  primary: "#0f172a",
  accent: "#f97316",
  neutral: "#f8fafc",
} as const;

/**
 * The motion agent: a five-second square loop, rendered as a PNG frame
 * sequence.
 *
 * EffectCraft is the one engine in the studio whose meta-tools do not
 * mirror the registry at all. A registry command is run through
 * `execute_command { command, params }` — not `command_run` — and the
 * animation-specific tools (`add_keyframe`, `add_effect`) exist only as
 * meta-tools, with no registry command of the same name. The client's
 * dialect table encodes the first fact; this agent uses the second
 * directly.
 *
 * Rendering frame by frame is deliberate. A downstream muxer turns the
 * sequence into an MP4, but keeping the frames on disk means an audit
 * worker can look at frame 12 without re-rendering the comp.
 */
export class MotionAgent {
  public constructor(
    private readonly effectcraft: CraftClient,
    private readonly budget: Budget,
  ) {}

  public async run(brief: Brief, frameDir: string, fps = 24): Promise<MotionOutput> {
    const palette = brief.product.palette ?? DEFAULT_PALETTE;
    const duration = 5;
    const compName = `Reel-${brief.campaignId.slice(0, 8)}`;

    // 1. The comp: 1080×1080, five seconds, at the given frame rate.
    await this.effectcraft.runCommand("comp.new", {
      name: compName,
      width: 1080,
      height: 1080,
      frameRate: fps,
      duration,
      background: palette.primary,
    });
    this.budget.spendCommands(1);

    // 2. The headline text layer.
    const title = await this.effectcraft.runCommand<{ layer: number }>(
      "layer.newText",
      {
        text: brief.product.tagline,
        size: 120,
        fill: palette.neutral,
        position: [540, 540],
        font: "Helvetica",
      },
    );
    this.budget.spendCommands(1);

    // 3. Keyframe the title's opacity: 0 → 100 → 100 → 0 across the comp.
    await this.effectcraft.call("add_keyframe", {
      layer: title.layer,
      path: "transform/opacity",
      keys: [
        { time: 0.0, value: 0 },
        { time: 0.8, value: 100 },
        { time: 3.8, value: 100 },
        { time: 4.6, value: 0 },
      ],
      interpolation: "easyEase",
    });
    this.budget.spendCommands(1);

    // 4. Fade the title in from a blur — a cheap but effective look. The
    //    effect becomes `effects/#1`, and its first parameter is
    //    `effects/#1/blurriness`.
    await this.effectcraft.call("add_effect", {
      layer: title.layer,
      effect: "Gaussian Blur",
      values: { blurriness: 40 },
    });
    this.budget.spendCommands(1);

    await this.effectcraft.call("add_keyframe", {
      layer: title.layer,
      path: "effects/#1/blurriness",
      keys: [
        { time: 0.0, value: 40 },
        { time: 0.8, value: 0 },
        { time: 3.8, value: 0 },
        { time: 4.6, value: 40 },
      ],
      interpolation: "easyEase",
    });
    this.budget.spendCommands(1);

    // 5. A solid accent bar that slides in from the left.
    const sweep = await this.effectcraft.runCommand<{ layer: number }>(
      "layer.newSolid",
      {
        name: "Accent Sweep",
        color: palette.accent,
        width: 6,
        height: 1080,
      },
    );
    this.budget.spendCommands(1);

    await this.effectcraft.call("add_keyframe", {
      layer: sweep.layer,
      path: "transform/position",
      keys: [
        { time: 0.0, value: [-20, 540] },
        { time: 0.9, value: [180, 540] },
        { time: 4.6, value: [180, 540] },
      ],
      interpolation: "easyEase",
    });
    this.budget.spendCommands(1);

    // 6. Render every frame into the output directory. `render_frame` is
    //    a meta-tool, so it is called directly rather than through the
    //    registry.
    const totalFrames = duration * fps;
    for (let frame = 0; frame < totalFrames; frame += 1) {
      const path = this.effectcraft.writePath(
        `${frameDir}/frame-${String(frame).padStart(4, "0")}.png`,
      );
      await this.effectcraft.call("render_frame", {
        comp: compName,
        time: frame / fps,
        path,
        max_side: 1080,
        inline: false,
      });
    }
    this.budget.spendCommands(totalFrames);

    return {
      compName,
      framesDir: frameDir,
      fps,
      durationSeconds: duration,
      frames: totalFrames,
    };
  }
}
