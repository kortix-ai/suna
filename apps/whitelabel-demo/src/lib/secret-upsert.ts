import type { WorkspaceSecret } from '@kortix/sdk';
import { normalizeSecretKey } from './secret-collisions';

/**
 * What a secret write actually does, decided before it is sent.
 *
 * `POST /workspaces/{id}/secrets` is one endpoint for three different acts, and
 * the caller is the only one who knows which was intended:
 *
 * - CREATE   — a new identifier. Needs a value.
 * - ROTATE   — an identifier that already exists, same KEY, new value. The row
 *              keeps its identity, so every agent grant and every stored
 *              allowlist that names it keeps working.
 * - RETARGET — an identifier that already exists under a DIFFERENT KEY. Refused
 *              409 by the server: an identifier is a stable handle, and quietly
 *              re-pointing it would re-aim every grant that references it at
 *              another variable. Named here so the form can say so instead of
 *              surfacing the raw refusal.
 *
 * `identifier` defaults to `name` server-side. This app sends it explicitly
 * anyway: the whole point of the field is that the two are separable, and a
 * request that omits it teaches the reader the opposite.
 */

export interface SecretDraft {
  /** Unique per workspace. What grants and session allowlists reference. */
  identifier: string;
  /** The env KEY injected into the sandbox. Not unique. */
  name: string;
  value: string;
}

export type SecretWriteIntent =
  | { kind: 'create' }
  | { kind: 'rotate' }
  | { kind: 'retarget'; existingKey: string };

/**
 * The identifier a user gets for free while they only type a KEY. Untouched, an
 * identifier IS the key — the simple case, and the one every migrated workspace
 * is already in.
 */
export function defaultIdentifier(name: string): string {
  return name.trim();
}

/** Trim/upper-case exactly as the server will, so what the form checks is what it sends. */
export function normalizeSecretDraft(draft: SecretDraft): SecretDraft {
  const name = normalizeSecretKey(draft.name);
  return {
    name,
    identifier: defaultIdentifier(draft.identifier) || name,
    value: draft.value,
  };
}

export function secretWriteIntent(
  items: WorkspaceSecret[] | undefined,
  draft: SecretDraft,
): SecretWriteIntent {
  const { identifier, name } = normalizeSecretDraft(draft);
  const existing = (items ?? []).find((secret) => secret.identifier === identifier);
  if (!existing) return { kind: 'create' };
  if (normalizeSecretKey(existing.name) !== name) {
    return { kind: 'retarget', existingKey: existing.name };
  }
  return { kind: 'rotate' };
}

/** The `POST /secrets` body — both fields, always, plus the value. */
export function buildSecretUpsertInput(draft: SecretDraft): {
  identifier: string;
  name: string;
  value: string;
} {
  const { identifier, name, value } = normalizeSecretDraft(draft);
  return { identifier, name, value };
}

/**
 * A rotate is an upsert that reuses the row's existing KEY. Passing the key
 * back is not optional: the endpoint requires `name`, and sending anything else
 * turns the rotate into the 409 retarget above.
 */
export function buildSecretRotateInput(
  secret: Pick<WorkspaceSecret, 'identifier' | 'name'>,
  value: string,
): { identifier: string; name: string; value: string } {
  return buildSecretUpsertInput({ identifier: secret.identifier, name: secret.name, value });
}
