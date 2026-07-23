/**
 * Persistent ACP permission-policy reader/writer (Task WS5-P1-a).
 *
 * Storage: `projects.metadata.acp_permission_policy` (JSONB — no migration,
 * mirrors the `harness_auth_routes` / `onboarding_completed_at` metadata-key
 * pattern in `composer-capabilities.ts` / `routes/r6.ts`).
 *
 * Deny-by-default is load-bearing here: an absent key, non-object metadata,
 * or a stored value that fails schema validation ALL resolve to the
 * conservative default (`{ autoApprove: 'none', toolDecisions: {} }`) —
 * exactly today's behavior (every ACP tool call prompts, nothing is
 * remembered). `readAcpPermissionPolicy` never throws, so a malformed or
 * legacy row degrades to "prompt for everything" instead of 500ing or —
 * worse — granting broader auto-approval than intended. The policy can only
 * ever REDUCE prompting friction relative to that floor; it never grants an
 * ACP tool call a user couldn't already click through by hand.
 *
 * `readAcpPermissionPolicy` is the reader the ACP bridge (P1-b/c) consumes.
 */
import { AcpPermissionPolicySchema, type AcpPermissionPolicy } from '@kortix/api-contract';

export const ACP_PERMISSION_POLICY_METADATA_KEY = 'acp_permission_policy';

const DEFAULT_ACP_PERMISSION_POLICY: AcpPermissionPolicy = Object.freeze({
  autoApprove: 'none',
  toolDecisions: {},
}) as AcpPermissionPolicy;

/**
 * Reads the project's ACP permission policy off its `metadata` JSONB blob.
 * Defaults-when-absent per the route contract; never throws.
 */
export function readAcpPermissionPolicy(projectMetadata: unknown): AcpPermissionPolicy {
  if (!projectMetadata || typeof projectMetadata !== 'object' || Array.isArray(projectMetadata)) {
    return DEFAULT_ACP_PERMISSION_POLICY;
  }
  const raw = (projectMetadata as Record<string, unknown>)[ACP_PERMISSION_POLICY_METADATA_KEY];
  if (raw === undefined) return DEFAULT_ACP_PERMISSION_POLICY;
  const parsed = AcpPermissionPolicySchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_ACP_PERMISSION_POLICY;
}

/**
 * Returns a NEW metadata object with the validated policy upserted under
 * `acp_permission_policy` — a full replace of the stored policy (not a deep
 * merge of `toolDecisions`), matching the route's "validated upsert"
 * contract. Every other metadata key is preserved untouched. The caller
 * still owns persisting the result (`db.update(projects).set({ metadata })`).
 */
export function writeAcpPermissionPolicy(
  projectMetadata: unknown,
  policy: AcpPermissionPolicy,
): Record<string, unknown> {
  const current = projectMetadata && typeof projectMetadata === 'object' && !Array.isArray(projectMetadata)
    ? { ...(projectMetadata as Record<string, unknown>) }
    : {};
  return { ...current, [ACP_PERMISSION_POLICY_METADATA_KEY]: policy };
}
