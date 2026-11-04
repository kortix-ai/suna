/**
 * Named provider accounts: a subscription login (a ChatGPT account, a Claude
 * account) stored as a project-scoped account resource that only the LLM
 * gateway reads. The sign-in flows of every provider write and reconnect them
 * here, with one set of sharing rules:
 *
 *   - a new account is private to its creator unless `sharing` says otherwise;
 *   - the creator always holds a grant;
 *   - a reconnect refreshes the login of the caller's own account in place and
 *     keeps its id, label, access and session selections.
 */
import { z } from '@hono/zod-openapi';
import { and, eq } from 'drizzle-orm';
import { accountSecretGrants, accountSecretResources } from '@kortix/db';
import { parseSharingIntent, type SharingIntent } from '../connectors/share';
import { accountMemberRow } from '../iam/membership-read';
import { recordAuditEvent } from '../shared/audit';
import { db } from '../shared/db';
import { encryptAccountSecret, memberMayReadProject } from './account-resource';

/** The kind of login an account holds: the resource's provider id and secret name. */
export interface ProviderAccountKind {
  providerId: string;
  name: string;
  /** The product name members read, e.g. "ChatGPT" or "Claude". */
  label: string;
}

/** A named connection only its owner can use: private, or restricted to the owner
 * alone. Anything wider shares a credential, which is a project secret write. */
export function sharingIsOwnerOnly(sharing: SharingIntent | undefined, ownerId: string): boolean {
  if (sharing?.mode === 'private') return true;
  return sharing?.mode === 'members' && !sharing.groupIds?.length &&
    (sharing.memberIds ?? []).every((memberId) => memberId === ownerId);
}

export type NamedConnectionInput =
  | { ok: true; label: string | null; resourceId: string | null; sharing?: SharingIntent; ownerOnly: boolean }
  | { ok: false; status: 400 | 403 | 404; error: string };

/**
 * Check a request that names a new account (`label`) or reconnects one
 * (`resourceId`). With neither, the caller gets a new account labelled
 * `defaultLabel`. `ownerOnly` is false when the account is shared beyond its
 * owner: the route then requires `project.secret.write`.
 */
export async function checkNamedConnection(input: {
  accountId: string;
  projectId: string;
  userId: string;
  kind: ProviderAccountKind;
  label: unknown;
  resourceId: unknown;
  sharing: unknown;
  defaultLabel: string;
}): Promise<NamedConnectionInput> {
  const { accountId, projectId, userId, kind } = input;
  const named = input.label === undefined || input.label === null ? null : typeof input.label === 'string' ? input.label.trim() : '';
  if (named !== null && (named.length < 1 || named.length > 100)) {
    return { ok: false, status: 400, error: `A ${kind.label} account needs a 1–100 character label` };
  }
  const resourceId = input.resourceId === undefined || input.resourceId === null ? null
    : typeof input.resourceId === 'string' ? input.resourceId.trim() : '';
  if (resourceId !== null && !z.string().uuid().safeParse(resourceId).success) {
    return { ok: false, status: 400, error: `resource_id must be the id of a ${kind.label} account` };
  }
  if (resourceId !== null && (named !== null || input.sharing != null)) {
    return { ok: false, status: 400, error: 'Reconnecting keeps the account label and access; send only resource_id' };
  }
  const [member] = await accountMemberRow(accountId, userId);
  if (!member) return { ok: false, status: 403, error: `An account member must own a ${kind.label} connection` };
  if (resourceId !== null) {
    const [resource] = await db.select({
      projectId: accountSecretResources.projectId,
      providerId: accountSecretResources.providerId,
      name: accountSecretResources.name,
      createdBy: accountSecretResources.createdBy,
    }).from(accountSecretResources)
      .where(and(eq(accountSecretResources.accountId, accountId), eq(accountSecretResources.secretId, resourceId)))
      .limit(1);
    if (!resource || resource.projectId !== projectId || resource.providerId !== kind.providerId || resource.name !== kind.name) {
      return { ok: false, status: 404, error: `${kind.label} account not found` };
    }
    // The login is the owner's own subscription; only they re-authorize it.
    // Account admins can still delete the account.
    if (resource.createdBy !== userId) {
      return { ok: false, status: 403, error: `Only the person who connected this ${kind.label} account can reconnect it` };
    }
    return { ok: true, label: null, resourceId, ownerOnly: true };
  }
  // No sharing named: the account is private to its creator.
  let sharing: SharingIntent = { mode: 'private', ownerId: userId };
  if (input.sharing != null) {
    const parsed = parseSharingIntent(input.sharing, userId);
    if (!parsed) return { ok: false, status: 400, error: 'invalid sharing — mode must be project|private|members' };
    sharing = parsed;
    if (sharing.mode === 'private' && sharing.ownerId !== userId) return { ok: false, status: 400, error: 'Invalid connection owner' };
    if (sharing.mode === 'members') {
      if (sharing.groupIds?.length || (sharing.memberIds?.length ?? 0) > 200) {
        return { ok: false, status: 400, error: 'Select up to 200 project members' };
      }
      for (const memberId of sharing.memberIds ?? []) {
        if (!z.string().uuid().safeParse(memberId).success || !(await memberMayReadProject(accountId, projectId, memberId))) {
          return { ok: false, status: 400, error: 'Member has no project access' };
        }
      }
    }
  }
  return { ok: true, label: named ?? input.defaultLabel, resourceId: null, sharing, ownerOnly: sharingIsOwnerOnly(sharing, userId) };
}

/** One completed sign-in creates one project-scoped account resource. `secretId`
 * is minted when the flow starts, so a repeated completion writes one row. */
export async function writeProviderAccount(input: {
  secretId: string;
  accountId: string;
  userId: string;
  projectId: string;
  label: string;
  value: string;
  kind: ProviderAccountKind;
  sharing?: SharingIntent;
}): Promise<string> {
  const { secretId, accountId, userId, projectId, label, value, kind, sharing } = input;
  const restricted = sharing?.mode === 'members' || sharing?.mode === 'private';
  const userIds = [...new Set([userId, ...(sharing?.mode === 'members' ? sharing.memberIds ?? [] : [])])];
  const created = await db.transaction(async (tx) => {
    const [row] = await tx.insert(accountSecretResources).values({
      secretId, accountId, projectId, accessMode: restricted ? 'members' : 'project', label, providerId: kind.providerId, name: kind.name,
      valueEnc: encryptAccountSecret(accountId, value), consumer: 'llm_gateway',
      strategy: 'broker', createdBy: userId,
    }).onConflictDoNothing().returning({ secretId: accountSecretResources.secretId });
    if (row) await tx.insert(accountSecretGrants).values(userIds.map((grantee) => ({ accountId, secretId, userId: grantee, grantedBy: userId })));
    return Boolean(row);
  });
  if (created) await recordAuditEvent({
    accountId, projectId, actorUserId: userId, actorType: 'human', source: 'api',
    action: 'secret.oauth.connected', resourceType: 'account_secret_resource', resourceId: secretId,
    metadata: { provider_id: kind.providerId, consumer: 'llm_gateway' },
  });
  return secretId;
}

/** Reconnect writes a fresh login into the caller's own account resource. A
 * deleted account, or one the caller did not create, matches no row, so a stale
 * flow never recreates it. */
export async function reconnectProviderAccount(input: {
  secretId: string;
  accountId: string;
  userId: string;
  projectId: string;
  value: string;
  kind: ProviderAccountKind;
}): Promise<{ secretId: string; label: string } | null> {
  const { secretId, accountId, userId, projectId, value, kind } = input;
  const [row] = await db.update(accountSecretResources).set({
    valueEnc: encryptAccountSecret(accountId, value),
    active: true,
    cooldownUntil: null,
    needsReauthAt: null,
    updatedAt: new Date(),
  }).where(and(
    eq(accountSecretResources.accountId, accountId),
    eq(accountSecretResources.secretId, secretId),
    eq(accountSecretResources.projectId, projectId),
    eq(accountSecretResources.providerId, kind.providerId),
    eq(accountSecretResources.name, kind.name),
    eq(accountSecretResources.createdBy, userId),
  )).returning({ secretId: accountSecretResources.secretId, label: accountSecretResources.label });
  if (!row) return null;
  await recordAuditEvent({
    accountId, projectId, actorUserId: userId, actorType: 'human', source: 'api',
    action: 'secret.oauth.connected', resourceType: 'account_secret_resource', resourceId: row.secretId,
    metadata: { provider_id: kind.providerId, consumer: 'llm_gateway', reconnected: true },
  });
  return row;
}
