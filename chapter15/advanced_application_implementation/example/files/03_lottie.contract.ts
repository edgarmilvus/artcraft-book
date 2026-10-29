// --- lottie.contract.ts
export interface LottieMeta {
  v: string;            // "5.7.4"
  fr: number;            // frame rate, e.g. 60
  ip: number;            // in point, usually 0
  op: number;            // out point, e.g. 360
  w: number;
  h: number;
  nm: string;            // "Main_HeroLoop"
  ddd: 0 | 1;
}

export interface DeliveryManifest {
  readonly compositionHash: string;   // SHA-256 of the source .ecproj
  readonly lottie: {
    readonly path: "dist/web/lottie.json";
    readonly sha256: string;
  };
  readonly webmAlpha: {
    readonly path: "dist/native/hero-vp9.webm";
    readonly sha256: string;
    readonly pixFmt: "yuva420p";
    readonly crf: number;
    readonly twoPassSizeBytes: number;
  };
  readonly hevcAlpha?: {
    readonly path: "dist/native/hero-hevc.mov";
    readonly sha256: string;
  };
  readonly parity: {
    readonly lottieFrames: number;
    readonly encodedFrames: number;
    readonly matched: boolean;
  };
}

export interface TranscodeRequest {
  compositionName: "Main_HeroLoop";
  fpsOverride?: number;
  crf: number;
  outputRoot: string;
}
