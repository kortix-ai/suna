import { roleAssignments } from '@kortix/db';
import { isNull, notInArray, or } from 'drizzle-orm';

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
export const AUDIENCE_OBJECT_TYPES = ['secret', 'connection'];

export function isAudienceObjectType(objectType: string | null | undefined): boolean {
  return !!objectType && AUDIENCE_OBJECT_TYPES.includes(objectType);
}

/** A `role_assignments` filter: every row except an audience grant. */
export function notAnAudienceGrant() {
  return or(isNull(roleAssignments.objectType), notInArray(roleAssignments.objectType, AUDIENCE_OBJECT_TYPES));
}
