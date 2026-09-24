/**
 * Who a connector connection acts as, and what it is called.
 *
 * A connection's `label` is how operators tell accounts apart, but it is
 * chosen before authorization and says nothing about WHICH login was used.
 * A project-shared account authorized with a personal login looked exactly
 * like one authorized with the shared login. These helpers record the
 * authorized identity (`metadata.connected_as`) and let a generic default
 * label become that identity, so the mismatch is visible the moment it lands.
 */
import { connectorConnections, connectors } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { isUniqueViolation } from '../shared/postgres-errors';

/** The authorized identity: an email, a login, or a display name. */
export const CONNECTED_AS_KEY = 'connected_as';

/**
 * Marks the row an `ensure*Connection` call owns. Those calls used to find
 * their row again by its default label only, so a renamed row made the next
 * connect create a duplicate. The marker survives a rename.
 */
export const DEFAULT_SLOT_KEY = 'default_slot';
export type DefaultSlot = 'member' | 'project';

/** The label `ensureMemberConnection` writes when the caller names none. */
export const DEFAULT_MEMBER_LABEL = 'Private connection';

/** Labels the web connect hooks write when the user names none. */
const GENERIC_LABELS = new Set(['private connection', 'project connection']);

/** Words `--account` resolves before labels (`selectEntitledConnectorConnection`). */
const RESERVED_LABELS = new Set(['me', 'project']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Metadata keys that belong to the ROW, not to one authorization attempt. */
const ROW_METADATA_KEYS = ['connector_slug', DEFAULT_SLOT_KEY] as const;

export function connectedAsOf(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const value = (metadata as Record<string, unknown>)[CONNECTED_AS_KEY];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * The row-level keys to carry into a metadata object that replaces the old
 * one wholesale (every Composio connect and finalize does that). Without
 * this, the first finalize erased the slot marker.
 */
export function rowMetadata(metadata: unknown): Record<string, unknown> {
  if (!metadata || typeof metadata !== 'object') return {};
  const source = metadata as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  for (const key of ROW_METADATA_KEYS) {
    if (typeof source[key] === 'string' && source[key]) kept[key] = source[key];
  }
  return kept;
}

/**
 * True when nobody chose `label`: the defaults the API and web write when the
 * caller names no label. Only those are replaced by the authorized identity.
 * A label a person typed is never overwritten.
 */
export function isGenericConnectionLabel(label: string, connectorName: string | null): boolean {
  const normalized = label.trim().toLowerCase();
  if (GENERIC_LABELS.has(normalized)) return true;
  return !!connectorName && normalized === connectorName.trim().toLowerCase();
}

/**
 * Validate a label a person asked for. Returns the trimmed label, or the
 * reason it is refused. `me`, `project`, and UUID-shaped labels are refused
 * because `--account` resolves those before labels, so such a connection
 * could not be selected by its name.
 */
export function validateConnectionLabel(
  raw: unknown,
): { ok: true; label: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: 'label must be a string' };
  const label = raw.trim();
  if (!label) return { ok: false, error: 'label must not be empty' };
  if (label.length > 255) return { ok: false, error: 'label must be at most 255 characters' };
  if (RESERVED_LABELS.has(label.toLowerCase())) {
    return { ok: false, error: `"${label}" is reserved for --account selection; choose another label` };
  }
  if (UUID.test(label)) {
    return { ok: false, error: 'label must not look like a connection id' };
  }
  return { ok: true, label };
}

/**
 * The identity to store after a finalize. Reuses the stored one when the
 * connected account did not change, so a repeated finalize poll does not
 * call the provider again.
 */
export async function resolveConnectedAs(input: {
  previous: Record<string, unknown>;
  connectedAccountId: string | undefined;
  isNoAuth: boolean;
  probe: () => Promise<string | null>;
}): Promise<string | null> {
  if (input.isNoAuth || !input.connectedAccountId) return null;
  const stored = connectedAsOf(input.previous);
  if (stored && input.previous.connected_account_id === input.connectedAccountId) return stored;
  return input.probe();
}

/** The slot an ensure*Connection call recognizes this row by, from its label. */
function ensuredSlot(ownerType: string, label: string, connectorName: string | null): DefaultSlot | null {
  if (ownerType === 'member' && label === DEFAULT_MEMBER_LABEL) return 'member';
  if (ownerType === 'project' && connectorName && label === connectorName) return 'project';
  return null;
}

/**
 * Replace a generic default label with the authorized identity. A label a
 * person chose stays. When another connection in the same owner scope
 * already carries that label, the unique index refuses the rename. The
 * label then stays as it is, and `connected_as` still shows the identity.
 *
 * Returns the label the row carries afterwards.
 */
export async function relabelToIdentity(input: {
  connectionId: string;
  identity: string;
}): Promise<string | null> {
  const [row] = await db
    .select({
      label: connectorConnections.label,
      ownerType: connectorConnections.ownerType,
      connectorName: connectors.name,
    })
    .from(connectorConnections)
    .innerJoin(connectors, eq(connectors.connectorId, connectorConnections.connectorId))
    .where(eq(connectorConnections.connectionId, input.connectionId))
    .limit(1);
  if (!row) return null;
  if (row.label === input.identity) return row.label;
  if (!isGenericConnectionLabel(row.label, row.connectorName)) return row.label;
  const slot = ensuredSlot(row.ownerType, row.label, row.connectorName);
  try {
    await db
      .update(connectorConnections)
      .set({
        label: input.identity,
        // Keep the ensure*Connection lookup working once its default label is gone.
        ...(slot
          ? {
              metadata: sql`${connectorConnections.metadata} || ${JSON.stringify({ [DEFAULT_SLOT_KEY]: slot })}::jsonb`,
            }
          : {}),
      })
      .where(
        and(
          eq(connectorConnections.connectionId, input.connectionId),
          eq(connectorConnections.label, row.label),
        ),
      );
    return input.identity;
  } catch (error) {
    if (isUniqueViolation(error)) return row.label;
    throw error;
  }
}
