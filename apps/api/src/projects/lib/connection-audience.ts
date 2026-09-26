/**
 * Who may USE a shared connector account — its audience — resolved for one
 * person. The rule that consumes it is `connectionIsReachable`
 * (`connection-access.ts`); this module only reads the grants.
 *
 * The audience is `connection` object grants in `kortix.role_assignments`, the
 * one grant store, written through `assignRole` like every other grant. A
 * shared account with no grant stays usable by the whole project, exactly as
 * before grants existed, so no existing row changes meaning.
 */
// A namespace import, not named ones: `session-connector-bindings.ts` imports
// this module, and suites that stub `iam/authorize` with an explicit export
// list would otherwise fail to LINK on a name they omit. Every stub returns an
// empty grant map, which answers `open` before the other two are touched.
import * as iamAuthorize from '../../iam/authorize';
import type { ConnectionAudienceReach } from './connection-access';

interface AudienceGrant {
  principalType: string;
  principalId: string;
}

/** One shared account's grants, resolved for one person. */
export function audienceReachOf(
  grants: readonly AudienceGrant[] | undefined,
  userId: string | null,
  groupIds: ReadonlySet<string>,
): ConnectionAudienceReach {
  if (!grants || grants.length === 0) return 'open';
  if (grants.some((grant) => grant.principalType === 'project')) return 'open';
  if (!userId) return 'out';
  return grants.some((grant) => iamAuthorize.objectGrantReaches(grant, userId, groupIds))
    ? 'in'
    : 'out';
}

/**
 * The person a call acts for, whose audience membership decides: the
 * `on_behalf_of` human under an agent principal, nobody for any other service
 * account, else the acting user.
 */
export function audiencePersonId(input: {
  actingUserId: string;
  actingPrincipalIsServiceAccount: boolean;
  agentPrincipal?: { onBehalfOfUserId: string | null } | null;
}): string | null {
  if (input.agentPrincipal) return input.agentPrincipal.onBehalfOfUserId;
  if (input.actingPrincipalIsServiceAccount) return null;
  return input.actingUserId || null;
}

/**
 * Every shared account's audience in one project, for one person. Two memoized
 * reads: the project's `connection` grants and the person's groups. A project
 * with no narrowed account answers `open` without the second read.
 */
export async function loadConnectionAudience(input: {
  projectId: string;
  accountId: string;
  userId: string | null;
}): Promise<(connectionId: string) => ConnectionAudienceReach> {
  const grants = await iamAuthorize.loadObjectGrants(input.projectId, 'connection');
  if (grants.size === 0) return () => 'open';
  const userId = input.userId ? input.userId : null;
  const record = userId
    ? await iamAuthorize.resolvePrincipal({ type: 'user', id: userId }, input.accountId)
    : null;
  const groupIds = new Set(record?.groupIds ?? []);
  return (connectionId) => audienceReachOf(grants.get(connectionId), userId, groupIds);
}
