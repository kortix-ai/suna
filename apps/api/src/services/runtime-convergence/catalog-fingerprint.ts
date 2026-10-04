/**
 * `catalog_fingerprint` — the desired document's opinion of "which model
 * lineup does the platform serve right now" (Rule 1,
 * the runtime-convergence contract (PR #7785)).
 *
 * Hashed over `SERVED_MANAGED_MODELS` (services/llm-gateway/models/served-managed-models.ts)
 * — config joined with credentials, i.e. the lineup this deployment can
 * actually serve, matching the failure this spec closes: "no live managed
 * set; bundled managed models stand" is exactly a box whose fingerprint of
 * THAT set stopped moving. Same pattern as `managedSkillOverlayHash`
 * (services/runtime-assets/managed-skills.ts) — sorted so the byte stream is
 * deterministic across processes, hashed over the fields that change what a
 * box would need to DO differently (id + which upstream model + transport),
 * not over pricing or display metadata a box never acts on.
 */

import { createHash } from 'node:crypto';
import { SERVED_MANAGED_MODELS } from '../llm-gateway/models/served-managed-models';

export interface ManagedLineupEntry {
  id: string;
  upstreamModelId: string;
  transport: string;
}

/** Pure — the fingerprint is a function of the lineup, nothing else. */
export function fingerprintManagedLineup(models: readonly ManagedLineupEntry[]): string {
  const hash = createHash('sha256');
  for (const model of [...models].sort((a, b) => a.id.localeCompare(b.id))) {
    hash.update(`model\0${model.id}\0${model.upstreamModelId}\0${model.transport}\0`);
  }
  return hash.digest('hex');
}

let cached: string | null = null;

/**
 * The live fingerprint of `SERVED_MANAGED_MODELS`. Memoized: like
 * `RUNTIME_MANAGED_MODELS`, the served lineup is a deployment constant for the
 * lifetime of a process (parsed once from config + credentials at module
 * load), so recomputing per call buys nothing and costs a hash pass.
 */
export function managedLineupFingerprint(): string {
  if (cached === null) cached = fingerprintManagedLineup(SERVED_MANAGED_MODELS);
  return cached;
}

/** Test-only: drop the memo so a case can recompute against a mutated fixture. */
export function _resetManagedLineupFingerprintCache(): void {
  cached = null;
}
