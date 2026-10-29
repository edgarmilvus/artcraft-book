// manifest.json row shape
export interface SkuRow {
  readonly sku: string;              // e.g. "ACME-4421-BLK"
  readonly heroPath: string;         // relative to /work/assets
  readonly palette: "spring" | "autumn";
  readonly aspect: string;           // key of aspects[]
  readonly focalX: number;           // 0..1, normalized center of product
  readonly focalY: number;           // 0..1
}

// The CLI invocation target (one of these must be implemented)
// (a) child_process spawn of: photocraft-cli run <file> --automation-read-root ... --automation-write-root ...
// (b) MCP stdio handshake with: photocraft-cli mcp --automation-read-root ... --automation-write-root ...
