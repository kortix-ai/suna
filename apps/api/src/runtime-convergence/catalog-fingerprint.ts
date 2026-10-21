/**
 * `catalog_fingerprint` — the desired document's opinion of "which model
 * lineup does the platform serve right now" (Rule 1,
 * the runtime-convergence contract (PR #7785)).
 *
 * Hashed over the served managed lineup (llm-gateway/models/served-managed-
 * models.ts): what Platinum Inference offers, when this deployment holds its
 * key. A box whose fingerprint differs rebuilds its `kortix` provider map, so
 * the hash covers what that map carries: id, prices and limits. Sorted so the
 * byte stream is deterministic across processes.
 */

import { createHash } from 'node:crypto';
import { managedLineupRevision } from '../llm-gateway/models/managed-models';
import { servedManagedModels } from '../llm-gateway/models/served-managed-models';

export interface ManagedLineupEntry {
  id: string;
  pricing?: { inputPerMillion: number; outputPerMillion: number; cachedInputPerMillion?: number };
  limit?: { context: number; output: number };
}

/** Pure — the fingerprint is a function of the lineup, nothing else. */
export function fingerprintManagedLineup(models: readonly ManagedLineupEntry[]): string {
  const hash = createHash('sha256');
  for (const model of [...models].sort((a, b) => a.id.localeCompare(b.id))) {
    hash.update(`model\0${model.id}\0${JSON.stringify(model.pricing ?? null)}\0${JSON.stringify(model.limit ?? null)}\0`);
  }
  return hash.digest('hex');
}

let cached: { revision: number; fingerprint: string } | null = null;

/** The live fingerprint of the served lineup, recomputed when the lineup changes. */
export function managedLineupFingerprint(): string {
  const revision = managedLineupRevision();
  if (cached?.revision !== revision) cached = { revision, fingerprint: fingerprintManagedLineup(servedManagedModels()) };
  return cached.fingerprint;
}

/** Test-only: drop the memo so a case can recompute against a mutated fixture. */
export function _resetManagedLineupFingerprintCache(): void {
  cached = null;
}
