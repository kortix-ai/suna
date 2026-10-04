/**
 * In-memory test doubles for the config-releases modules. Test-only: importing
 * this file from production code is a bug.
 */

import type { PutOutcome } from '../../object-store/s3';
import type { ConfigReleaseLedger } from '../quarantine';
import { configArchiveProjectPrefix, type ConfigArchiveStore } from '../store';

/** An in-memory ledger for tests. Same semantics as the DB one, except that it knows no session's agent, so it counts every failure. */
export class MemoryConfigReleaseLedger implements ConfigReleaseLedger {
  assigned: Array<{ projectId: string; releaseId: string; variant: string; sourceCommit: string; order: number; provenAt: number | null }> = [];
  failures: Array<{ projectId: string; releaseId: string; sessionId: string; reason: string | null }> = [];
  private clock = 0;

  async recordAssigned(input: { projectId: string; releaseId: string; variant: string; sourceCommit: string }) {
    const exists = this.assigned.some(
      (row) => row.projectId === input.projectId && row.releaseId === input.releaseId && row.variant === input.variant,
    );
    if (!exists) this.assigned.push({ ...input, order: ++this.clock, provenAt: null });
  }
  async recordProof(input: { projectId: string; releaseId: string; sessionId: string }) {
    for (const row of this.assigned) {
      if (row.projectId === input.projectId && row.releaseId === input.releaseId && row.provenAt === null) {
        row.provenAt = ++this.clock;
      }
    }
  }
  async recordFailure(input: { projectId: string; releaseId: string; sessionId: string; reason: string | null }) {
    const exists = this.failures.some(
      (row) => row.projectId === input.projectId && row.releaseId === input.releaseId && row.sessionId === input.sessionId,
    );
    if (!exists) this.failures.push(input);
  }
  private failingSessions(projectId: string, releaseId: string): number {
    return new Set(
      this.failures.filter((row) => row.projectId === projectId && row.releaseId === releaseId).map((row) => row.sessionId),
    ).size;
  }
  async quarantined(projectId: string, releaseIds: string[], threshold: number) {
    return new Set(releaseIds.filter((id) => this.failingSessions(projectId, id) >= threshold));
  }
  async lastProven(projectId: string, variant: string, threshold: number) {
    const rows = this.assigned
      .filter(
        (row) =>
          row.projectId === projectId &&
          row.variant === variant &&
          row.provenAt !== null &&
          this.failingSessions(projectId, row.releaseId) < threshold,
      )
      .sort((a, b) => b.order - a.order);
    return rows[0] ? { releaseId: rows[0].releaseId, sourceCommit: rows[0].sourceCommit } : null;
  }
}

/** In-memory store for unit tests. It keeps the real store's first-write-wins rule. */
export class MemoryConfigArchiveStore implements ConfigArchiveStore {
  readonly objects = new Map<string, Buffer>();
  /** When set, every call throws it. Simulates an unavailable store. */
  failWith: Error | null = null;
  puts = 0;

  async putIfAbsent(key: string, body: Buffer): Promise<PutOutcome> {
    if (this.failWith) throw this.failWith;
    this.puts += 1;
    if (this.objects.has(key)) return 'exists';
    this.objects.set(key, Buffer.from(body));
    return 'created';
  }

  async downloadUrl(key: string, ttlSeconds: number): Promise<string | null> {
    if (this.failWith) throw this.failWith;
    if (!this.objects.has(key)) return null;
    return `memory://config-archives/${key}?expiresIn=${ttlSeconds}`;
  }

  async exists(key: string): Promise<boolean> {
    if (this.failWith) throw this.failWith;
    return this.objects.has(key);
  }

  async pruneProject(projectId: string, keep: number): Promise<string[]> {
    if (this.failWith) throw this.failWith;
    if (!Number.isInteger(keep) || keep < 1) throw new Error('keep must be at least 1');
    const prefix = configArchiveProjectPrefix(projectId);
    // Insertion order is write order, so the tail is the newest.
    const mine = [...this.objects.keys()].filter((key) => key.startsWith(prefix));
    const stale = mine.slice(0, Math.max(0, mine.length - keep));
    for (const key of stale) this.objects.delete(key);
    return stale;
  }
}
