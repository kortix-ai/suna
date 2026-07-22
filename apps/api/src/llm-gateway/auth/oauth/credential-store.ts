import { projectSecrets } from '@kortix/db';
/**
 * Generalized OAuth-credential persistence — docs/specs/2026-07-22-unified-
 * auth-gateway.md §6.3/§10.1. A verbatim extraction of `projects/routes/
 * r3.ts`'s Codex-specific `writeCodexAuthSecret` (r3.ts:631-688) and
 * `authExpiresInMs` (r3.ts:691-705), parameterized by `secretName` so it
 * serves ANY account-door provider rather than being hardcoded to
 * `CODEX_AUTH_JSON`. r3's own helpers now delegate here (compatibility alias,
 * Step 3) so there is exactly one implementation of the shared/personal
 * insert precedence — no drift between the old `/oauth/*` routes and the new
 * `/oauth-credentials/*` routes.
 *
 * `sharing` only ever chooses private-vs-shared here — member/group secret
 * sharing was retired (see `projects/secrets.ts`). A provider-specific
 * credential row (e.g. `CODEX_AUTH_JSON`) is never overwritten by a generic
 * one and vice-versa: the caller owns the `secretName`.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { SharingIntent } from '../../../executor/share';
import { propagateProjectSecretsToActiveSandboxes } from '../../../projects/lib/sandbox-env-sync';
import { loadSecretViewsForUser } from '../../../projects/lib/serializers';
import { encryptProjectSecret } from '../../../projects/secrets';
import { db } from '../../../shared/db';
import { isGatewayManagedEnv } from '../../sandbox-credentials';

export interface WriteOAuthCredentialInput {
  projectId: string;
  userId: string;
  /** The `project_secrets` name/identifier this credential is stored under. */
  secretName: string;
  value: string;
  sharing?: SharingIntent | null;
}

/**
 * Persists an OAuth credential as a project secret — private (the caller's own
 * per-user login, `ownerUserId`-scoped) when `sharing.mode === 'private'`, else
 * the project-wide shared row — then returns the caller's view of it. Mirrors
 * r3's `writeCodexAuthSecret` insert/onConflict shape exactly.
 */
export async function writeOAuthCredentialSecret(input: WriteOAuthCredentialInput) {
  const { projectId, userId, secretName, value, sharing } = input;
  const now = new Date();

  if (sharing?.mode === 'private') {
    await db
      .insert(projectSecrets)
      .values({
        projectId,
        identifier: secretName,
        name: secretName,
        valueEnc: encryptProjectSecret(projectId, value),
        ownerUserId: userId,
        active: true,
        createdBy: userId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [projectSecrets.projectId, projectSecrets.name, projectSecrets.ownerUserId],
        targetWhere: sql`${projectSecrets.ownerUserId} is not null`,
        set: {
          valueEnc: encryptProjectSecret(projectId, value),
          active: true,
          updatedAt: now,
        },
      });
  } else {
    await db
      .insert(projectSecrets)
      .values({
        projectId,
        identifier: secretName,
        name: secretName,
        valueEnc: encryptProjectSecret(projectId, value),
        createdBy: userId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [projectSecrets.projectId, projectSecrets.identifier],
        targetWhere: isNull(projectSecrets.ownerUserId),
        set: {
          valueEnc: encryptProjectSecret(projectId, value),
          updatedAt: now,
        },
      });
  }

  void propagateProjectSecretsToActiveSandboxes(projectId, { refreshModels: true });

  const views = await loadSecretViewsForUser(projectId, userId, true);
  return (
    views.find((v) => v.identifier === secretName) ?? { identifier: secretName, name: secretName }
  );
}

/** Removes the backing secret for an OAuth credential (all scopes for the name). */
export async function deleteOAuthCredentialSecret(input: {
  projectId: string;
  secretName: string;
}): Promise<void> {
  const { projectId, secretName } = input;
  await db
    .delete(projectSecrets)
    .where(and(eq(projectSecrets.projectId, projectId), eq(projectSecrets.name, secretName)));
  void propagateProjectSecretsToActiveSandboxes(projectId, {
    refreshModels: isGatewayManagedEnv(secretName),
  });
}

/**
 * Best-effort token expiry (ms remaining) from a stored OpenCode-shaped
 * `auth.json`, for display. Verbatim from r3's `authExpiresInMs`: the JSON is
 * keyed by provider (`{ openai: { expires, ... } }`); the first numeric
 * `expires` found wins.
 */
export function oauthAuthExpiresInMs(authJson: string): number | null {
  try {
    const parsed = JSON.parse(authJson);
    for (const entry of Object.values(parsed ?? {})) {
      const expires = (entry as { expires?: unknown })?.expires;
      if (typeof expires === 'number' && Number.isFinite(expires)) {
        return Math.max(0, expires - Date.now());
      }
    }
  } catch {
    // not parseable / no expiry — treat as unknown
  }
  return null;
}
