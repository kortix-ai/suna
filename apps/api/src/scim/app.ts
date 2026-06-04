// SCIM 2.0 protocol surface for Okta / Azure AD / JumpCloud / etc.
//
// Shared foundation for the SCIM router: the OpenAPIHono instance, the
// permissive resource schema, and the helpers (filter parsing, resource
// serializers, audit) used by the Users / Groups / discovery route modules.
//
// The `scimAuth` middleware and the route registrations live in `./index`
// (the orchestrator) so the original ordering is preserved.

import { Context } from 'hono';
import { z } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { accountGroupMembers } from '@kortix/db';
import { db } from '../shared/db';
import { getSupabase } from '../shared/supabase';
import { recordAuditEvent } from '../shared/audit';
import { scimAuth } from '../middleware/scim-auth';
import { makeOpenApiApp } from '../openapi';

// SCIM payloads are large/dynamic — model permissively.
export const ScimResource = z.record(z.string(), z.any());

export const scimRouter = makeOpenApiApp<any>();

// Auth middleware in its original position: registered before any routes.
// app.ts is imported first by every route module, so this `.use(...)` runs
// before the route-module side-effect registrations regardless of ES module
// import hoisting in the orchestrator.
scimRouter.use('/accounts/:accountId/*', scimAuth);

// ─── Helpers ──────────────────────────────────────────────────────────────

type ParsedFilter = { attr: string; value: string } | null;

/** Parse the tiny subset of SCIM filters we support:
 *  `attr eq "value"` with optional whitespace. Returns null if unsupported. */
export function parseFilter(raw: string | undefined): ParsedFilter {
  if (!raw) return null;
  const m = raw.match(/^\s*(\w+)\s+eq\s+"([^"]*)"\s*$/);
  return m ? { attr: m[1]!, value: m[2]! } : null;
}

export function listResponse<T>(resources: T[]) {
  return {
    schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
    totalResults: resources.length,
    startIndex: 1,
    itemsPerPage: resources.length,
    Resources: resources,
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

export async function userIdByEmail(email: string): Promise<string | null> {
  const supabase = getSupabase();
  try {
    // Supabase admin doesn't expose a direct email-lookup; use the paginated
    // list with a small page and filter client-side. For directories this
    // small it's acceptable; a real production deployment should add a
    // local email→user_id table.
    const normalized = email.trim().toLowerCase();
    const { data } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const found = data?.users?.find(
      (u) => (u.email ?? '').trim().toLowerCase() === normalized,
    );
    return found?.id ?? null;
  } catch {
    return null;
  }
}

export function buildUser(
  accountId: string,
  member: { userId: string; scimExternalId: string | null; joinedAt: Date },
  email: string,
): UserShape {
  const iso = member.joinedAt.toISOString();
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    id: member.userId,
    userName: email,
    active: true,
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

export async function scimAudit(
  c: Context,
  args: {
    accountId: string;
    action: string;
    resourceType: string;
    resourceId?: string | null;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
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
        c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
        c.req.header('x-real-ip') ||
        null,
      userAgent: c.req.header('user-agent') || null,
      metadata: { scim_token_id: c.get('scimTokenId') as string | undefined },
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
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
    id: group.groupId,
    displayName: group.name,
    externalId: group.externalId,
    members: memberRows.map((m) => ({ value: m.userId })),
    meta: {
      resourceType: 'Group',
      created: group.createdAt.toISOString(),
      lastModified: group.updatedAt.toISOString(),
      location: locationFor(accountId, 'Groups', group.groupId),
    },
  };
}
