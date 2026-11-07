// Internal: the wire encoding of the assignment calls, shared by the account
// names (`/accounts/:accountId/iam/assignments`, assignments.ts) and the
// workspace names (`/workspaces/:workspaceId/iam/assignments`, workspaces.ts).
// Each caller keeps its own literal path (route-contract.test.ts resolves
// them). Not re-exported from index.ts: no public name.

import type { AssignmentInput, ListAssignmentsFilter } from './assignments';
import { appendQuery } from './iam-query';

/** The list filter as a query string (`''` when empty). */
export function assignmentQuery(filter: ListAssignmentsFilter | undefined) {
  return appendQuery({
    principal_type: filter?.principalType,
    principal_id: filter?.principalId,
    scope_type: filter?.scopeType,
    scope_id: filter?.scopeId,
    object_type: filter?.objectType,
    object_id: filter?.objectId,
    role_id: filter?.roleId,
    include_expired: filter?.includeExpired ? 'true' : undefined,
  });
}

/** The create body: one role, to one principal, at one scope, as one row. */
export function assignmentBody(input: AssignmentInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    principal_type: input.principal.type,
    principal_id: input.principal.id,
    scope_type: input.scope.type,
    scope_id: input.scope.type === 'project' ? input.scope.id : null,
  };
  if (input.roleId) body.role_id = input.roleId;
  else body.role_key = input.roleKey;
  if (input.object) {
    body.object_type = input.object.type;
    body.object_id = input.object.id;
  }
  // Omitted means permanent; an explicit `null` says so on the wire. Both are
  // permanent — the distinction matters only to a PATCH-shaped caller.
  if (input.expiresAt !== undefined) body.expires_at = input.expiresAt;
  return body;
}
