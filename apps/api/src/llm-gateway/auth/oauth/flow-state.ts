/**
 * Opaque, project-key-encrypted flow-handle helpers — docs/specs/2026-07-22-
 * unified-auth-gateway.md §3.1/§6.3. Generalizes the inline
 * `encryptProjectSecret(projectId, JSON.stringify({...}))` /
 * `JSON.parse(decryptProjectSecret(...))` pattern that
 * `projects/routes/r3.ts`'s Codex device flow already proved (r3.ts:768-777
 * seal, r3.ts:819-832 open) into ONE reusable `{ seal, open }` pair every
 * provider adapter calls.
 *
 * Why this pattern (unchanged from r3's rationale): the whole in-flight state
 * round-trips through the client as ciphertext, so there is NO server-side
 * flow table and ANY replica can serve any poll (start and poll need not hit
 * the same pod). The key is project-scoped, so a handle minted for one
 * project — or a tampered one — simply fails to decrypt and reads as expired,
 * never forgeable or cross-project readable.
 */
import { decryptProjectSecret, encryptProjectSecret } from '../../../projects/secrets';

/** Seal arbitrary per-provider flow state into an opaque handle for the client. */
export function sealFlowState<T>(projectId: string, state: T): string {
  return encryptProjectSecret(projectId, JSON.stringify(state));
}

/**
 * Open a handle sealed by {@link sealFlowState}. Returns `null` for anything
 * that doesn't decrypt+parse — a handle from another project, a tampered one,
 * or garbage — which every caller treats as `expired` (never a crash), exactly
 * as r3's Codex poll does today.
 */
export function openFlowState<T>(projectId: string, handle: string): T | null {
  try {
    return JSON.parse(decryptProjectSecret(projectId, handle)) as T;
  } catch {
    return null;
  }
}
