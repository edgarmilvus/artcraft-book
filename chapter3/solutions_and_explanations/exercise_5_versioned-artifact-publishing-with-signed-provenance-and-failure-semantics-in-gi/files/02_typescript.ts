export interface ReleaseManifest {
  readonly schemaVersion: 1;
  readonly releaseVersion: string;           // semver
  readonly channel: "beta" | "stable";
  readonly layoutRef: string;
  readonly generatedAt: string;              // ISO 8601 UTC
  readonly artifacts: readonly {
    readonly name: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly pages: number;
    readonly pdfStandard: "pdfa2b" | "pdfx4" | "none";
    readonly signatureArmored: string;       // base64-encoded ASCII-armored detached sig
  }[];
  readonly audit: {
    readonly modifiedLinks: readonly string[];
    readonly missingFonts: readonly string[];
    readonly colorSpaceMismatches: readonly { imagePath: string; from: string; to: string }[];
    readonly passed: boolean;
  };
  readonly provenance: {
    readonly ciPipelineId: string;
    readonly ciJobId: string;
    readonly commitSha: string;
    readonly runnerId: string;
  };
}
