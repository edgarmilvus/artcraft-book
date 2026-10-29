// --- color.contract.ts
export type Primaries = "bt709" | "bt2020" | "smpte2084";
export type Transfer = "bt709" | "srgb" | "linear" | "pq" | "hlg";
export type Colorspace = "bt709" | "bt2020nc" | "bt2020c";

export interface ColorContract {
  readonly primaries: Primaries;
  readonly transfer: Transfer;
  readonly colorspace: Colorspace;
  readonly range: "tv" | "pc";
  readonly peakNits: 100 | 1000;
}

export interface SignalStatsFrame {
  readonly pts: number;
  readonly YMIN: number;
  readonly YMAX: number;
  readonly YAVG: number;
  readonly UMIN: number;
  readonly UMAX: number;
  readonly VMIN: number;
  readonly VMAX: number;
}

export interface ColorConformance {
  readonly contract: ColorContract;
  readonly observedPrimaries: string;
  readonly observedTransfer: string;
  readonly observedColorspace: string;
  readonly failedFrames: readonly SignalStatsFrame[];
  readonly pass: boolean;
}

export interface OverlayDeliverables {
  readonly webmLottie: { path: string; sha256: string };
  readonly mkvAlpha: { path: string; sha256: string; videoStreamSha256: string };
  readonly webmAlpha: { path: string; sha256: string; videoStreamSha256: string };
  readonly thumbnail: { path: string; sha256: string };
  readonly audio: { path: string; codec: "opus"; sampleRate: 48000; bitrate: 192000 };
}
