// src/05_store.ts
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AssetArtefact, Brief, CampaignState, CopyBlock } from "./04_types.js";

/**
 * A campaign store: an in-memory snapshot plus a durable JSON journal.
 *
 * In production you would swap this for Postgres plus an object store. The
 * interface here is deliberately narrow so the swap is one adapter:
 * `get()`, `patch()`, `setCopy()`, `setHero()`, `recordAsset()`,
 * `journal()`, `flush()`.
 *
 * Two properties make the journal worth keeping:
 *
 * • **It is flat JSON.** The whole point of the store is that it is
 *   trivially serializable, diffable and reproducible: given the initial
 *   brief plus the journal, the campaign can be replayed.
 *
 * • **It is deterministic.** Artefact identifiers are derived from the
 *   order in which the artefacts were produced, never from a clock or a
 *   random source, so two runs of the same brief produce the same
 *   identifiers.
 */
export class CampaignStore {
  private state: CampaignState;

  private constructor(
    state: CampaignState,
    private readonly rootPath: string,
  ) {
    this.state = state;
  }

  /** Bootstrap a store from a validated brief and a campaign root. */
  public static bootstrap(brief: Brief, root: string): CampaignStore {
    return new CampaignStore(
      {
        brief,
        copy: null,
        hero: null,
        assets: [],
        auditLog: [],
        commandsSpent: 0,
      },
      root,
    );
  }

  public get(): Readonly<CampaignState> {
    return this.state;
  }

  /** The absolute path of the campaign workspace. */
  public root(): string {
    return this.rootPath;
  }

  /** Patch the store immutably; returns the new snapshot. */
  public patch(
    patch: Partial<Omit<CampaignState, "brief" | "auditLog" | "assets">>,
  ): CampaignState {
    this.state = { ...this.state, ...patch };
    return this.state;
  }

  /** Attach the copy block once WordCraft has produced it. */
  public setCopy(copy: CopyBlock): void {
    this.state = { ...this.state, copy };
  }

  /** Attach the canonical hero asset (a PNG the visual agent produced). */
  public setHero(hero: CampaignState["hero"]): void {
    this.state = { ...this.state, hero };
  }

  /**
   * Record a finished asset. The identifier is derived from the channel
   * and the number of artefacts already recorded, so a replay of the same
   * brief produces the same identifiers.
   */
  public recordAsset(asset: AssetArtefact): void {
    this.state = { ...this.state, assets: [...this.state.assets, asset] };
  }

  /** The next deterministic artefact identifier for a channel. */
  public nextArtefactId(channel: string): string {
    const seen = this.state.assets.filter((a) => a.channel === channel).length;
    return `${channel}-${String(seen + 1).padStart(2, "0")}`;
  }

  /** Append a free-form audit line (agent name, message, commands spent). */
  public journal(agent: string, message: string, commandsSpent: number): void {
    this.state = {
      ...this.state,
      commandsSpent: this.state.commandsSpent + commandsSpent,
      auditLog: [
        ...this.state.auditLog,
        { atIso: new Date().toISOString(), agent, message, commandsSpent },
      ],
    };
  }

  /** Persist the snapshot to disk so the campaign can be resumed. */
  public async flush(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
  }

  /** Convenience: absolute path inside the campaign workspace. */
  public path(...segments: string[]): string {
    return join(this.rootPath, this.state.brief.campaignId, ...segments);
  }
}
