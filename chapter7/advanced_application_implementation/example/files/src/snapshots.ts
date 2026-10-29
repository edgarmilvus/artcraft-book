// ─── src/snapshots.ts ────────────────────────────────────────────────────────
import { ApertureSession } from './session.js';

export interface Snapshot {
  cycle: number;
  takenAt: number;
  documentJson: unknown;
}

/* ------------------------------------------------------------------ *
 * A ring of snapshots. We keep the last K so a runaway loop can be
 * recovered from even if the last few cycles were harmful.
 * ------------------------------------------------------------------ */
export class SnapshotRing {
  private ring: Snapshot[] = [];
  constructor(private readonly capacity = 4) {}

  async take(session: ApertureSession, cycle: number): Promise<void> {
    const documentJson = await session.inspect();
    this.ring.push({ cycle, takenAt: Date.now(), documentJson });
    if (this.ring.length > this.capacity) this.ring.shift();
  }

  /** The most recent snapshot at or before a target cycle. */
  atOrBefore(cycle: number): Snapshot | null {
    for (let i = this.ring.length - 1; i >= 0; i--) {
      if (this.ring[i].cycle <= cycle) return this.ring[i];
    }
    return null;
  }

  clear() { this.ring = []; }
}
