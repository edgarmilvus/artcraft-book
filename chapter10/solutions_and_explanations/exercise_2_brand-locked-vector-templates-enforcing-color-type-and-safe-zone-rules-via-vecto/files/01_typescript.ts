interface BrandKit {
  version: string;                 // semver, e.g. "3.2.1"
  swatches: Array<{
    name: string;                  // canonical name, e.g. "Brand Blue 500"
    hex: string;                   // "#0F62FE"
    role: "primary" | "secondary" | "accent" | "text" | "background";
  }>;
  fonts: string[];                 // ["Inter", "Inter-Black", "Inter-SemiBold", "IBM Plex Sans"]
  safeZonePct: number;             // 0.05 for 5%
  minContrastRatio: number;        // 4.5 for WCAG AA on 14pt+ text
  logoClearspacePt: number;        // 24
  logoSvgPath: string;             // relative to read root
  allowedAspects: Array<[number, number]>; // e.g., [[1,1],[4,5],[9,16],[16,9],[3,2]]
}

interface VectorTemplateRowResult {
  sku: string;
  accepted: boolean;
  rejected?: {
    rule:
      | "brand-color"
      | "brand-font"
      | "safe-zone"
      | "contrast"
      | "z-order"
      | "missing-field";
    detail: string;
    elementId?: number;
  };
  artifacts?: Array<{
    format: "vectorcraft" | "pdf" | "svg" | "png";
    path: string;                  // relative to write root
    bytes: number;
  }>;
}

// Target MCP invocation shape (targets, not solutions):
// command_batch {
//   steps: [
//     { id: "draw_shape", params: { shape: "rectangle", x, y, width, height, fill, stroke: "none" } },
//     { id: "draw_path",  params: { d, fill, stroke } },
//     { id: "add_text",   params: { text, x, y, font, size, color } },
//     // ...
//   ]
// }
