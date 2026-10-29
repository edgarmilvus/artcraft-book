// The manifest schema the pipeline must validate before it touches any engine.
interface BannerManifest {
  brand: {
    name: string;
    chipSvgPath: string;            // path to the brand chip SVG on disk
    disclaimer: string;             // exact legal text, rendered verbatim
    accentRuleColor?: string;       // optional override; if absent, sampled from product
  };
  skus: Array<{
    sku: string;                    // e.g. "serum-30ml"
    productCutoutPath: string;      // background-removed PNG, RGBA, >= 2160px on long side
    copy: {
      headline: string;             // <= 40 chars enforced
      subhead: string;              // <= 80 chars enforced
      cta: string;                  // <= 20 chars enforced
    };
    legalOverrides?: Partial<{ disclaimer: string }>;
  }>;
  outputRoot: string;               // absolute path; must be writable
  concurrency?: number;             // default: min(4, floor(cpuCount / 2))
}

// MCP call examples the spec must name verbatim (id + params keys).
//
// PhotoCraft — run one registry command:
//   { tool: "command_run",   args: { id: "doc_open",        params: { path: "<cutout path>" } } }
//   { tool: "command_run",   args: { id: "document.pixel",  params: { x: 100, y: 100 } } }
//   { tool: "command_run",   args: { id: "edit.convertToProfile",
//                                    params: { profile: "srgb", intent: "relative", bpc: true } } }
//   { tool: "command_run",   args: { id: "image.canvasSize",
//                                    params: { width: 1080, height: 1080, anchor: "center", relative: false } } }
//   { tool: "command_run",   args: { id: "file.close",      params: {} } }
//   { tool: "doc_save",      args: { path: "…", format: "png" } }
//
// PhotoCraft — run several registry commands in order:
//   { tool: "command_batch", args: { steps: [ { id: "…", params: { … } } ], stop_on_error: true } }
//
// DesignCraft — a registry command is run with `execute`, not `command_run`,
// and a batch is `batch { commands: [...] }`, not `command_batch { steps: [...] }`:
//   { tool: "new_document", args: { width: 1080, height: 1080, preset: "Custom", facingPages: false } }
//   { tool: "execute",      args: { command: "frame.create",
//                                    params: { spread: 0, rect: [0, 0, 1080, 1080], content: "graphic" } } }
//   { tool: "execute",      args: { command: "object.color", params: { color: "#rrggbb", target: "fill" } } }
//   { tool: "execute",      args: { command: "type.char",   params: { attrs: { size: 32 } } } }
//   { tool: "place_image",  args: { path: "…", frame: 12, spread: 0, x: 0, y: 0, width: 1080 } }
//   { tool: "export_png",   args: { page: 0, path: "…", scale: 2 } }
//
// Three rules the spec must state, because all three are properties of
// the engines rather than of the manifest:
//
// 1. `type.create` is *PhotoCraft's* command for a new type layer.
//    DesignCraft has no `type.create`; its type commands are `type.char`,
//    `type.para`, `type.align`, `type.bold` and the rest of that family.
//
// 2. `object.fill` applies a *swatch*; a sampled hex colour goes on with
//    `object.color { color: "#rrggbb", target: "fill" }`, or through
//    `swatch.create` followed by `object.fill`.
//
// 3. PhotoCraft confines itself to `--automation-read-root` and
//    `--automation-write-root`. DesignCraft accepts neither flag and
//    confines nothing, so the pipeline must resolve every path it hands
//    to DesignCraft against `outputRoot` itself.
