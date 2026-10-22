import { roleAssignments } from '@kortix/db';
import { sql } from 'drizzle-orm';

/**
 * Object types whose grants are an AUDIENCE. A secret value or a shared
 * connector account with no grant is usable by everyone in the project
 * (`projects/lib/secret-audience.ts`, `projects/lib/connection-audience.ts`),
 * so deleting its LAST grant widens it instead of closing it.
 *
 * Bulk deletes that offboard or promote a person, or remove a group or a
 * service account, therefore keep these rows. A grant to a principal that is
 * gone reaches nobody, so the value stays closed and still lists who it was
 * for. Only the object's own audience setting, or deleting the object, removes
 * an audience grant.
 */
export const AUDIENCE_OBJECT_TYPES = ['secret', 'connection'] as const;

export function isAudienceObjectType(objectType: string | null | undefined): boolean {
  return !!objectType && (AUDIENCE_OBJECT_TYPES as readonly string[]).includes(objectType);
}

/**
 * A `role_assignments` filter: every row except an audience grant. One `sql`
 * fragment, because unit suites stub `drizzle-orm` with explicit export lists.
 */
export function notAnAudienceGrant() {
  const [secret, connection] = AUDIENCE_OBJECT_TYPES;
  return sql`(${roleAssignments.objectType} is null or ${roleAssignments.objectType} not in (${secret}, ${connection}))`;
}
