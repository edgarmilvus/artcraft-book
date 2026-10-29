type Aspect = "1:1" | "4:5" | "9:16" | "16:9" | "3:2";
type Locale = "en-US" | "en-GB" | "de-DE" | "ja-JP" | "pt-BR" | "ar-SA";

interface VariantKey {
  sku: string;
  locale: Locale;
  aspect: Aspect;
}

interface CacheManifestEntry {
  sku: string;
  locale: Locale;
  aspect: Aspect;
  sourceHash: string;              // sha256 of canonicalized inputs
  artifacts: Array<{
    format: "png" | "webp" | "jpg";
    path: string;                  // relative to write root
    bytes: number;
    sha256: string;
  }>;
  generatedAt: string;             // ISO 8601 UTC
  commandTrace: string[];          // ordered list of command ids actually executed
}

interface CacheManifest {
  version: 1;
  generatedBy: "responsive-fanout/v1";
  entries: Record<string /* cache key */, CacheManifestEntry>;
}

interface RunLog {
  runId: string;
  startedAt: string;
  finishedAt: string;
  hits: number;
  misses: number;
  errors: Array<{ variantKey: VariantKey; code: string; detail: string }>;
  contended: boolean;
  gitSha: string;                  // pipeline code version for forensic replay
}

// Target CLI invocation shape (targets, not solutions):
// designcraft-cli mcp --automation-read-root ./workspace --automation-write-root ./workspace
// photocraft-cli mcp   --automation-read-root ./workspace --automation-write-root ./workspace
