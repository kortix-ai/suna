// SCIM 2.0 protocol surface for Okta / Azure AD / JumpCloud / etc.
//
// Shared foundation for the SCIM router: the OpenAPIHono instance, the
// permissive resource schema, and the helpers (filter parsing, resource
// serializers, audit) used by the Users / Groups / discovery route modules.
//
// The `scimAuth` middleware and the route registrations live in `./index`
// (the orchestrator) so the original ordering is preserved.

import { z } from '@hono/zod-openapi';
import { accountGroupMembers, accountInvitations, accountScimUsers } from '@kortix/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { scimAuth } from '../middleware/scim-auth';
import { makeOpenApiApp } from '../openapi';
import { recordAuditEvent } from '../shared/audit';
import { db } from '../shared/db';
import { withDirectoryTransaction } from '../iam/directory-transaction';
import { emailTrustedSql } from '../iam/email-trust';
import { getSupabase } from '../shared/supabase';

// SCIM payloads are large/dynamic — model permissively.
export const ScimResource = z.record(z.string(), z.any());

export const scimRouter = makeOpenApiApp<any>();

// Auth middleware in its original position: registered before any routes.
// app.ts is imported first by every route module, so this `.use(...)` runs
// before the route-module side-effect registrations regardless of ES module
// import hoisting in the orchestrator.
scimRouter.use('/accounts/:accountId/*', scimAuth);

class ScimRollback extends Error {}

scimRouter.use('/accounts/:accountId/*', async (c, next) => {
  if (c.req.method === 'GET') return next();
  try {
    await withDirectoryTransaction(c.req.param('accountId')!, async () => {
      await next();
      if (c.res.status >= 400) throw new ScimRollback();
    });
  } catch (error) {
    if (!(error instanceof ScimRollback)) throw error;
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────

type ParsedFilter = { attr: string; value: string } | null;

/** Parse the tiny subset of SCIM filters we support:
 *  `attr eq "value"` with optional whitespace. Returns null if unsupported. */
export function parseFilter(raw: string | undefined): ParsedFilter {
  if (!raw) return null;
  const m = raw.match(/^\s*(\w+)\s+eq\s+("(?:[^"\\]|\\.)*")\s*$/i);
  if (!m) return null;
  try { return { attr: m[1]!, value: JSON.parse(m[2]!) as string }; }
  catch { return null; }
}

/**
 * True when a `filter` param was supplied but isn't the `attr eq "value"` form
 * we support. List handlers must 400 on this (RFC 7644 §3.4.2.2) instead of
 * silently returning the FULL directory — a silent full-list both violates the
 * IdP's intent (it thinks it got a filtered subset) and, on a large directory,
 * is expensive and can over-expose users in paginated pages. A missing/empty
 * filter is NOT unsupported — that's a legitimate list-all.
 */
export function isUnsupportedFilter(raw: string | undefined): boolean {
  return typeof raw === 'string' && raw.trim().length > 0 && parseFilter(raw) === null;
}

export const ScimListQuery = z.object({
  filter: z.string().optional(),
  startIndex: z.coerce.number().int().min(0).optional(),
  count: z.coerce.number().int().min(0).optional(),
});

export function listResponse<T>(resources: T[], query: { startIndex?: number; count?: number } = {}) {
  const startIndex = Math.max(1, query.startIndex ?? 1);
  const count = Math.min(200, query.count ?? 200);
  const page = resources.slice(startIndex - 1, startIndex - 1 + count);
  return {
    schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
    totalResults: resources.length,
    startIndex,
    itemsPerPage: page.length,
    Resources: page,
  };
}

export interface UserShape {
  schemas: string[];
  id: string;
  userName: string;
  active: boolean;
  emails: Array<{ value: string; primary: boolean }>;
  externalId?: string | null;
  meta: { resourceType: 'User'; created: string; lastModified: string; location: string };
}

export function locationFor(accountId: string, kind: 'Users' | 'Groups', id: string): string {
  return `/scim/v2/accounts/${accountId}/${kind}/${id}`;
}

/**
 * Bulk Supabase-email lookup for the user IDs we have. Used to render
 * `userName` / `emails` on SCIM User resources. Returns a map so the
 * caller can build resources in O(n).
 */
export async function emailsByUserId(userIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (userIds.length === 0) return map;
  const supabase = getSupabase();
  await Promise.all(
    userIds.map(async (uid) => {
      try {
        const { data } = await supabase.auth.admin.getUserById(uid);
        if (data?.user?.email) map.set(uid, data.user.email);
      } catch {
        /* ignore — surface as missing email */
      }
    }),
  );
  return map;
}

/**
 * The Auth user a directory email names. Only an identity whose email is
 * trusted (iam/email-trust.ts) qualifies: an SSO identity from another
 * account's IdP that did not verify the email's domain is never linked.
 */
export async function userIdByEmail(email: string, accountId?: string): Promise<string | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  const rows = await db.execute(sql`
    SELECT u.id::text AS id
    FROM auth.users u
    LEFT JOIN kortix.account_memberships m
      ON m.user_id = u.id AND m.account_id = ${accountId ?? null}::uuid
    WHERE u.email = ${normalized}
      AND ${emailTrustedSql(sql`u`, accountId)}
    ORDER BY (m.user_id IS NOT NULL) DESC, u.created_at, u.id
    LIMIT 1
  `);
  return (rows[0] as { id: string } | undefined)?.id ?? null;
}

export function buildUser(
  accountId: string,
  member: { userId: string; scimExternalId: string | null; joinedAt: Date },
  email: string,
  // Deactivation removes the member row, so a deactivate response must be able
  // to report active:false for the IdP to confirm the change (Azure/Okta expect
  // the patched resource back, not a bare 204). Defaults true for the live-member
  // read/list/create paths.
  active = true,
): UserShape {
  const iso = member.joinedAt.toISOString();
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    id: member.userId,
    userName: email,
    active,
    emails: [{ value: email, primary: true }],
    externalId: member.scimExternalId,
    meta: {
      resourceType: 'User',
      created: iso,
      lastModified: iso,
      location: locationFor(accountId, 'Users', member.userId),
    },
  };
}

/**
 * Serialize a PENDING INVITATION as a SCIM User. An invited-but-not-yet-joined
 * person is a valid, ENABLED account from the IdP's point of view — so we return
 * `active: true` (NOT false). Returning false made Okta treat the just-pushed
 * user as deactivated and loop forever "reactivating" it. The SCIM id is the
 * invitation id; once the person signs in via SSO they become a real member and
 * are served by `buildUser` instead (the IdP re-correlates by userName/email).
 */
export function buildInviteUser(
  accountId: string,
  invite: { inviteId: string; email: string; createdAt: Date; externalId?: string | null },
  active = true,
): UserShape {
  const iso = invite.createdAt.toISOString();
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    id: invite.inviteId,
    userName: invite.email,
    active,
    emails: [{ value: invite.email, primary: true }],
    externalId: invite.externalId ?? null,
    meta: {
      resourceType: 'User',
      created: iso,
      lastModified: iso,
      location: locationFor(accountId, 'Users', invite.inviteId),
    },
  };
}

export async function scimAudit(
  c: Context,
  args: {
    accountId: string;
    action: string;
    resourceType: string;
    resourceId?: string | null;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    /** Merged into the event metadata alongside the SCIM token id — used to
     *  flag partial failures (e.g. token revocation that didn't land). */
    metadata?: Record<string, unknown>;
  },
) {
  try {
    await recordAuditEvent({
      accountId: args.accountId,
      actorUserId: null, // SCIM has no human actor; the token IS the actor
      action: args.action,
      resourceType: args.resourceType,
      resourceId: args.resourceId ?? null,
      before: args.before ?? null,
      after: args.after ?? null,
      ip:
        c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || null,
      userAgent: c.req.header('user-agent') || null,
      metadata: { scim_token_id: c.get('scimTokenId') as string | undefined, ...args.metadata },
    });
  } catch (err) {
    console.warn('[scim audit] failed to record', args.action, err);
  }
}

export interface GroupShape {
  schemas: string[];
  id: string;
  displayName: string;
  externalId?: string | null;
  members: Array<{ value: string; display?: string }>;
  meta: { resourceType: 'Group'; created: string; lastModified: string; location: string };
}

export async function buildGroup(
  accountId: string,
  group: {
    groupId: string;
    name: string;
    externalId: string | null;
    createdAt: Date;
    updatedAt: Date;
  },
): Promise<GroupShape> {
  const memberRows = await db
    .select({ userId: accountGroupMembers.userId })
    .from(accountGroupMembers)
    .where(eq(accountGroupMembers.groupId, group.groupId));
  const directoryUsers = await db.select().from(accountScimUsers)
    .where(eq(accountScimUsers.accountId, accountId));
  const byUserId = new Map(directoryUsers.filter(u => u.userId).map(u => [u.userId, u]));
  const byInviteId = new Map(directoryUsers.filter(u => u.invitationId).map(u => [u.invitationId, u]));
  const invites = await db.select().from(accountInvitations).where(and(
    eq(accountInvitations.accountId, accountId), isNull(accountInvitations.acceptedAt),
    sql`${accountInvitations.bootstrapGrants} @> ${JSON.stringify([{ group_id: group.groupId }])}::jsonb`,
  ));
  const memberIds = new Set<string>();
  for (const user of directoryUsers) {
    if (!user.deletedAt && Array.isArray(user.profile.groups) && user.profile.groups.some(g => g?.value === group.groupId)) {
      memberIds.add(user.scimId);
    }
  }
  for (const member of memberRows) {
    const user = byUserId.get(member.userId);
    if (!user || (user.active && !user.deletedAt)) memberIds.add(user?.scimId ?? member.userId);
  }
  for (const invite of invites) {
    const user = byInviteId.get(invite.inviteId);
    if (!user || (user.active && !user.deletedAt)) memberIds.add(user?.scimId ?? invite.inviteId);
  }
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
    id: group.groupId,
    displayName: group.name,
    externalId: group.externalId,
    members: [...memberIds].sort().map(value => ({ value })),
    meta: {
      resourceType: 'Group',
      created: group.createdAt.toISOString(),
      lastModified: group.updatedAt.toISOString(),
      location: locationFor(accountId, 'Groups', group.groupId),
    },
  };
}
