import {
  buildInviteUrl,
  isInviteEmailConfigured,
  sendAccountInviteEmail,
} from "../../accounts/email";
import { PROJECT_ACTIONS, authorize } from "../../iam";
import { assertAgentScope } from "../../iam/agent-scope";
import { invalidateIamCacheForUser } from "../../iam/cache-invalidation";
import { deriveRequestContext } from "../../iam/cache";
import { auth, errors, json } from "../../openapi";
import { sharedDb as db } from "../../shared/effect";
import { lookupUserIdByEmail } from "../../shared/users";
import {
  foldEffectiveProjectAccess,
  isAccountManager,
  parseProjectRole,
  roleAllows,
  type AccountRole,
  type ProjectRole,
} from "../access";
import { createRoute, z } from "@hono/zod-openapi";
import {
  accountGroupMembers,
  accountGroups,
  accountInvitations,
  accountMembers,
  accounts,
  projectAccessRequests,
  projectGroupGrants,
  projectMembers,
  projects,
} from "@kortix/db";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { Effect } from "effect";
import {
  ensureOrgMembership,
  grantProjectRole,
  loadProjectForUser,
  lookupEmailsByUserIds,
  resolveUserIdentities,
  parseExpiresAtBody,
  assertProjectCapability,
} from "../lib/access";
import { notifyProjectAccessRequestManagers } from "../lib/access-requests";
import { AccessMemberSchema, AnyObject, projectsApp } from "../lib/app";
import { getAccountMembership } from "../lib/git";
import { readBody, serializeProject } from "../lib/serializers";
import {
  applyExperimentalOverride,
  isExperimentalFeatureKey,
} from "../../experimental/features";
import {
  reconcileChannelConnectors,
  reconcileComputerConnectors,
} from "../../executor/sync";
import { propagateLlmGatewayModeToActiveSandboxes } from "../lib/sandbox-env-sync";
import { projectLlmGatewayEnabled } from "../../llm-gateway/enablement";
import { sharedConfig as config, type SandboxProviderName } from "../../shared/effect";
import {
  attemptRoute,
  attemptRouteSync,
  failJson,
  failNotFound,
  routeJson,
  runProjectRouteEffect,
} from "./effect-workflows";
import { effectHandler } from "../../effect/hono";

function serializeProjectAccessRequest(
  row: typeof projectAccessRequests.$inferSelect,
) {
  return {
    request_id: row.requestId,
    account_id: row.accountId,
    project_id: row.projectId,
    requester_user_id: row.requesterUserId,
    requester_email: row.requesterEmail,
    message: row.message ?? null,
    status: row.status,
    reviewed_by: row.reviewedBy ?? null,
    reviewed_at: row.reviewedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

projectsApp.openapi(
  createRoute({
    method: "patch",
    path: "/{projectId}/onboarding",
    tags: ["projects"],
    summary: "PATCH /:projectId/onboarding",
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { "application/json": { schema: AnyObject } } },
    },
    responses: {
      200: json(z.any(), "OK"),
      ...errors(404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param("projectId");
    return runProjectRouteEffect(
      c,
      Effect.gen(function* () {
        const body = yield* attemptRoute(() => readBody(c));
        const loaded = yield* attemptRoute(() =>
          loadProjectForUser(c, projectId, "write"),
        );
        if (!loaded) return yield* failNotFound();

        const completed = body.completed === true;
        const previousMetadata = (loaded.row.metadata ?? {}) as Record<
          string,
          unknown
        >;
        const nextMetadata: Record<string, unknown> = { ...previousMetadata };
        if (completed) {
          nextMetadata.onboarding_completed_at = new Date().toISOString();
        } else {
          delete nextMetadata.onboarding_completed_at;
        }

        const [row] = yield* attemptRoute(() =>
          db
            .update(projects)
            .set({ metadata: nextMetadata, updatedAt: new Date() })
            .where(eq(projects.projectId, projectId))
            .returning(),
        );

        if (!row || row.status === "archived") return yield* failNotFound();
        return routeJson(
          serializeProject(row, {
            projectRole: loaded.projectRole,
            effectiveRole: loaded.effectiveRole,
          }),
        );
      }),
    );
  },
);

// DELETE /v1/projects/:projectId

projectsApp.openapi(
  createRoute({
    method: "delete",
    path: "/{projectId}",
    tags: ["projects"],
    summary: "DELETE /:projectId",
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
    },
    responses: {
      200: json(z.any(), "OK"),
      ...errors(404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param("projectId");
    return runProjectRouteEffect(
      c,
      Effect.gen(function* () {
        const loaded = yield* attemptRoute(() =>
          loadProjectForUser(c, projectId, "manage"),
        );
        if (!loaded) return yield* failNotFound();
        // Deletion is admin-only. Project Editor explicitly excludes
        // project.delete; loadProjectForUser('manage') would otherwise let
        // editors through via project.write.
        yield* attemptRoute(() =>
          assertProjectCapability(
            c,
            loaded.userId,
            loaded.row.accountId,
            projectId,
            PROJECT_ACTIONS.PROJECT_DELETE,
          ),
        );

        const [row] = yield* attemptRoute(() =>
          db
            .update(projects)
            .set({ status: "archived", updatedAt: new Date() })
            .where(eq(projects.projectId, projectId))
            .returning(),
        );

        if (!row) return yield* failNotFound();
        return routeJson({ ok: true });
      }),
    );
  },
);

// GET /v1/projects/:projectId/access
// Lists every account member and their explicit/effective project access.

projectsApp.openapi(
  createRoute({
    method: "get",
    path: "/{projectId}/access",
    tags: ["access"],
    summary: "GET /:projectId/access",
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
    },
    responses: {
      200: json(z.array(AccessMemberSchema), "Access members"),
      ...errors(404),
    },
  }),
  effectHandler(async (c: any) => {
    const projectId = c.req.param("projectId");
    const loaded = await loadProjectForUser(c, projectId, "read");
    if (!loaded) return c.json({ error: "Not found" }, 404);

    const [accountRows, grantRows, projectGroupRows] = await Promise.all([
      db
        .select({
          userId: accountMembers.userId,
          accountRole: accountMembers.accountRole,
          joinedAt: accountMembers.joinedAt,
        })
        .from(accountMembers)
        .where(eq(accountMembers.accountId, loaded.row.accountId)),
      db
        .select({
          userId: projectMembers.userId,
          projectRole: projectMembers.projectRole,
          grantedBy: projectMembers.grantedBy,
          createdAt: projectMembers.createdAt,
          updatedAt: projectMembers.updatedAt,
          expiresAt: projectMembers.expiresAt,
        })
        .from(projectMembers)
        .where(eq(projectMembers.projectId, loaded.row.projectId)),
      // V2 group grants attached to this project. Each row lifts everyone in
      // the group to at least the grant's role on this project. Per-user
      // membership lookup happens below; we fetch group → role mapping +
      // name in one shot here so we can label sources on the response.
      db
        .select({
          groupId: projectGroupGrants.groupId,
          groupName: accountGroups.name,
          role: projectGroupGrants.role,
        })
        .from(projectGroupGrants)
        .innerJoin(
          accountGroups,
          eq(accountGroups.groupId, projectGroupGrants.groupId),
        )
        .where(eq(projectGroupGrants.projectId, loaded.row.projectId)),
    ]);

    // For every grant-bearing group, fetch its members so we can fold their
    // inherited role into each user's effective access. One round-trip
    // covering all groups at once.
    const grantGroupIds = projectGroupRows.map((g) => g.groupId);
    const groupMemberRows = grantGroupIds.length
      ? await db
          .select({
            groupId: accountGroupMembers.groupId,
            userId: accountGroupMembers.userId,
          })
          .from(accountGroupMembers)
          .where(inArray(accountGroupMembers.groupId, grantGroupIds))
      : [];

    // Index: userId → list of { group_id, group_name, role } that contribute.
    type GroupSource = {
      group_id: string;
      group_name: string;
      role: ProjectRole;
    };
    const groupSourcesByUser = new Map<string, GroupSource[]>();
    const grantByGroup = new Map(
      projectGroupRows.map((g) => [g.groupId, g] as const),
    );
    for (const m of groupMemberRows) {
      const grant = grantByGroup.get(m.groupId);
      if (!grant) continue;
      const arr = groupSourcesByUser.get(m.userId) ?? [];
      arr.push({
        group_id: grant.groupId,
        group_name: grant.groupName,
        role: grant.role as ProjectRole,
      });
      groupSourcesByUser.set(m.userId, arr);
    }

    const identities = await resolveUserIdentities(
      accountRows.map((r) => r.userId),
    );
    // Drop shadow members: an account_members row pointing at a user_id that is
    // not a real auth user (e.g. a self-referential row where user_id == the
    // account_id). These have no resolvable email and otherwise render as a bare
    // UUID in the access list.
    const realAccountRows = accountRows.filter(
      (r) => identities.get(r.userId)?.exists !== false,
    );
    const grantsByUser = new Map(grantRows.map((r) => [r.userId, r]));
    const rank: Record<AccountRole, number> = { owner: 0, admin: 1, member: 2 };

    const members = realAccountRows
      .map((member) => {
        const accountRole = member.accountRole as AccountRole;
        const grant = grantsByUser.get(member.userId);
        const projectRole =
          (grant?.projectRole as ProjectRole | undefined) ?? null;
        const groupSources = groupSourcesByUser.get(member.userId) ?? [];

        // Pure fold — see projects/access.ts for the precedence rules.
        const fold = foldEffectiveProjectAccess({
          accountRole,
          directRole: projectRole,
          groupSources,
        });

        return {
          user_id: member.userId,
          email: identities.get(member.userId)?.email ?? null,
          account_role: accountRole,
          project_role: projectRole,
          effective_project_role: fold.effective_project_role,
          has_implicit_access: isAccountManager(accountRole),
          /** What ultimately decided the effective role. UI labels with
           *  it: "Manager (account admin)" vs "Editor (via Engineering)". */
          effective_source: fold.effective_source,
          /** Every group attachment that includes this user. Lets the UI
           *  list multi-source access ("Editor via Engineering + Viewer
           *  via Viewers") without further API calls. */
          group_sources: fold.group_sources,
          joined_at: member.joinedAt.toISOString(),
          granted_by: grant?.grantedBy ?? null,
          granted_at: grant?.createdAt?.toISOString() ?? null,
          updated_at: grant?.updatedAt?.toISOString() ?? null,
          /** Auto-revoke timestamp for the DIRECT grant. NULL = permanent.
           *  Group-derived expiries are surfaced per-source separately
           *  (not yet wired into group_sources — follow-up). */
          expires_at: grant?.expiresAt?.toISOString() ?? null,
        };
      })
      .sort((a, b) => {
        const roleDelta = rank[a.account_role] - rank[b.account_role];
        if (roleDelta !== 0) return roleDelta;
        return (a.email ?? a.user_id).localeCompare(b.email ?? b.user_id);
      });

    return c.json({
      project_id: loaded.row.projectId,
      account_id: loaded.row.accountId,
      can_manage: roleAllows(loaded.effectiveRole, "manage"),
      viewer_user_id: loaded.userId,
      members,
    });
  }),
);

// POST /v1/projects/:projectId/access-requests
// Lets a signed-in user with a project link ask the project's managers for
// access without mounting the normal project shell (which would otherwise fan
// out into many 403s). Mirrors the Figma-style "Request access" affordance.

projectsApp.openapi(
  createRoute({
    method: "post",
    path: "/{projectId}/access-requests",
    tags: ["access"],
    summary: "POST /:projectId/access-requests",
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { "application/json": { schema: AnyObject } } },
    },
    responses: {
      200: json(z.any(), "Existing access request or access state"),
      201: json(z.any(), "Access request created"),
      ...errors(404),
    },
  }),
  effectHandler(async (c: any) => {
    const projectId = c.req.param("projectId");
    const userId = c.get("userId") as string;
    const requesterEmail = ((c.get("userEmail") as string | undefined) ?? "")
      .trim()
      .toLowerCase();
    const body = await readBody(c);
    const messageRaw =
      typeof body.message === "string" ? body.message.trim() : "";
    const message = messageRaw ? messageRaw.slice(0, 2000) : null;

    const [project] = await db
      .select({
        accountId: projects.accountId,
        projectId: projects.projectId,
        status: projects.status,
      })
      .from(projects)
      .where(eq(projects.projectId, projectId))
      .limit(1);
    if (!project || project.status === "archived")
      return c.json({ error: "Not found" }, 404);

    const membership = await getAccountMembership(userId, project.accountId);
    if (membership) {
      const actingTokenId =
        ((c as unknown as { get(k: string): unknown }).get("iamTokenId") as
          | string
          | undefined) ?? undefined;
      const verdict = await authorize(
        userId,
        project.accountId,
        PROJECT_ACTIONS.PROJECT_READ,
        { type: "project", id: projectId },
        actingTokenId,
        deriveRequestContext(c),
      );
      if (verdict.allowed) {
        return c.json({ status: "already_has_access", project_id: projectId });
      }
    }

    const [existing] = await db
      .select()
      .from(projectAccessRequests)
      .where(
        and(
          eq(projectAccessRequests.projectId, projectId),
          eq(projectAccessRequests.requesterUserId, userId),
          eq(projectAccessRequests.status, "pending"),
        ),
      )
      .limit(1);

    if (existing) {
      return c.json({
        status: "pending",
        request: serializeProjectAccessRequest(existing),
      });
    }

    const [created] = await db
      .insert(projectAccessRequests)
      .values({
        accountId: project.accountId,
        projectId,
        requesterUserId: userId,
        requesterEmail: requesterEmail || userId,
        message,
      })
      .returning();

    await notifyProjectAccessRequestManagers({
      accountId: project.accountId,
      projectId,
      requesterUserId: userId,
      requesterEmail: created.requesterEmail,
      message,
    });

    return c.json(
      { status: "created", request: serializeProjectAccessRequest(created) },
      201,
    );
  }),
);

// GET /v1/projects/:projectId/access-requests
// Managers review pending "request access" asks from the Members screen.

projectsApp.openapi(
  createRoute({
    method: "get",
    path: "/{projectId}/access-requests",
    tags: ["access"],
    summary: "GET /:projectId/access-requests",
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
    },
    responses: {
      200: json(z.any(), "Pending access requests"),
      ...errors(404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param("projectId");
    return runProjectRouteEffect(
      c,
      Effect.gen(function* () {
        const loaded = yield* attemptRoute(() =>
          loadProjectForUser(c, projectId, "manage"),
        );
        if (!loaded) return yield* failNotFound();

        const rows = yield* attemptRoute(() =>
          db
            .select()
            .from(projectAccessRequests)
            .where(
              and(
                eq(projectAccessRequests.projectId, projectId),
                eq(projectAccessRequests.status, "pending"),
              ),
            )
            .orderBy(desc(projectAccessRequests.createdAt)),
        );

        return routeJson({ requests: rows.map(serializeProjectAccessRequest) });
      }),
    );
  },
);

// POST /v1/projects/:projectId/access-requests/:requestId/approve

projectsApp.openapi(
  createRoute({
    method: "post",
    path: "/{projectId}/access-requests/{requestId}/approve",
    tags: ["access"],
    summary: "POST /:projectId/access-requests/:requestId/approve",
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), requestId: z.string() }),
      body: { content: { "application/json": { schema: AnyObject } } },
    },
    responses: {
      200: json(z.any(), "Access request approved"),
      ...errors(400, 404, 409),
    },
  }),
  effectHandler(async (c: any) => {
    const projectId = c.req.param("projectId");
    const requestId = c.req.param("requestId");
    const loaded = await loadProjectForUser(c, projectId, "manage");
    if (!loaded) return c.json({ error: "Not found" }, 404);
    // Approving an access request grants a project role to the requester —
    // membership management, NOT plain write. loadProjectForUser('manage') only
    // maps to project.write (editor), so without this an editor could approve
    // requests and even hand out the 'manager' role. Gate on members.manage.
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE,
    );

    const body = await readBody(c);
    const role = body.role === undefined ? "user" : parseProjectRole(body.role);
    if (!role)
      return c.json({ error: "role must be one of manager|editor|user" }, 400);

    const [request] = await db
      .select()
      .from(projectAccessRequests)
      .where(
        and(
          eq(projectAccessRequests.requestId, requestId),
          eq(projectAccessRequests.projectId, projectId),
        ),
      )
      .limit(1);
    if (!request) return c.json({ error: "Not found" }, 404);
    if (request.status !== "pending") {
      return c.json({ error: "Access request has already been reviewed" }, 409);
    }

    const targetAccountRole = await ensureOrgMembership(
      loaded.row.accountId,
      request.requesterUserId,
    );

    if (!isAccountManager(targetAccountRole)) {
      await grantProjectRole({
        accountId: loaded.row.accountId,
        projectId,
        userId: request.requesterUserId,
        role,
        grantedBy: loaded.userId,
      });
    }

    const [updated] = await db
      .update(projectAccessRequests)
      .set({
        status: "approved",
        reviewedBy: loaded.userId,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(projectAccessRequests.requestId, requestId))
      .returning();

    return c.json({
      request: serializeProjectAccessRequest(updated),
      member: {
        user_id: request.requesterUserId,
        email: request.requesterEmail,
        account_role: targetAccountRole,
        project_role: isAccountManager(targetAccountRole) ? null : role,
        effective_project_role: isAccountManager(targetAccountRole)
          ? "manager"
          : role,
        has_implicit_access: isAccountManager(targetAccountRole),
      },
    });
  }),
);

// POST /v1/projects/:projectId/access-requests/:requestId/reject

projectsApp.openapi(
  createRoute({
    method: "post",
    path: "/{projectId}/access-requests/{requestId}/reject",
    tags: ["access"],
    summary: "POST /:projectId/access-requests/:requestId/reject",
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), requestId: z.string() }),
    },
    responses: {
      200: json(z.any(), "Access request rejected"),
      ...errors(404, 409),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param("projectId");
    const requestId = c.req.param("requestId");
    return runProjectRouteEffect(
      c,
      Effect.gen(function* () {
        const loaded = yield* attemptRoute(() =>
          loadProjectForUser(c, projectId, "manage"),
        );
        if (!loaded) return yield* failNotFound();
        // Reviewing an access request is membership management — gate on
        // members.manage (loadProjectForUser('manage') only enforces project.write).
        yield* attemptRoute(() =>
          assertProjectCapability(
            c,
            loaded.userId,
            loaded.row.accountId,
            projectId,
            PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE,
          ),
        );

        const [request] = yield* attemptRoute(() =>
          db
            .select()
            .from(projectAccessRequests)
            .where(
              and(
                eq(projectAccessRequests.requestId, requestId),
                eq(projectAccessRequests.projectId, projectId),
              ),
            )
            .limit(1),
        );
        if (!request) return yield* failNotFound();
        if (request.status !== "pending") {
          return yield* failJson(
            { error: "Access request has already been reviewed" },
            409,
          );
        }

        const [updated] = yield* attemptRoute(() =>
          db
            .update(projectAccessRequests)
            .set({
              status: "rejected",
              reviewedBy: loaded.userId,
              reviewedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(projectAccessRequests.requestId, requestId))
            .returning(),
        );

        return routeJson({ request: serializeProjectAccessRequest(updated) });
      }),
    );
  },
);

// PUT /v1/projects/:projectId/access/:userId
// POST /v1/projects/:projectId/access/invite
// Invite a person to a project by email: looks up their Kortix account, ensures
// they're an org member (creating a 'member' org row if needed), then grants the
// project role. Account managers get implicit project access (no explicit grant).

projectsApp.openapi(
  createRoute({
    method: "post",
    path: "/{projectId}/access/invite",
    tags: ["access"],
    summary: "POST /:projectId/access/invite",
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { "application/json": { schema: AnyObject } } },
    },
    responses: {
      200: json(z.any(), "OK"),
      ...errors(400, 404),
    },
  }),
  effectHandler(async (c: any) => {
    const projectId = c.req.param("projectId");
    const loaded = await loadProjectForUser(c, projectId, "manage");
    if (!loaded) return c.json({ error: "Not found" }, 404);
    // Inviting a member grants project access — members.manage, not plain write.
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE,
    );

    const body = await readBody(c);
    const email = (typeof body.email === "string" ? body.email : "")
      .trim()
      .toLowerCase();
    const role = parseProjectRole(body.role);
    if (!email) return c.json({ error: "email is required" }, 400);
    if (!role)
      return c.json({ error: "role must be one of manager|editor|user" }, 400);
    const expires = parseExpiresAtBody(body.expires_at);
    if (!expires.ok) return c.json({ error: expires.error }, 400);

    const targetUserId = await lookupUserIdByEmail(email);
    if (!targetUserId) {
      // No Kortix user yet. Upsert an account invitation carrying a
      // bootstrap_grant so when they accept, they're added to the org
      // AND granted the project role in one step — no separate "invite
      // to org, then invite to project" dance. The unique index on
      // (account_id, email) makes this idempotent; re-inviting the
      // same email to a second project merges the grants list.
      const bootstrap = {
        project_id: projectId,
        role,
        ...(expires.value ? { expires_at: expires.value.toISOString() } : {}),
      };
      // Wrap the find-or-create in a transaction with SELECT … FOR UPDATE
      // so two concurrent admins inviting the same email can't both see
      // the same pre-state and produce a last-write-wins merge that
      // drops one of their grants. The lock blocks the second admin's
      // SELECT until the first transaction commits; the second admin
      // then sees the first's grant and merges on top of it.
      const inviteId = await db.transaction(async (tx) => {
        const [existing] = await tx
          .select({
            inviteId: accountInvitations.inviteId,
            bootstrapGrants: accountInvitations.bootstrapGrants,
          })
          .from(accountInvitations)
          .where(
            and(
              eq(accountInvitations.accountId, loaded.row.accountId),
              sql`lower(${accountInvitations.email}) = ${email}`,
              isNull(accountInvitations.acceptedAt),
            ),
          )
          .for("update")
          .limit(1);
        if (existing) {
          // Merge bootstrap grants by project_id (later wins on role).
          const merged = [...(existing.bootstrapGrants ?? [])];
          const idx = merged.findIndex((g) => g.project_id === projectId);
          if (idx >= 0) merged[idx] = bootstrap;
          else merged.push(bootstrap);
          await tx
            .update(accountInvitations)
            .set({ bootstrapGrants: merged })
            .where(eq(accountInvitations.inviteId, existing.inviteId));
          return existing.inviteId;
        }
        const [created] = await tx
          .insert(accountInvitations)
          .values({
            accountId: loaded.row.accountId,
            email,
            invitedBy: loaded.userId,
            initialRole: "member",
            bootstrapGrants: [bootstrap],
          })
          .returning({ inviteId: accountInvitations.inviteId });
        return created.inviteId;
      });

      // Fire the invite email — same transport + template as account-level
      // invites, framed around this project. Fire-and-forget: the invitation row
      // already exists and we return the invite_url regardless, so we don't block
      // the response on Mailtrap (its 10s timeout was stacking onto the request).
      // send() never throws (it returns a result object), but guard the promise
      // anyway so a transport-layer rejection can't surface as unhandled.
      const callerEmail = (c.get("userEmail") as string | undefined) ?? null;
      const [accountRow] = await db
        .select({ name: accounts.name })
        .from(accounts)
        .where(eq(accounts.accountId, loaded.row.accountId))
        .limit(1);
      const emailConfigured = isInviteEmailConfigured();
      if (emailConfigured) {
        void sendAccountInviteEmail({
          email,
          accountName: accountRow?.name ?? "Kortix",
          inviterEmail: callerEmail,
          inviteId,
          role,
          projectName: loaded.row.name,
        }).catch((err) => {
          console.warn(
            "[projects/invite] invite email send failed:",
            (err as Error).message,
          );
        });
      }

      return c.json(
        {
          status: "invited",
          email,
          invite_id: inviteId,
          project_role: role,
          invite_url: buildInviteUrl(inviteId),
          // Optimistic: send is queued, not awaited. When delivery isn't wired up
          // we know synchronously it'll be skipped, so report that honestly.
          email_sent: emailConfigured,
          email_skip_reason: emailConfigured ? null : "missing_mailtrap_token",
          message: emailConfigured
            ? `No Kortix account for that email yet — an invitation email has been sent. They'll land on this project as ${role} when they sign up.`
            : `No Kortix account for that email yet — invitation created. Share the invite link with them; they'll land on this project as ${role} when they sign up.`,
        },
        201,
      );
    }

    const targetAccountRole = await ensureOrgMembership(
      loaded.row.accountId,
      targetUserId,
    );
    if (isAccountManager(targetAccountRole)) {
      return c.json({
        user_id: targetUserId,
        email,
        account_role: targetAccountRole,
        project_role: null,
        effective_project_role: "manager",
        has_implicit_access: true,
      });
    }

    await grantProjectRole({
      accountId: loaded.row.accountId,
      projectId,
      userId: targetUserId,
      role,
      grantedBy: loaded.userId,
      expiresAt: expires.value,
    });

    return c.json({
      user_id: targetUserId,
      email,
      account_role: targetAccountRole,
      project_role: role,
      effective_project_role: role,
      has_implicit_access: false,
    });
  }),
);

// GET /v1/projects/:projectId/access/pending-invites
// Lists pending account_invitations whose bootstrap_grants target this
// project. Surfaces the "I invited someone whose email doesn't have a
// Kortix account yet" intermediate state — without this the UI looks
// the same before and after a successful invite, leaving the inviter
// to wonder if anything happened.
//
// Restricted to project managers — viewers don't need to see who's
// queued up for membership.

projectsApp.openapi(
  createRoute({
    method: "get",
    path: "/{projectId}/access/pending-invites",
    tags: ["access"],
    summary: "GET /:projectId/access/pending-invites",
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
    },
    responses: {
      200: json(z.any(), "OK"),
      ...errors(404),
    },
  }),
  effectHandler(async (c: any) => {
    const projectId = c.req.param("projectId");
    const loaded = await loadProjectForUser(c, projectId, "manage");
    if (!loaded) return c.json({ error: "Not found" }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE,
    );

    // JSONB containment check (`@>`) finds invitations whose grants array
    // contains an entry with this project_id. Includes expired invites in
    // the result with a flag so the UI can show them dimmed + a "Resend"
    // affordance later if we want it (out of scope for now — just hide).
    const rows = await db
      .select({
        inviteId: accountInvitations.inviteId,
        email: accountInvitations.email,
        initialRole: accountInvitations.initialRole,
        invitedBy: accountInvitations.invitedBy,
        createdAt: accountInvitations.createdAt,
        expiresAt: accountInvitations.expiresAt,
        bootstrapGrants: accountInvitations.bootstrapGrants,
      })
      .from(accountInvitations)
      .where(
        and(
          eq(accountInvitations.accountId, loaded.row.accountId),
          isNull(accountInvitations.acceptedAt),
          sql`${accountInvitations.bootstrapGrants} @> ${JSON.stringify([{ project_id: projectId }])}::jsonb`,
        ),
      );

    // Resolve inviter emails in one shot (one auth.admin call per inviter
    // since the Supabase helper has no batch API; the set is tiny in
    // practice — usually 1 or 2 distinct admins).
    const inviterIds = Array.from(
      new Set(rows.map((r) => r.invitedBy).filter((v): v is string => !!v)),
    );
    const inviterEmails = await lookupEmailsByUserIds(inviterIds);

    const now = Date.now();
    const items = rows
      .map((r) => {
        const grant = (r.bootstrapGrants ?? []).find(
          (g) => g.project_id === projectId,
        );
        // Defensive — the WHERE already filtered for project_id, but the
        // type system doesn't know that, and a corrupt row shouldn't 500.
        if (!grant) return null;
        return {
          invite_id: r.inviteId,
          // Normalize a legacy `viewer` grant to `user` so the API never emits
          // the retired role.
          project_role: parseProjectRole(grant.role) ?? "user",
          expires_at: grant.expires_at ?? null,
          invited_by_email: r.invitedBy
            ? (inviterEmails.get(r.invitedBy) ?? null)
            : null,
          created_at: r.createdAt.toISOString(),
          invite_expires_at: r.expiresAt.toISOString(),
          invite_expired: r.expiresAt.getTime() <= now,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    return c.json({ pending: items });
  }),
);

// DELETE /v1/projects/:projectId/access/pending-invites/:inviteId
// Removes this project's bootstrap_grant from a pending invitation. If
// that was the only grant AND the invitation is the auto-created
// "member" variety (always how project /access/invite creates them), the
// whole invitation row goes away — the user simply isn't being invited
// anywhere anymore. If the inviter had set a higher initial_role
// (admin/owner) or other project grants remain, we keep the invitation
// and just strip this project from it.

projectsApp.openapi(
  createRoute({
    method: "delete",
    path: "/{projectId}/access/pending-invites/{inviteId}",
    tags: ["access"],
    summary: "DELETE /:projectId/access/pending-invites/:inviteId",
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), inviteId: z.string() }),
    },
    responses: {
      200: json(z.any(), "OK"),
      ...errors(404, 409),
    },
  }),
  effectHandler(async (c: any) => {
    const projectId = c.req.param("projectId");
    const inviteId = c.req.param("inviteId");
    const loaded = await loadProjectForUser(c, projectId, "manage");
    if (!loaded) return c.json({ error: "Not found" }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE,
    );

    const [invite] = await db
      .select({
        inviteId: accountInvitations.inviteId,
        accountId: accountInvitations.accountId,
        initialRole: accountInvitations.initialRole,
        acceptedAt: accountInvitations.acceptedAt,
        bootstrapGrants: accountInvitations.bootstrapGrants,
      })
      .from(accountInvitations)
      .where(eq(accountInvitations.inviteId, inviteId))
      .limit(1);

    if (!invite || invite.accountId !== loaded.row.accountId) {
      return c.json({ error: "Invitation not found" }, 404);
    }
    if (invite.acceptedAt) {
      return c.json({ error: "Invitation has already been accepted" }, 409);
    }

    const remaining = (invite.bootstrapGrants ?? []).filter(
      (g) => g.project_id !== projectId,
    );

    // Auto-cancel the whole invitation if (a) nothing else is being
    // granted AND (b) the original invite was for a plain member (which
    // is the only role our project invite endpoint creates). Anything
    // higher-tier must have been set deliberately at the account level
    // and shouldn't be silently dropped.
    if (remaining.length === 0 && invite.initialRole === "member") {
      await db
        .delete(accountInvitations)
        .where(eq(accountInvitations.inviteId, inviteId));
      return c.json({ ok: true, invitation_cancelled: true });
    }

    await db
      .update(accountInvitations)
      .set({ bootstrapGrants: remaining })
      .where(eq(accountInvitations.inviteId, inviteId));

    return c.json({ ok: true, invitation_cancelled: false });
  }),
);

// POST /v1/projects/:projectId/access/pending-invites/:inviteId/resend
// Re-sends the project invite email and refreshes the invitation's 14-day
// expiry. Mirrors the account-level resend, but re-frames the email around
// this project and reads the role from the bootstrap grant for this project.

projectsApp.openapi(
  createRoute({
    method: "post",
    path: "/{projectId}/access/pending-invites/{inviteId}/resend",
    tags: ["access"],
    summary: "POST /:projectId/access/pending-invites/:inviteId/resend",
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), inviteId: z.string() }),
    },
    responses: {
      200: json(z.any(), "OK"),
      ...errors(404, 409),
    },
  }),
  effectHandler(async (c: any) => {
    const projectId = c.req.param("projectId");
    const inviteId = c.req.param("inviteId");
    const loaded = await loadProjectForUser(c, projectId, "manage");
    if (!loaded) return c.json({ error: "Not found" }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE,
    );

    const [invite] = await db
      .select({
        inviteId: accountInvitations.inviteId,
        accountId: accountInvitations.accountId,
        email: accountInvitations.email,
        acceptedAt: accountInvitations.acceptedAt,
        bootstrapGrants: accountInvitations.bootstrapGrants,
      })
      .from(accountInvitations)
      .where(eq(accountInvitations.inviteId, inviteId))
      .limit(1);

    if (!invite || invite.accountId !== loaded.row.accountId) {
      return c.json({ error: "Invitation not found" }, 404);
    }
    if (invite.acceptedAt) {
      return c.json({ error: "Invitation has already been accepted" }, 409);
    }
    const grant = (invite.bootstrapGrants ?? []).find(
      (g) => g.project_id === projectId,
    );
    if (!grant) {
      return c.json({ error: "Invitation does not target this project" }, 404);
    }

    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    await db
      .update(accountInvitations)
      .set({ expiresAt })
      .where(eq(accountInvitations.inviteId, inviteId));

    const callerEmail = (c.get("userEmail") as string | undefined) ?? null;
    const [accountRow] = await db
      .select({ name: accounts.name })
      .from(accounts)
      .where(eq(accounts.accountId, loaded.row.accountId))
      .limit(1);
    const delivery = await sendAccountInviteEmail({
      email: invite.email,
      accountName: accountRow?.name ?? "Kortix",
      inviterEmail: callerEmail,
      inviteId: invite.inviteId,
      role: grant.role,
      projectName: loaded.row.name,
    });

    return c.json({
      ok: true,
      expires_at: expiresAt.toISOString(),
      invite_url: buildInviteUrl(invite.inviteId),
      email_sent: delivery.ok === true,
      email_skip_reason:
        delivery.ok === false && "reason" in delivery ? delivery.reason : null,
    });
  }),
);

projectsApp.openapi(
  createRoute({
    method: "put",
    path: "/{projectId}/access/{userId}",
    tags: ["access"],
    summary: "PUT /:projectId/access/:userId",
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), userId: z.string() }),
      body: { content: { "application/json": { schema: AnyObject } } },
    },
    responses: {
      200: json(z.any(), "OK"),
      ...errors(400, 404),
    },
  }),
  effectHandler(async (c: any) => {
    const projectId = c.req.param("projectId");
    const targetUserId = c.req.param("userId");
    const loaded = await loadProjectForUser(c, projectId, "manage");
    if (!loaded) return c.json({ error: "Not found" }, 404);
    // Member management is admin-only; loadProjectForUser('manage') now
    // resolves to project.write (editor-tier), so we add an explicit
    // stricter gate here.
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE,
    );

    const body = await readBody(c);
    const role = parseProjectRole(body.role);
    if (!role)
      return c.json({ error: "role must be one of manager|editor|user" }, 400);
    const expires = parseExpiresAtBody(body.expires_at);
    if (!expires.ok) return c.json({ error: expires.error }, 400);

    const targetMembership = await getAccountMembership(
      targetUserId,
      loaded.row.accountId,
    );
    if (!targetMembership) {
      return c.json({ error: "User is not a member of this account" }, 404);
    }

    const targetAccountRole = targetMembership.accountRole as AccountRole;
    if (isAccountManager(targetAccountRole)) {
      await db
        .delete(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, projectId),
            eq(projectMembers.userId, targetUserId),
          ),
        );
      invalidateIamCacheForUser(targetUserId);

      return c.json({
        user_id: targetUserId,
        account_role: targetAccountRole,
        project_role: null,
        effective_project_role: "manager",
        has_implicit_access: true,
      });
    }

    await grantProjectRole({
      accountId: loaded.row.accountId,
      projectId,
      userId: targetUserId,
      role,
      grantedBy: loaded.userId,
      expiresAt: expires.value,
    });

    return c.json({
      user_id: targetUserId,
      account_role: targetAccountRole,
      project_role: role,
      effective_project_role: role,
      has_implicit_access: false,
    });
  }),
);

// DELETE /v1/projects/:projectId/access/:userId

projectsApp.openapi(
  createRoute({
    method: "delete",
    path: "/{projectId}/access/{userId}",
    tags: ["access"],
    summary: "DELETE /:projectId/access/:userId",
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), userId: z.string() }),
    },
    responses: {
      200: json(z.any(), "OK"),
      ...errors(404, 409),
    },
  }),
  effectHandler(async (c: any) => {
    const projectId = c.req.param("projectId");
    const targetUserId = c.req.param("userId");
    const loaded = await loadProjectForUser(c, projectId, "manage");
    if (!loaded) return c.json({ error: "Not found" }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE,
    );

    const targetMembership = await getAccountMembership(
      targetUserId,
      loaded.row.accountId,
    );
    if (!targetMembership) {
      return c.json({ error: "User is not a member of this account" }, 404);
    }

    const targetAccountRole = targetMembership.accountRole as AccountRole;
    if (isAccountManager(targetAccountRole)) {
      return c.json(
        { error: "Owners and admins have implicit access to every project" },
        409,
      );
    }

    await db
      .delete(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, targetUserId),
        ),
      );
    invalidateIamCacheForUser(targetUserId);

    return c.json({ ok: true });
  }),
);

// ─── Project group grants (IAM V2 bulk-access channel) ────────────────────
//
// A row in project_group_grants attaches an account_group to a project
// with a chosen project_role. Every member of the group inherits that
// role on that project. These routes work for both V1 and V2 accounts —
// V1 just ignores the rows because V1's engine reads from iam_policies.

// PATCH /:projectId/experimental — toggle a per-project experimental-feature
// override (ported from main's unified feature-flag system). Auth-first (matches
// the other project routes), then validate the body — so the body schema stays
// permissive (AnyObject) and the handler returns the precise 400/403/404.
projectsApp.openapi(
  createRoute({
    method: "patch",
    path: "/{projectId}/experimental",
    tags: ["projects"],
    summary: "Set or clear a per-project experimental feature override",
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { "application/json": { schema: AnyObject } } },
    },
    responses: {
      200: json(AnyObject, "Updated project (with experimental features)"),
      ...errors(400, 401, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param("projectId");
    return runProjectRouteEffect(
      c,
      Effect.gen(function* () {
        const body = yield* attemptRoute(() => readBody(c));
        const feature = body.feature;
        const enabled = body.enabled;
        const loaded = yield* attemptRoute(() =>
          loadProjectForUser(c, projectId, "manage"),
        );
        if (!loaded) return yield* failNotFound();
        // Per-agent gate: toggling experimental features is project config. A scoped
        // agent token must hold project.customize.write (no-op for humans/PATs).
        yield* attemptRouteSync(() =>
          assertAgentScope(c, PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE),
        );
        if (!isExperimentalFeatureKey(feature)) {
          return yield* failJson(
            { error: `Unknown experimental feature '${feature}'` },
            400,
          );
        }
        if (enabled !== null && typeof enabled !== "boolean") {
          return yield* failJson(
            { error: "enabled must be a boolean or null" },
            400,
          );
        }
        const nextMeta = applyExperimentalOverride(
          loaded.row.metadata,
          feature,
          enabled,
        );
        const [row] = yield* attemptRoute(() =>
          db
            .update(projects)
            .set({ metadata: nextMeta, updatedAt: new Date() })
            .where(eq(projects.projectId, projectId))
            .returning(),
        );
        if (!row || row.status === "archived") return yield* failNotFound();
        if (feature === "agent_tunnel") {
          void reconcileComputerConnectors(row.accountId);
        }
        if (feature === "meet") {
          void reconcileChannelConnectors(projectId);
        }
        if (feature === "llm_gateway") {
          void propagateLlmGatewayModeToActiveSandboxes(
            projectId,
            projectLlmGatewayEnabled(row.metadata),
          );
        }
        return routeJson(
          serializeProject(row, {
            projectRole: loaded.projectRole,
            effectiveRole: loaded.effectiveRole,
          }),
        );
      }),
    );
  },
);

// PATCH /:projectId/sandbox-provider — set or clear the per-project sandbox-provider
// pin (Customize → Settings). The value must be an ENABLED provider
// (in ALLOWED_SANDBOX_PROVIDERS and with its API key configured), or null/'' to clear
// (follow the platform default/distribution). Bypasses the distribution weights by
// design — pin a project to platinum even when platinum's weight is 0. Same auth as
// the experimental toggle (project 'manage' + project.customize.write for agents).
projectsApp.openapi(
  createRoute({
    method: "patch",
    path: "/{projectId}/sandbox-provider",
    tags: ["projects"],
    summary: "Set or clear the per-project sandbox provider override",
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { "application/json": { schema: AnyObject } } },
    },
    responses: {
      200: json(AnyObject, "Updated project"),
      ...errors(400, 401, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param("projectId");
    return runProjectRouteEffect(
      c,
      Effect.gen(function* () {
        const body = yield* attemptRoute(() => readBody(c));
        const raw = body.provider ?? body.sandbox_provider;
        const provider =
          raw === null || raw === undefined || raw === "" ? null : String(raw);
        const loaded = yield* attemptRoute(() =>
          loadProjectForUser(c, projectId, "manage"),
        );
        if (!loaded) return yield* failNotFound();
        yield* attemptRouteSync(() =>
          assertAgentScope(c, PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE),
        );
        if (
          provider !== null &&
          !config.isProviderEnabled(provider as SandboxProviderName)
        ) {
          return yield* failJson(
            { error: `Unknown or disabled sandbox provider: ${provider}` },
            400,
          );
        }
        const meta: Record<string, unknown> = {
          ...((loaded.row.metadata as Record<string, unknown> | null) ?? {}),
        };
        if (provider === null) delete meta.default_sandbox_provider;
        else meta.default_sandbox_provider = provider;
        const [row] = yield* attemptRoute(() =>
          db
            .update(projects)
            .set({ metadata: meta, updatedAt: new Date() })
            .where(eq(projects.projectId, projectId))
            .returning(),
        );
        if (!row || row.status === "archived") return yield* failNotFound();
        return routeJson(
          serializeProject(row, {
            projectRole: loaded.projectRole,
            effectiveRole: loaded.effectiveRole,
          }),
        );
      }),
    );
  },
);
