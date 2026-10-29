// src/06_budget.ts
export class BudgetExceededError extends Error {
  public constructor(
    public readonly kind: "commands" | "seconds" | "tokens",
    limit: number,
  ) {
    super(`Budget exceeded: ${kind} limit is ${limit}`);
    this.name = "BudgetExceededError";
  }
}

export interface BudgetLimits {
  /** The most registry commands one campaign may spend. */
  readonly maxCommands: number;
  /** The wall-clock ceiling for one campaign, in seconds. */
  readonly maxSeconds: number;
  /**
   * The most model tokens one campaign may spend. The counter is vendor
   * agnostic on purpose: the model is injected, so the studio cannot know
   * whether the tokens it spends are OpenAI's, Anthropic's or a local
   * model's.
   */
  readonly maxModelTokens: number;
}

/**
 * A monotonic budget tracker. Agents call `spendCommands()` and
 * `spendTokens()` as they work; the orchestrator calls
 * `assertWithinLimits()` between phases.
 *
 * The budget sits *above* the MCP client, not inside it, so the same
 * policy protects a PhotoCraft-only pipeline (no model at all) and a
 * fully multimodal one without any change to the transport.
 */
export class Budget {
  private commands = 0;
  private tokens = 0;
  private readonly startedAt = Date.now();

  public constructor(private readonly limits: BudgetLimits) {}

  /** Account for one or more registry command invocations. */
  public spendCommands(n = 1): void {
    this.commands += n;
    if (this.commands > this.limits.maxCommands) {
      throw new BudgetExceededError("commands", this.limits.maxCommands);
    }
  }

  /** Account for model usage (copy and vision share the same counter). */
  public spendTokens(n: number): void {
    this.tokens += n;
    if (this.tokens > this.limits.maxModelTokens) {
      throw new BudgetExceededError("tokens", this.limits.maxModelTokens);
    }
  }

  /** Fail-fast check that everything is still within limits. */
  public assertWithinLimits(): void {
    const elapsed = (Date.now() - this.startedAt) / 1000;
    if (elapsed > this.limits.maxSeconds) {
      throw new BudgetExceededError("seconds", this.limits.maxSeconds);
    }
  }

  public snapshot(): { commands: number; tokens: number; seconds: number } {
    return {
      commands: this.commands,
      tokens: this.tokens,
      seconds: (Date.now() - this.startedAt) / 1000,
    };
  }
}
