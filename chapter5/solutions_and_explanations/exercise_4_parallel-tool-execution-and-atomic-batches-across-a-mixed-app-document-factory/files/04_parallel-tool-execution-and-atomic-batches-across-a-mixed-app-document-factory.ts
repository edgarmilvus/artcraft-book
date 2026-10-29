// ============================================================================
// Exercise 4 — Parallel fan-out with per-app compensation
// ============================================================================
// Ground truth we must respect (from the reference):
//   * Photocraft  `command_batch`: NOT atomic — earlier steps stay applied.
//   * DesignCraft `batch`:         stops at first error — earlier steps stay.
//   * EffectCraft `batch`:         atomic:true (default) — rolls back on failure.
//   * PdfCraft    `command_batch`: stops on error — no rollback primitive.
//   * WordCraft   `batch`:         keepGoing option; no rollback primitive.
//
// We therefore emulate atomicity for the non-atomic apps with a
// compensating-transaction layer; EffectCraft's own rollback is used as-is.
// ============================================================================

export type AppId = "photocraft" | "designcraft" | "wordcraft" | "pdfcraft" | "effectcraft";

// ---------------------------------------------------------------------------
// 1. The DAG we build from the manifest.
// ---------------------------------------------------------------------------

export interface PipelineNode {
  readonly nodeId: string;
  readonly app: AppId;
  /**
   * Engine-facing identifier the executor resolves to a call: a registry
   * command id (`frame.create`) is wrapped in the app's `execute` /
   * `command_run` meta-tool, while a meta-tool name (`redact_apply`) is
   * called directly.
   */
  readonly command: string;
  readonly params: Record<string, unknown>;
  readonly dependsOn: readonly string[];
  /** Compensation command on the same app; run in reverse-topo on abort. */
  readonly compensateWith: { readonly command: string; readonly params: Record<string, unknown> } | null;
  /** True when the app itself guarantees atomic rollback for this node. */
  readonly nativeAtomic: boolean;
}

export interface Pipeline {
  readonly pipelineId: string;          // ULID
  readonly correlationId: string;       // propagated to every command's params
  readonly nodes: readonly PipelineNode[];
}

// ---------------------------------------------------------------------------
// 2. Manifest schema the builder consumes. (We define it precisely.)
// ---------------------------------------------------------------------------

export interface IssueManifest {
  readonly issue: string;                              // e.g. "2026-W14"
  readonly sources: {
    readonly layout: string;                           // .designcraft path
    readonly editorial: string;                        // .docx path
    readonly influencerPages: readonly number[];       // 1-based
    readonly printPdf?: string;                        // produced by the layout branch
  };
  readonly artifacts: readonly ArtifactId[];
  readonly depends: Readonly<Record<ArtifactId, readonly ArtifactId[]>>;
  readonly houseStyle: {
    readonly titleColor: string;                       // "#rrggbb"
    readonly accentColor: string;                      // "#rrggbb"
  };
}

export type ArtifactId = "print_pdf" | "web_pdf" | "word_master" | "interactive_redacted_pdf";

// ---------------------------------------------------------------------------
// 3. The DAG builder — turns the manifest into a topologically-structured
//    Pipeline. Purely syntactic; does not know app internals.
// ---------------------------------------------------------------------------

export interface DagBuilder {
  build(manifest: IssueManifest, pipelineId: string, correlationId: string): Pipeline;
}

export class ManifestDagBuilder implements DagBuilder {
  build(m: IssueManifest, pipelineId: string, correlationId: string): Pipeline {
    const nodes: PipelineNode[] = [];

    // ---- DesignCraft master (root of the layout fan-out) ----------------
    //
    // Order in the reference's DesignCraft registry:
    //   file.open → frame.create (text) → type.char → file.exportPdf
    //   (print) + file.exportPdf (web) + file.exportHtml
    //
    // `compensateWith` uses editor commands that exist in the reference:
    // DesignCraft's own `edit.undo`. We keep the compensate chain explicit
    // rather than relying on file.close, because undo is reversible even
    // after a partial PDF export succeeded.
    nodes.push(
      this.node("dc_open", "designcraft", "file.open",
        { path: m.sources.layout, correlationId },
        [], null),
      // DesignCraft has no `type.create`: a text frame is a `frame.create`
      // with `content: "text"`, and its type is styled with `type.char`.
      this.node("dc_frame", "designcraft", "frame.create",
        { rect: [36, 36, 576, 300], content: "text",
          text: `Issue ${m.issue}`, correlationId },
        ["dc_open"], { command: "edit.undo", params: {} }),
      this.node("dc_type", "designcraft", "type.char",
        { attrs: { fontFamily: "Inter", fontStyle: "Bold", size: 72,
                   fill: { color: m.houseStyle.titleColor } }, correlationId },
        ["dc_frame"], { command: "edit.undo", params: {} }),
    );

    // ---- Print PDF artifact (consumes the DesignCraft master) ----------
    nodes.push(this.node("print_pdf", "designcraft", "file.exportPdf",
      { path: `${m.issue}-print.pdf`, pages: "all", bleed: true, marks: true,
        correlationId },
      ["dc_type"], null));

    // ---- Web PDF artifact (fan-out 1; independent of the print file once
    //      the master is ready). DesignCraft exports PDF and HTML only —
    //      there is no PNG exporter, so a "web_png" artifact cannot be
    //      produced by this branch.
    nodes.push(this.node("web_pdf", "designcraft", "file.exportPdf",
      { path: `${m.issue}-web.pdf`, pages: "all", bleed: false, marks: false,
        correlationId },
      ["dc_type"], null));

    // ---- HTML export (also consumes the same master; independent) ------
    nodes.push(this.node("web_html", "designcraft", "file.exportHtml",
      { path: `${m.issue}-web.html`, title: `Catalog ${m.issue}`, correlationId },
      ["dc_type"], null));

    // ---- WordCraft editorial master (independent branch) ---------------
    nodes.push(
      this.node("wc_open", "wordcraft", "open_document",
        { path: m.sources.editorial, correlationId },
        [], null),
      this.node("wc_apply_style", "wordcraft", "format.set",
        { props: { color: m.houseStyle.accentColor, font: "Inter" }, correlationId },
        ["wc_open"], { command: "edit.undo", params: {} }),
      this.node("wc_save", "wordcraft", "save_document",
        { path: `${m.issue}-editorial.docx`, correlationId },
        ["wc_apply_style"], null),
    );

    // ---- PdfCraft interactive redacted artifact (depends on print_pdf) -
    //
    // The PDF branch is deliberately serialized AFTER print_pdf, because
    // PdfCraft consumes the flattened PDF that DesignCraft produces. This
    // is the one serializing edge in an otherwise parallel DAG.
    nodes.push(
      this.node("pc_open", "pdfcraft", "doc_open",
        { path: `${m.issue}-print.pdf`, correlationId },
        ["print_pdf"], null),
      this.node("pc_redact_mark", "pdfcraft", "redact_mark",
        { pages: m.sources.influencerPages, whole_pages: true, correlationId },
        ["pc_open"], { command: "redact_clear", params: {} }),
      this.node("pc_redact_apply", "pdfcraft", "redact_apply",
        { correlationId },
        ["pc_redact_mark"], { command: "edit_undo", params: {} }),
      this.node("pc_sign_field", "pdfcraft", "form_add_field",
        { page: 1, type: "signature", rect: [400, 700, 560, 750],
          name: "CustomerSignature", correlationId },
        ["pc_redact_apply"], { command: "edit_undo", params: {} }),
      this.node("pc_a11y_check", "pdfcraft", "accessibility_check",
        { correlationId },
        ["pc_sign_field"], null),
      this.node("pc_save", "pdfcraft", "doc_save",
        { path: `${m.issue}-interactive.pdf`, correlationId },
        ["pc_a11y_check"], null),
    );

    return Object.freeze({
      pipelineId,
      correlationId,
      nodes: Object.freeze(nodes),
    });
  }

  private node(
    nodeId: string, app: AppId, command: string,
    params: Record<string, unknown>,
    dependsOn: readonly string[],
    compensateWith: PipelineNode["compensateWith"],
  ): PipelineNode {
    return Object.freeze({ nodeId, app, command, params: Object.freeze(params),
      dependsOn: Object.freeze(dependsOn), compensateWith,
      nativeAtomic: app === "effectcraft" });
  }
}

// ---------------------------------------------------------------------------
// 4. Compensation planner.
//
// Cross-app rollback is *not* a single operation. The plan is a sequence of
// WAVES. Each wave runs in parallel; waves are ordered.
//
// Rules:
//   * Compensate in reverse-topological order.
//   * Nodes with `nativeAtomic: true` (EffectCraft) require NO compensation
//     entry — their own batch rolled back internally.
//   * Nodes with `compensateWith: null` are non-reversible (e.g. exports);
//     they are skipped, but the planner records them so the operator knows
//     which side-effects persist.
// ============================================================================

export interface CompensationStep {
  readonly nodeId: string;
  readonly app: AppId;
  /**
   * Engine-facing identifier the executor resolves to a call: a registry
   * command id (`frame.create`) is wrapped in the app's `execute` /
   * `command_run` meta-tool, while a meta-tool name (`redact_apply`) is
   * called directly.
   */
  readonly command: string;
  readonly params: Record<string, unknown>;
}

export interface CompensationPlan {
  /** Each inner array is a wave; waves are sequential, entries parallel. */
  readonly waves: readonly (readonly CompensationStep[])[];
  /** Node ids whose side effects are irreversible (e.g. file exports). */
  readonly irreversible: readonly string[];
}

export interface CompensationPlanner {
  plan(
    pipeline: Pipeline,
    resolved: ReadonlyMap<string, unknown>,   // node id → result
    failedNodes: readonly string[],
  ): CompensationPlan;
}

export class ReverseTopologicalPlanner implements CompensationPlanner {
  plan(pipeline: Pipeline, resolved: ReadonlyMap<string, unknown>,
       failedNodes: readonly string[]): CompensationPlan {
    // Topologically depth-sort; deeper nodes compensate first.
    const depth = new Map<string, number>();
    const byId = new Map(pipeline.nodes.map(n => [n.nodeId, n] as const));
    for (const n of pipeline.nodes) {
      depth.set(n.nodeId, 1 + Math.max(0, ...n.dependsOn.map(d => depth.get(d) ?? 0)));
    }
    // Reverse-topo order: higher depth first, tie-broken by reverse insertion.
    const ordered = [...pipeline.nodes].sort((a, b) =>
      (depth.get(b.nodeId) ?? 0) - (depth.get(a.nodeId) ?? 0));

    const steps: CompensationStep[] = [];
    const irreversible: string[] = [];

    for (const n of ordered) {
      if (!resolved.has(n.nodeId)) continue;                    // never ran
      if (failedNodes.includes(n.nodeId)) continue;             // already failed
      if (n.nativeAtomic) continue;                             // rolled back internally

      if (n.compensateWith) {
        steps.push({
          nodeId: n.nodeId,
          app: n.app,
          command: n.compensateWith.command,
          params: n.compensateWith.params,
        });
      } else {
        irreversible.push(n.nodeId);
      }
    }

    // Group into waves by depth-bucket: nodes at the same graph depth
    // compensate in parallel; different depths are sequential waves.
    const byDepth = new Map<number, CompensationStep[]>();
    for (const s of steps) {
      const d = depth.get(s.nodeId) ?? 0;
      if (!byDepth.has(d)) byDepth.set(d, []);
      byDepth.get(d)!.push(s);
    }
    const waves = [...byDepth.keys()]
      .sort((a, b) => b - a)
      .map(d => Object.freeze(byDepth.get(d)!) as readonly CompensationStep[]);

    return Object.freeze({ waves: Object.freeze(waves), irreversible: Object.freeze(irreversible) });
  }
}

// ---------------------------------------------------------------------------
// 5. Scheduler interface — NOT implemented here (assignment scope).
// ---------------------------------------------------------------------------
//
// The scheduler consumes a Pipeline plus a per-app AppClient and produces an
// ExecutionResult, enforcing:
//   * at most `maxConcurrency` concurrent MCP calls overall (default 8);
//   * per-app concurrency cap of 4 (default) — beyond that, the app's own
//     internal queue dominates and is not documented as fair;
//   * no node runs before every dependency has resolved;
//   * on failure of ANY node: halt new dispatches, drain in-flight,
//     build the CompensationPlan via the planner above, and run the waves.

export interface AppClient {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface ExecutionEngine {
  run(pipeline: Pipeline, maxConcurrency: number): Promise<ExecutionResult>;
}

export interface ExecutionResult {
  readonly ok: boolean;
  readonly resolved: ReadonlyMap<string, unknown>;
  readonly failed: readonly { readonly nodeId: string; readonly error: string }[];
  readonly compensated: readonly string[];
  readonly trace: readonly {
    readonly nodeId: string;
    readonly app: AppId;
    readonly startedAt: number;
    readonly endedAt: number;
    readonly correlationId: string;
  }[];
}

// ---------------------------------------------------------------------------
// 6. The atomicity emulation — a documented pattern.
//
// For a NON-atomic app (PhotoCraft, DesignCraft, PdfCraft), the orchestrator
// emulates a transaction like this:
//
//   1. Pre-step:  command_run {id: "history.newSnapshot",
//                              params: {name: "tx_<pipelineId>", from: "fullDocument"}}
//   2. Run all the app's commands for this branch sequentially.
//   3. On failure:  command_run {id: "history.selectSnapshot",
//                                params: {snapshot: "<snapshot id>"}}
//
// PhotoCraft's history snapshots are the coarse rollback primitive; each
// individual command also leaves a history entry, so we can be finer-grained
// if needed (undo N times). DesignCraft's `edit.undo` is the equivalent
// primitive but with per-command granularity.
//
// For a NATIVE-atomic app (EffectCraft), the orchestrator sends ONE
// batch with `atomic: true` and trusts the app's rollback contract:
//
//   batch {steps: [...], atomic: true, label: "catalog-<pipelineId>"}
// ============================================================================
