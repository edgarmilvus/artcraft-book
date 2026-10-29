// src/07_copywriter.ts
import type { CraftClient } from "./03_craft-client.js";
import type { Budget } from "./06_budget.js";
import { CopyDraftSchema, type Brief, type CopyBlock, type CopyModel } from "./04_types.js";

/**
 * A specialised copywriting agent.
 *
 * The agent does not talk to a language model directly: a caller-provided
 * `CopyModel` closure is the injection point. The closure's answer is
 * treated as untrusted input and validated against a schema before a single
 * word reaches WordCraft. That keeps the agent deterministic in tests (pass
 * a stub) and lets the SaaS swap one model vendor for another without
 * rewriting the pipeline.
 *
 * WordCraft's MCP surface is small: `new_document`, `execute`, `batch` and
 * `save_document`. The `batch` call is a grouping primitive — it runs the
 * commands in order and stops at the first error unless `keepGoing` is
 * set. It is *not* a transaction: there is no rollback, so a failed batch
 * leaves the earlier steps applied.
 */
export class CopywriterAgent {
  public constructor(
    private readonly wordcraft: CraftClient,
    private readonly budget: Budget,
    private readonly copyModel: CopyModel,
  ) {}

  /**
   * Produce a CopyBlock: generate copy with the injected model, validate
   * it, then typeset it in WordCraft and export a .docx.
   */
  public async run(brief: Brief, outDocxPath: string): Promise<CopyBlock> {
    const draft = CopyDraftSchema.parse(await this.copyModel(brief));
    this.budget.spendTokens(estimateTokens(draft));

    // 1. A new document from WordCraft's blank template.
    await this.wordcraft.call("new_document", { template: "blank" });
    this.budget.spendCommands(1);

    // 2. The body: headline as a bold Heading 1, the subhead beneath it,
    //    then the benefit bullets and the call to action.
    const body = [
      ...draft.bullets.map((bullet) => `• ${bullet}`),
      "",
      `Call to action: ${draft.cta}`,
    ].join("\n");

    await this.wordcraft.call("batch", {
      commands: [
        { command: "text.insert", params: { text: draft.headline } },
        { command: "para.heading1", params: {} },
        { command: "format.bold", params: { value: true } },
        { command: "text.newParagraph", params: {} },
        { command: "text.insert", params: { text: draft.subhead } },
        { command: "text.newParagraph", params: {} },
        { command: "format.bold", params: { value: false } },
        { command: "text.insert", params: { text: body } },
      ],
      keepGoing: false,
    });
    this.budget.spendCommands(8);

    // 3. Save as .docx — the SaaS hands this URL back to the client.
    await this.wordcraft.saveDocument(outDocxPath);
    this.budget.spendCommands(1);

    return {
      headline: draft.headline,
      subhead: draft.subhead,
      bullets: draft.bullets,
      cta: draft.cta,
      docxPath: outDocxPath,
    };
  }
}

/**
 * A conservative token estimate for a draft. The studio never sees the
 * vendor's usage report — the model is injected, so it may not have one —
 * so the budget is charged on the shape of the answer.
 */
function estimateTokens(draft: { headline: string; subhead: string; bullets: readonly string[]; cta: string }): number {
  const characters =
    draft.headline.length +
    draft.subhead.length +
    draft.cta.length +
    draft.bullets.reduce((total, bullet) => total + bullet.length, 0);
  return Math.ceil(characters / 4);
}
