// SCIM Users routes: GET (list + filter), GET/:id, POST, PATCH, DELETE.
// Registers onto the shared scimRouter via side effect.

import { createRoute, z } from '@hono/zod-openapi';
import { accountInvitations, accountMembers } from '@kortix/db';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { invalidateIamCacheForUser } from '../iam/cache-invalidation';
import { scimError } from '../middleware/scim-auth';
import { errors, json } from '../openapi';
import { revokeAllAccountTokensForUser } from '../repositories/account-tokens';
import { db } from '../shared/db';
import {
  ScimResource,
  type UserShape,
  buildInviteUser,
  buildUser,
  emailsByUserId,
  isUnsupportedFilter,
  listResponse,
  parseFilter,
  scimAudit,
  scimRouter,
  userIdByEmail,
} from './app';

// ─── Users ────────────────────────────────────────────────────────────────

/**
 * Pending (unaccepted, unexpired) invitations for an account. SCIM presents
 * account members AND pending invites uniformly, so the IdP sees every person
 * it pushed — invited users included — as a resolvable, active account rather
 * than a create that appears to have vanished.
 */
async function pendingInviteRows(
  accountId: string,
  onlyInviteId?: string,
): Promise<Array<{ inviteId: string; email: string; createdAt: Date }>> {
  const conds = [
    eq(accountInvitations.accountId, accountId),
    isNull(accountInvitations.acceptedAt),
    gt(accountInvitations.expiresAt, new Date()),
  ];
  if (onlyInviteId) conds.push(eq(accountInvitations.inviteId, onlyInviteId));
  return db
    .select({
      inviteId: accountInvitations.inviteId,
      email: accountInvitations.email,
      createdAt: accountInvitations.createdAt,
    })
    .from(accountInvitations)
    .where(and(...conds));
}

type MemberRow = {
  userId: string;
  accountRole: string;
  scimExternalId: string | null;
  joinedAt: Date;
};

async function getMember(accountId: string, userId: string): Promise<MemberRow | null> {
  const [member] = await db
    .select({
      userId: accountMembers.userId,
      accountRole: accountMembers.accountRole,
      scimExternalId: accountMembers.scimExternalId,
      joinedAt: accountMembers.joinedAt,
    })
    .from(accountMembers)
    .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, userId)))
    .limit(1);
  return member ?? null;
}

/**
 * A pending invitation is "shadowed" when its email already belongs to a live
 * member — the person signed in via SSO JIT instead of accepting the invite.
 * The IdP still references them by the invitation id it cached at provisioning
 * time, so id-addressed operations must resolve through the email to the real
 * member or deprovisioning silently no-ops (the offboarding hole).
 */
async function shadowMemberForInvite(
  accountId: string,
  inviteEmail: string,
): Promise<MemberRow | null> {
  const resolvedUserId = await userIdByEmail(inviteEmail, accountId);
  if (!resolvedUserId) return null;
  return getMember(accountId, resolvedUserId);
}

/**
 * Deprovision a live member: remove the membership, bust the IAM cache, and
 * revoke PATs + live sandbox tokens. Callers must run the last-owner guard
 * BEFORE calling. Returns the token-revocation error message (if any) for the
 * audit event; the membership removal itself always proceeds.
 */
async function deprovisionMember(accountId: string, userId: string): Promise<string | null> {
  await db
    .delete(accountMembers)
    .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, userId)));
  invalidateIamCacheForUser(userId);
  return revokeAllAccountTokensForUser(userId, accountId).then(
    () => null,
    (err) => {
      console.error(
        '[scim] token revocation FAILED on deprovision — user may retain live tokens',
        { userId, accountId },
        err,
      );
      return err instanceof Error ? err.message : String(err);
    },
  );
}

/** Last-owner guard shared by every deprovision path. */
async function isLastOwner(accountId: string, member: MemberRow): Promise<boolean> {
  if (member.accountRole !== 'owner') return false;
  const owners = await db
    .select({ userId: accountMembers.userId })
    .from(accountMembers)
    .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.accountRole, 'owner')));
  return owners.length <= 1;
}

scimRouter.openapi(
  createRoute({
    method: 'get',
    path: '/accounts/{accountId}/Users',
    tags: ['scim'],
    summary: 'List SCIM Users (filter by userName/id/externalId eq)',
    request: {
      params: z.object({ accountId: z.string() }),
      query: z.object({ filter: z.string().optional() }),
    },
    responses: {
      200: json(ScimResource, 'SCIM ListResponse'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
    const accountId = c.req.param('accountId');
    const rawFilter = c.req.query('filter');
    // A supplied-but-unsupported filter is a 400, not a silent full-list dump
    // (RFC 7644 §3.4.2.2) — otherwise the IdP thinks it filtered and quietly gets
    // the whole directory.
    if (isUnsupportedFilter(rawFilter)) {
      return scimError(c, 400, 'Unsupported filter — only `attribute eq "value"` is supported');
    }
    const filter = parseFilter(rawFilter);

    // Load every member for the account; cheap because directories that
    // bother with SCIM tend to have <1000 members in a single account.
    const members = await db
      .select({
        userId: accountMembers.userId,
        scimExternalId: accountMembers.scimExternalId,
        joinedAt: accountMembers.joinedAt,
      })
      .from(accountMembers)
      .where(eq(accountMembers.accountId, accountId));

    const emails = await emailsByUserId(members.map((m) => m.userId));
    const invites = await pendingInviteRows(accountId);
    // Hide invites shadowed by a live member (same email, joined via SSO JIT
    // instead of accepting) — otherwise the IdP sees TWO resources with one
    // userName and reconciles against the stale invite id.
    const memberEmails = new Set(
      [...emails.values()].map((e) => e.trim().toLowerCase()).filter(Boolean),
    );
    const allResources: UserShape[] = [
      ...members
        .filter((m) => emails.has(m.userId))
        .map((m) => buildUser(accountId, m, emails.get(m.userId)!)),
      ...invites
        .filter((i) => !memberEmails.has(i.email.trim().toLowerCase()))
        .map((i) => buildInviteUser(accountId, i)),
    ];

    if (!filter) return c.json(listResponse(allResources));

    // Only `userName eq` / `id eq` / `externalId eq` are interesting in
    // practice. Anything else returns an empty list rather than 400 — the
    // IdP can fall back to listing.
    const filtered: UserShape[] =
      filter.attr === 'userName'
        ? (() => {
            const v = filter.value.toLowerCase();
            return allResources.filter((u) => u.userName.toLowerCase() === v);
          })()
        : filter.attr === 'id'
          ? allResources.filter((u) => u.id === filter.value)
          : filter.attr === 'externalId'
            ? allResources.filter((u) => u.externalId === filter.value)
            : [];

    return c.json(listResponse(filtered));
  },
);

scimRouter.openapi(
  createRoute({
    method: 'get',
    path: '/accounts/{accountId}/Users/{userId}',
    tags: ['scim'],
    summary: 'Get a SCIM User',
    request: { params: z.object({ accountId: z.string(), userId: z.string() }) },
    responses: {
      200: json(ScimResource, 'SCIM User'),
      ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
    const accountId = c.req.param('accountId');
    const userId = c.req.param('userId');

    const [member] = await db
      .select({
        userId: accountMembers.userId,
        scimExternalId: accountMembers.scimExternalId,
        joinedAt: accountMembers.joinedAt,
      })
      .from(accountMembers)
      .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, userId)))
      .limit(1);
    if (member) {
      const emails = await emailsByUserId([userId]);
      const email = emails.get(userId);
      if (email) return c.json(buildUser(accountId, member, email));
    }

    // Not a live member — maybe a pending invitation (SCIM id = invitation id).
    const [invite] = await pendingInviteRows(accountId, userId);
    if (invite) {
      // Shadowed by a JIT member → 404 so the IdP re-resolves by userName and
      // picks up the member's id (list/GET hide the stale invite identity).
      const shadow = await shadowMemberForInvite(accountId, invite.email);
      if (shadow) return scimError(c, 404, 'User not found in this account');
      return c.json(buildInviteUser(accountId, invite));
    }

    return scimError(c, 404, 'User not found in this account');
  },
);

scimRouter.openapi(
  createRoute({
    method: 'post',
    path: '/accounts/{accountId}/Users',
    tags: ['scim'],
    summary: 'Create / provision a SCIM User',
    request: {
      params: z.object({ accountId: z.string() }),
      body: { content: { 'application/json': { schema: ScimResource } } },
    },
    responses: {
      200: json(ScimResource, 'SCIM User (already a member)'),
      201: json(ScimResource, 'SCIM User created / invited'),
      ...errors(400, 401, 403),
    },
  }),
  async (c: any) => {
    const accountId = c.req.param('accountId');
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return scimError(c, 400, 'Body must be JSON');
    }

    const userName = typeof body.userName === 'string' ? body.userName.trim() : '';
    if (!userName) return scimError(c, 400, 'userName is required');

    const externalId =
      typeof body.externalId === 'string' && body.externalId.trim() ? body.externalId.trim() : null;

    // Look up an existing Supabase user by email. If none, send an invite —
    // we don't have permission to create a passwordless auth user without
    // additional infra (magic link), so an invite is the safe v1 default.
    const existingUserId = await userIdByEmail(userName, accountId);
    if (!existingUserId) {
      // Create or refresh a pending invitation; the IdP retries on next sync
      // so the eventual sign-up gets reconciled.
      const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
      const [invite] = await db
        .insert(accountInvitations)
        .values({
          accountId,
          email: userName.toLowerCase(),
          initialRole: 'member',
          expiresAt,
          invitedBy: null,
        })
        .onConflictDoUpdate({
          target: [accountInvitations.accountId, accountInvitations.email],
          set: { expiresAt, initialRole: 'member', acceptedAt: null },
        })
        .returning();

      await scimAudit(c, {
        accountId,
        action: 'scim.user.invite',
        resourceType: 'account_invitation',
        resourceId: invite.inviteId,
        after: { email: userName, external_id: externalId },
      });

      // SCIM expects a User resource even when the human hasn't joined yet. We
      // return it as active:true (an invited account IS enabled) with
      // id=invite.inviteId, so the IdP records the push as successful instead of
      // looping to "reactivate" a user it thinks we deactivated.
      return c.json(
        buildInviteUser(
          accountId,
          {
            inviteId: invite.inviteId,
            email: userName.toLowerCase(),
            createdAt: invite.createdAt,
            externalId,
          },
          true,
        ),
        201,
      );
    }

    // User exists in Supabase — make sure they're a member of this account.
    // If already a member, refresh the externalId; otherwise insert. SCIM is
    // expected to be idempotent.
    const [existingMember] = await db
      .select({ userId: accountMembers.userId })
      .from(accountMembers)
      .where(
        and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, existingUserId)),
      )
      .limit(1);

    if (existingMember) {
      if (externalId) {
        await db
          .update(accountMembers)
          .set({ scimExternalId: externalId })
          .where(
            and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, existingUserId)),
          );
      }
    } else {
      await db.insert(accountMembers).values({
        accountId,
        userId: existingUserId,
        accountRole: 'member',
        scimExternalId: externalId,
      });
      invalidateIamCacheForUser(existingUserId);
    }

    const [member] = await db
      .select({
        userId: accountMembers.userId,
        scimExternalId: accountMembers.scimExternalId,
        joinedAt: accountMembers.joinedAt,
      })
      .from(accountMembers)
      .where(
        and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, existingUserId)),
      )
      .limit(1);

    await scimAudit(c, {
      accountId,
      action: existingMember ? 'scim.user.update' : 'scim.user.create',
      resourceType: 'account_member',
      resourceId: existingUserId,
      after: { user_id: existingUserId, external_id: externalId, email: userName },
    });

    return c.json(buildUser(accountId, member!, userName), existingMember ? 200 : 201);
  },
);

/**
 * PATCH is the workhorse for IdP sync. Okta uses it to set active=false
 * when deprovisioning. We support a minimal interpretation:
 *   - { "active": false } → remove the user from this account
 *   - { "active": true }  → no-op if already present, re-add if missing-but-known
 *   - { "Operations": [{ op:"replace", path:"active", value:false }, ...] } → same
 *
 * Anything more exotic returns 400 — clearer than silently ignoring.
 */
scimRouter.openapi(
  createRoute({
    method: 'patch',
    path: '/accounts/{accountId}/Users/{userId}',
    tags: ['scim'],
    summary: 'Patch a SCIM User (deactivate / update externalId)',
    request: {
      params: z.object({ accountId: z.string(), userId: z.string() }),
      body: { content: { 'application/json': { schema: ScimResource } } },
    },
    responses: {
      200: json(ScimResource, 'SCIM User'),
      204: { description: 'No content (deactivated / idempotent)' },
      ...errors(400, 401, 403, 404, 409),
    },
  }),
  async (c: any) => {
    const accountId = c.req.param('accountId');
    const userId = c.req.param('userId');

    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return scimError(c, 400, 'Body must be JSON');
    }

    // Normalise both shapes (top-level fields OR Operations array) into a
    // map of field → value.
    const changes = new Map<string, unknown>();
    if (Array.isArray(body.Operations)) {
      for (const op of body.Operations as Array<Record<string, unknown>>) {
        const opName = typeof op.op === 'string' ? op.op.toLowerCase() : null;
        if (opName !== 'replace' && opName !== 'add') continue;
        const path = typeof op.path === 'string' ? op.path : 'active';
        changes.set(path, op.value);
      }
    } else {
      for (const k of Object.keys(body)) changes.set(k, body[k]);
    }

    return applyUserWrite(c, accountId, userId, changes);
  },
);

/**
 * Shared write path for PATCH and PUT. Resolves the SCIM id to a live member OR
 * a pending invitation and applies the change:
 *   - active:false  → deprovision (remove the member / revoke the invite)
 *   - externalId    → stored on the member row
 *   - anything else → accepted as a no-op, 200 with the current resource, so an
 *     IdP "push profile update" doesn't error.
 * Returns 404 only when the id matches neither a member nor a pending invite.
 */
async function applyUserWrite(
  c: any,
  accountId: string,
  userId: string,
  changes: Map<string, unknown>,
) {
  const member = await getMember(accountId, userId);

  if (member) {
    // Deactivate
    if (changes.get('active') === false) {
      // Refuse to deactivate the last owner — same invariant the human UI
      // enforces, so an IdP misconfiguration can't lock everyone out.
      if (await isLastOwner(accountId, member)) {
        return scimError(c, 409, 'Cannot deactivate the last owner of this account');
      }
      const emailsBefore = await emailsByUserId([userId]);
      // IdP-driven offboarding: remove the membership and revoke PATs + live
      // sandbox session tokens so deactivation is immediate. A revocation
      // failure would leave a "deactivated" user with LIVE tokens — a silent
      // offboarding hole — so it's logged loudly and recorded on the audit
      // event, while the membership removal still stands.
      const revocationError = await deprovisionMember(accountId, userId);
      await scimAudit(c, {
        accountId,
        action: 'scim.user.deactivate',
        resourceType: 'account_member',
        resourceId: userId,
        before: { user_id: userId, account_role: member.accountRole },
        ...(revocationError
          ? { metadata: { token_revocation_failed: true, token_revocation_error: revocationError } }
          : {}),
      });
      // 200 + the deactivated resource (not a bare 204): Okta / Azure AD expect
      // the patched User back with active:false to confirm deprovisioning.
      return c.json(buildUser(accountId, member, emailsBefore.get(userId) ?? member.userId, false));
    }

    if (changes.has('externalId') && typeof changes.get('externalId') === 'string') {
      const ext = changes.get('externalId') as string;
      await db
        .update(accountMembers)
        .set({ scimExternalId: ext })
        .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, userId)));
      member.scimExternalId = ext;
    }
    const emails = await emailsByUserId([userId]);
    return c.json(buildUser(accountId, member, emails.get(userId) ?? ''));
  }

  // Not a live member — maybe a pending invitation (SCIM id = invitation id).
  const [invite] = await pendingInviteRows(accountId, userId);
  if (invite) {
    if (changes.get('active') === false) {
      // The person may ALSO be a live member under a different id — SSO JIT
      // creates the membership without accepting the invite, and the IdP
      // keeps deprovisioning against the invite id it cached. Revoking only
      // the invite would leave the member with full access and live tokens:
      // the offboarding hole. Resolve the email and deprovision both.
      const shadow = await shadowMemberForInvite(accountId, invite.email);
      if (shadow) {
        if (await isLastOwner(accountId, shadow)) {
          return scimError(c, 409, 'Cannot deactivate the last owner of this account');
        }
        const revocationError = await deprovisionMember(accountId, shadow.userId);
        await scimAudit(c, {
          accountId,
          action: 'scim.user.deactivate',
          resourceType: 'account_member',
          resourceId: shadow.userId,
          before: { user_id: shadow.userId, account_role: shadow.accountRole },
          metadata: {
            via_invite_id: invite.inviteId,
            ...(revocationError
              ? { token_revocation_failed: true, token_revocation_error: revocationError }
              : {}),
          },
        });
      }
      await db.delete(accountInvitations).where(eq(accountInvitations.inviteId, invite.inviteId));
      await scimAudit(c, {
        accountId,
        action: 'scim.user.invite_revoke',
        resourceType: 'account_invitation',
        resourceId: invite.inviteId,
        before: { email: invite.email },
      });
      return c.json(buildInviteUser(accountId, invite, false));
    }
    // No-op profile update on a pending invite — echo it back (200) so the IdP
    // doesn't treat the update as a failure.
    return c.json(buildInviteUser(accountId, invite));
  }

  // Neither a member nor a pending invite: a deactivate of an already-absent
  // user is idempotent (204); anything else targets a missing resource (404).
  if (changes.get('active') === false) return c.body(null, 204);
  return scimError(c, 404, 'User not found in this account');
}

// PUT — Okta's "Push Profile Updates" replaces the whole resource via PUT
// (Kortix previously implemented only PATCH, so these calls 404'd). Treat the
// full body as the change set and run the shared write path.
scimRouter.openapi(
  createRoute({
    method: 'put',
    path: '/accounts/{accountId}/Users/{userId}',
    tags: ['scim'],
    summary: 'Replace a SCIM User (IdP profile push)',
    request: {
      params: z.object({ accountId: z.string(), userId: z.string() }),
      body: { content: { 'application/json': { schema: ScimResource } } },
    },
    responses: {
      200: json(ScimResource, 'SCIM User'),
      ...errors(400, 401, 403, 404, 409),
    },
  }),
  async (c: any) => {
    const accountId = c.req.param('accountId');
    const userId = c.req.param('userId');
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return scimError(c, 400, 'Body must be JSON');
    }
    const changes = new Map<string, unknown>(Object.entries(body));
    return applyUserWrite(c, accountId, userId, changes);
  },
);

scimRouter.openapi(
  createRoute({
    method: 'delete',
    path: '/accounts/{accountId}/Users/{userId}',
    tags: ['scim'],
    summary: 'Delete / deprovision a SCIM User',
    request: { params: z.object({ accountId: z.string(), userId: z.string() }) },
    responses: {
      204: { description: 'No content (deleted / idempotent)' },
      ...errors(401, 403, 409),
    },
  }),
  async (c: any) => {
    const accountId = c.req.param('accountId');
    const userId = c.req.param('userId');

    const member = await getMember(accountId, userId);
    if (!member) {
      // Not a live member — if the id is a pending invitation, revoke it. The
      // person may ALSO be a live member under a different id (SSO JIT never
      // accepts the invite), so resolve the email and deprovision them too —
      // otherwise the IdP's delete silently leaves live access + tokens.
      // Either way DELETE is idempotent → 204.
      const [invite] = await pendingInviteRows(accountId, userId);
      if (invite) {
        const shadow = await shadowMemberForInvite(accountId, invite.email);
        if (shadow) {
          if (await isLastOwner(accountId, shadow)) {
            return scimError(c, 409, 'Cannot delete the last owner of this account');
          }
          const revocationError = await deprovisionMember(accountId, shadow.userId);
          await scimAudit(c, {
            accountId,
            action: 'scim.user.delete',
            resourceType: 'account_member',
            resourceId: shadow.userId,
            before: { user_id: shadow.userId, account_role: shadow.accountRole },
            metadata: {
              via_invite_id: invite.inviteId,
              ...(revocationError
                ? { token_revocation_failed: true, token_revocation_error: revocationError }
                : {}),
            },
          });
        }
        await db
          .delete(accountInvitations)
          .where(eq(accountInvitations.inviteId, invite.inviteId));
        await scimAudit(c, {
          accountId,
          action: 'scim.user.invite_revoke',
          resourceType: 'account_invitation',
          resourceId: invite.inviteId,
          before: { email: invite.email },
        });
      }
      return c.body(null, 204);
    }

    // Same last-owner guard as PATCH active=false.
    if (await isLastOwner(accountId, member)) {
      return scimError(c, 409, 'Cannot delete the last owner of this account');
    }

    // Remove the membership and revoke PATs + live sandbox session tokens so
    // the deprovision is immediate. A revocation failure must not be swallowed
    // — a "deleted" member with live tokens is a silent offboarding hole — so
    // it's logged loudly and recorded on the audit event.
    const revocationError = await deprovisionMember(accountId, userId);
    await scimAudit(c, {
      accountId,
      action: 'scim.user.delete',
      resourceType: 'account_member',
      resourceId: userId,
      before: { user_id: userId, account_role: member.accountRole },
      ...(revocationError
        ? { metadata: { token_revocation_failed: true, token_revocation_error: revocationError } }
        : {}),
    });
    return c.body(null, 204);
  },
);
