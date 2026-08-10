import type { WorkspaceSecret } from '@kortix/sdk';
import { isAllowlistable } from './secret-scope';

/**
 * Two secrets, one env KEY — legal to store, fatal to allowlist.
 *
 * A secret is `{ identifier, name (the env KEY), value }`. The identifier is
 * unique per workspace and is what an agent grant and a session allowlist
 * reference; the KEY deliberately is NOT unique, so GMAPS-primary and
 * GMAPS-backup can both inject GOOGLE_MAPS_API_KEY. Creating the second one
 * succeeds — and then any session whose allowlist names both is refused with
 * 409 SECRET_IDENTIFIER_KEY_COLLISION, because the sandbox cannot be handed two
 * values for one variable and the allowlist can never be edited to fix it.
 *
 * Nothing in the listed row says this. The collision only exists BETWEEN rows,
 * which is why it is computed here and shown on both of them, before the create
 * that would otherwise be the first place anyone hears about it.
 *
 * Only allowlistable (runtime-scoped) rows can collide — session create resolves
 * the allowlist against those alone, so a channel-install row sharing a KEY with
 * a runtime one is not a collision the server will ever raise.
 */

/** The env KEY as the server will store it (it upper-cases on write). */
export function normalizeSecretKey(name: string): string {
  return name.trim().toUpperCase();
}

/**
 * Every env KEY claimed by more than one identifier → the identifiers claiming
 * it, sorted. Keyed by the normalized KEY.
 */
export function keyCollisionGroups(items: WorkspaceSecret[] | undefined): Map<string, string[]> {
  const byKey = new Map<string, string[]>();
  for (const secret of items ?? []) {
    if (!isAllowlistable(secret)) continue;
    const key = normalizeSecretKey(secret.name);
    byKey.set(key, [...(byKey.get(key) ?? []), secret.identifier]);
  }
  const collisions = new Map<string, string[]>();
  for (const [key, identifiers] of byKey) {
    if (identifiers.length > 1) collisions.set(key, [...identifiers].sort());
  }
  return collisions;
}

/**
 * The OTHER identifiers sharing this row's env KEY — empty when the row is the
 * only claimant. What the per-row marker reads.
 */
export function collidingIdentifiers(
  items: WorkspaceSecret[] | undefined,
  identifier: string,
): string[] {
  const row = (items ?? []).find((secret) => secret.identifier === identifier);
  if (!row) return [];
  const group = keyCollisionGroups(items).get(normalizeSecretKey(row.name)) ?? [];
  return group.filter((id) => id !== identifier);
}

/**
 * The identifiers a not-yet-saved secret would collide with. Checked while the
 * form is being filled in, so the warning lands before the write rather than at
 * the session create three screens later.
 *
 * An identifier that already exists is a ROTATE of that same row, not a second
 * claimant, so it is excluded.
 */
export function pendingKeyCollision(
  items: WorkspaceSecret[] | undefined,
  draft: { identifier: string; name: string },
): string[] {
  const key = normalizeSecretKey(draft.name);
  if (!key) return [];
  return (items ?? [])
    .filter(
      (secret) =>
        isAllowlistable(secret) &&
        secret.identifier !== draft.identifier.trim() &&
        normalizeSecretKey(secret.name) === key,
    )
    .map((secret) => secret.identifier)
    .sort();
}
