// ─────────────────────────────────────────────────────────────────────────────
// Chapter 1, Exercise 1 — The Disposable Banner Autopsy.
//
// The exact payload sequence `run_photocraft.mjs` sends to a real
// `photocraft-cli mcp` session, plus the `doc_inspect` contract the harness
// enforces after each save. Everything below is the deliverable shape; the
// harness is the executable copy of the same decisions.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 0 — Session bootstrap (not inside a batch; MCP meta-tools only)
// ─────────────────────────────────────────────────────────────────────────────
// 1) doc_new  { width:1920, height:1080, mode:"rgb", depth:8, background:"black" }
//    -> the document already owns a `Background` pixel layer; every count
//       below includes it.
// 2) doc_place {                                                          // MCP meta-tool
//      path: "assets/hero-flat-v3.png",                                   // read-root-relative
//      fit: false, scale: 100, center: [960, 540] }                       // canonical canvas centre
//    -> returns { layer: <SO_LAYER_ID>, smartObject: true }
//    Stash SO_LAYER_ID; it is the target of the first `layer.moveTo`.
//    (`file.placeEmbedded` is the registry twin of this call and is refused
//    under automation — "uses ambient filesystem paths and is disabled" — and a
//    meta-tool cannot live inside a `command_batch`, which is why placement is
//    its own call before the batch.)

// ─────────────────────────────────────────────────────────────────────────────
// BATCH #1 — build (four steps, one round trip)
//   * curves adjustment          (step 0) -> emits { layer: <id0> }
//   * move curves above the SO   (step 1) -> `layer: "$0.layer"`, target = SO id
//   * hue/saturation adjustment  (step 2) -> emits { layer: <id2> }
//   * tagline type layer         (step 3) -> emits { layer: <id3> }
//
// Two engine facts shape this batch:
//   * `$N.layer` is expanded in a command's own `layer` field, but NOT in
//     `layer.moveTo.target`. The target is therefore the Smart Object id,
//     which is known before dispatch.
//   * The adjustment layers are created on top of the stack, so the move is
//     what produces the invariant order instead of creation order.
// ─────────────────────────────────────────────────────────────────────────────
const BATCH_BUILD = {
  steps: [
    // STEP 0 — Curves with the contract's four points. The engine stores them
    //          normalised to 0..1 in the inspection tree.
    {
      id: "layer.newAdjustmentLayer.curves",
      params: {
        points: [[0, 0], [64, 40], [192, 215], [255, 255]],
        // channel defaults to composite; red/green/blue sub-curves omitted
      },
    },
    // STEP 1 — Curves must sit *above* the Smart Object and *below* the
    //          Hue/Saturation layer created next.
    {
      id: "layer.moveTo",
      params: { layer: "$0.layer", target: "<SO_LAYER_ID>", position: "above" },
    },
    // STEP 2 — Hue/Saturation, neutral until the warm mutation. It is created
    //          after the move, so it lands above Curves without a second move.
    {
      id: "layer.newAdjustmentLayer.hueSaturation",
      params: { hue: 0, saturation: 0, lightness: 0, colorize: false },
    },
    // STEP 3 — Tagline, the first live type layer. text_layers[0] of the
    //          contract; the price is a follow-up call.
    {
      id: "type.create",
      params: {
        x: 160, y: 640,
        text: "48 HOURS ONLY",
        font: "Inter-SemiBold",
        size: 64,
        color: "#d97706",
        align: "left",
      },
    },
  ],
};

// follow-up (single command_run, not batched) — price type layer
//   command_run {
//     id: "type.create",
//     params: { x:160, y:820, text:"$19.99", font:"Inter-Bold", size:180,
//               color:"#111111", align:"left" }
//   } -> { layer: <PRICE_LAYER_ID> }

// Persist the reversible master (meta-tool, not an engine command):
//   doc_save { path: "banners/flash-sale-base.pcraft" }
// The engine does not create missing directories: `banners/` must exist first.
// Warnings on save are font-fallback notices only; anything else fails the run.

// ─────────────────────────────────────────────────────────────────────────────
// doc_inspect — assertions an agent MUST enforce (non-destructiveness proof)
//
// `doc_inspect` returns layers top→bottom. The harness reverses them, so the
// contract below is stated bottom→top. `doc_new` owns the bottom `Background`,
// which is why the count is six and not five.
// ─────────────────────────────────────────────────────────────────────────────
const BASE_INSPECT_CONTRACT = {
  layerCount: 6,
  // bottom → top
  order: [
    // [0] the canvas background created by `doc_new`
    { kind: "Pixel", name: "Background" },
    // [1] the generative raster — a live Smart Object, never rasterized
    {
      kind: "Smart Object",
      id: "<SO_LAYER_ID>",
      smartSource: { kind: "embedded", fileName: "hero-flat-v3.png" },
      bounds: [0, 0, 1920, 1080],
    },
    // [2] curves — an *adjustment layer*, not a destructive pixel op.
    //     Points are read back normalised, not as the 0..255 inputs.
    {
      kind: "Adjustment",
      id: "<CURVES_LAYER_ID>",
      adjustment: {
        Curves: {
          master: [
            { input: 0 / 255, output: 0 / 255 },
            { input: 64 / 255, output: 40 / 255 },
            { input: 192 / 255, output: 215 / 255 },
            { input: 255 / 255, output: 255 / 255 },
          ],
          pencil: false,
        },
      },
    },
    // [3] hue/sat — same rule; neutral base values
    {
      kind: "Adjustment",
      id: "<HUE_SAT_LAYER_ID>",
      adjustment: {
        HueSaturation: { hue: 0, saturation: 0, lightness: 0, colorize: false },
      },
    },
    // [4] tagline — editable type, not outlined, not rasterized
    {
      kind: "Type",
      id: "<TAGLINE_LAYER_ID>",
      text: { text: "48 HOURS ONLY", font: "Inter-SemiBold", sizePt: 64 },
    },
    // [5] price — editable type, not outlined, not rasterized
    {
      kind: "Type",
      id: "<PRICE_LAYER_ID>",
      text: { text: "$19.99", font: "Inter-Bold", sizePt: 180 },
    },
  ],
  // History must show placement and both adjustment layers, and must not show
  // flatten / merge / rasterize / desaturate / auto-tone / image-size entries.
  history: {
    contains: ["Place Embedded", "New Curves Layer", "New Hue/Saturation Layer"],
    containsDestructivePixelEdit: false,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// BATCH #2 — Warm-market mutation. Zero source re-import; only parameters of
//            already-existing layers are changed. Save is the MCP meta-tool.
// ─────────────────────────────────────────────────────────────────────────────
const BATCH_MUTATE_WARM = {
  steps: [
    // STEP 0 — retype the price on the *existing* type layer.
    {
      id: "type.edit",
      params: {
        // <PRICE_LAYER_ID> is stashed from the build phase (or re-discovered
        // by name if the agent is stateless between runs)
        layer: "<PRICE_LAYER_ID>",
        text: "$17.99",
      },
    },
    // STEP 1 — mutate the *same* Hue/Sat adjustment layer in place. Never a
    //          second adjustment layer; never image.adjustments.hueSaturation.
    {
      id: "layer.setAdjustment",
      params: {
        layer: "<HUE_SAT_LAYER_ID>",
        hue: -8,
        saturation: 15,
        lightness: 0,
      },
    },
  ],
};

// After the batch, persist the warm variant:
//   doc_save { path: "banners/flash-sale-warm.pcraft" }
// and re-run doc_inspect, asserting:
//   layer count === 6                            (Background + five content layers)
//   layer ids identical to the base save         (nothing was re-created)
//   z-order identical to the base save
//   <SO_LAYER_ID>.kind === "Smart Object"        (still live, not rasterised)
//   <HUE_SAT_LAYER_ID>.adjustment.HueSaturation.hue        === -8
//   <HUE_SAT_LAYER_ID>.adjustment.HueSaturation.saturation === 15
//   <PRICE_LAYER_ID>.text.text === "$17.99"      (text is an object, not a string)
//   <TAGLINE_LAYER_ID>.text.text === "48 HOURS ONLY"
//   <CURVES_LAYER_ID>.adjustment.Curves.master unchanged
//   history === base history + [ "Edit Type", "Modify Adjustment" ]
//
// ─────────────────────────────────────────────────────────────────────────────
// Saved-file evidence — read the `.pcraft` container, not the live session
// ─────────────────────────────────────────────────────────────────────────────
// Both documents declare 1920x1080. The Smart Object's manifest record carries
// a content-addressed `source.blob` (64 hex chars); the same blob id and the
// same `blobs/<id>.zst` bytes appear in the base and the warm file, which is
// the proof that the warm variant reused the plate rather than re-embedding it.
