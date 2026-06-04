/**
 * IAM backlog: ids the original spec described against a REST policy/role
 * surface (`…/iam/policies`, `…/iam/roles`, `…/iam/actions`) that DOES NOT
 * EXIST. Those V1 routes were removed in PR5 when the V2 engine
 * (apps/api/src/iam/engine-v2.ts) became the only authorization path.
 *
 * V2 decides access from six fixed code-defined roles via three tables
 * (account_members, project_members, project_group_grants) — there are no
 * policy/role CRUD routes, no deny rules, and no per-token policies.
 *
 * So these flows verify the ENGINE's observable semantics black-box through
 * the one read surface that exposes the computed decision:
 *   GET  …/iam/members/:userId/effective?action=…[&resourceType=&resourceId=]
 *   POST …/iam/members/:userId/effective:batch
 * which return { allowed, reason, action, resource_type }. The `reason`
 * field is the engine's rationale (super_admin / account_role /
 * account_role_insufficient / no_project_membership / project_role /
 * project_role_insufficient), letting us assert WHY a decision was made.
 *
 * Covers IAM-4,5,6 (no policy/role surface → fold into effective reads) and
 * IAM-9,10,11,12,13 (engine semantics). IAM-1,2,3,7,8,14-24 live in
 * iam.flow.ts — not duplicated here.
 *
 * The OWNER principal creates every team() account (the team fixture's
 * adminClient is `Client.as(OWNER)`), so OWNER is that account's owner AND
 * its super-admin.
 *
 * NOTE on query params: the action/resourceType/resourceId are passed via the
 * client's `query` option (not baked into the template) so the recorded route
 * key stays the clean manifest path `GET …/effective` — the coverage gate
 * unions runtime hits and rejects any unknown (query-suffixed) route key.
 */
import { flow } from "../core/flow";

// Path templates passed to the client (.get/.post take a path, not a key).
const EFFECTIVE = "/v1/accounts/:accountId/iam/members/:userId/effective";
const EFFECTIVE_BATCH = "/v1/accounts/:accountId/iam/members/:userId/effective:batch";
const SUPER_ADMIN = "/v1/accounts/:accountId/iam/members/:userId/super-admin";
const GROUPS = "/v1/accounts/:accountId/iam/groups";
const GROUP_MEMBERS = "/v1/accounts/:accountId/iam/groups/:groupId/members";
const PROJECT_GRANTS = "/v1/projects/:projectId/group-grants";

// Coverage keys for `meta.routes` — must be `METHOD PATH`, matching the
// route manifest (spec/routes.generated.json) exactly.
const R_EFFECTIVE = `GET ${EFFECTIVE}`;
const R_EFFECTIVE_BATCH = `POST ${EFFECTIVE_BATCH}`;
const R_SUPER_ADMIN = `PATCH ${SUPER_ADMIN}`;
const R_GROUPS_POST = `POST ${GROUPS}`;
const R_GROUP_MEMBERS_POST = `POST ${GROUP_MEMBERS}`;
const R_PROJECT_GRANTS_POST = `POST ${PROJECT_GRANTS}`;

// ─── IAM-4: no policy CRUD → effective is the read surface ──────────────────
// The V1 `…/iam/policies` GET/POST/PATCH/DELETE routes do not exist. A
// member's account-scoped permission set is decided by account_role, not by
// any creatable policy row. We assert that read surface (effective) instead.

flow(
  "IAM-4",
  { domain: "iam", serial: true, routes: [R_EFFECTIVE] },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const member = await team.addMember("member");

    await ctx.step("member's account.read is allowed via account_role", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get(EFFECTIVE, {
        params: { accountId: team.id, userId: member.userId! },
        query: { action: "account.read" },
      });
      r.status(200).body().has("$.allowed", true).has("$.reason", "account_role");
    });

    await ctx.step("member's account.write is denied (no policy can grant it)", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get(EFFECTIVE, {
        params: { accountId: team.id, userId: member.userId! },
        query: { action: "account.write" },
      });
      r.status(200)
        .body()
        .has("$.allowed", false)
        .has("$.reason", "account_role_insufficient");
    });

    await ctx.step("a user can self-probe their own effective set (no MEMBER_READ needed)", async () => {
      const r = await ctx.client.as(member).get(EFFECTIVE, {
        params: { accountId: team.id, userId: member.userId! },
        query: { action: "account.read" },
      });
      r.status(200).body().exists("$.allowed");
    });
  },
);

// ─── IAM-5: no role/action catalog → role behavior via effective ────────────
// The V1 `…/iam/roles`, `…/roles/:rid/permissions`, `…/iam/actions` reads do
// not exist. What each fixed role grants is observable only through the
// effective probe.

flow(
  "IAM-5",
  { domain: "iam", serial: true, routes: [R_EFFECTIVE] },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const member = await team.addMember("member");
    const admin = await team.addMember("admin");

    await ctx.step("admin role grants account.write; member role does not", async () => {
      const a = await ctx.client.as(ctx.P.OWNER).get(EFFECTIVE, {
        params: { accountId: team.id, userId: admin.userId! },
        query: { action: "account.write" },
      });
      a.status(200).body().has("$.allowed", true).has("$.reason", "account_role");

      const m = await ctx.client.as(ctx.P.OWNER).get(EFFECTIVE, {
        params: { accountId: team.id, userId: member.userId! },
        query: { action: "account.write" },
      });
      m.status(200).body().has("$.allowed", false);
    });

    await ctx.step("response echoes the action's resource_type (the only 'catalog' signal)", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get(EFFECTIVE, {
        params: { accountId: team.id, userId: admin.userId! },
        query: { action: "account.read" },
      });
      r.status(200).body().has("$.resource_type", "account");
    });
  },
);

// ─── IAM-6: no role CRUD → fixed project-role mapping via effective ─────────
// Roles can't be created/renamed/deleted (immutable, code-defined). The
// fixed project-role → action mapping is verified through the effective
// probe: an admin (implicit Manager) can delete any project; a plain member
// with no project path cannot.

flow(
  "IAM-6",
  { domain: "iam", serial: true, routes: [R_EFFECTIVE] },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const admin = await team.addMember("admin");
    const member = await team.addMember("member");
    const project = await team.project();

    await ctx.step("admin → implicit Manager → project.delete allowed (manager action set)", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get(EFFECTIVE, {
        params: { accountId: team.id, userId: admin.userId! },
        query: { action: "project.delete", resourceType: "project", resourceId: project.id },
      });
      r.status(200).body().has("$.allowed", true).has("$.reason", "project_role");
    });

    await ctx.step("member with no project path → project.delete denied", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get(EFFECTIVE, {
        params: { accountId: team.id, userId: member.userId! },
        query: { action: "project.delete", resourceType: "project", resourceId: project.id },
      });
      r.status(200)
        .body()
        .has("$.allowed", false)
        .has("$.reason", "no_project_membership");
    });
  },
);

// ─── IAM-9: super-admin bypass ──────────────────────────────────────────────
// The account creator (OWNER) is super-admin. Every probe returns
// allowed:true with reason:super_admin — including project actions on a
// project that does not even exist — i.e. the engine short-circuits before
// any role/membership check. Revoking super-admin drops the reason to the
// ordinary role path.

flow(
  "IAM-9",
  { domain: "iam", serial: true, routes: [R_EFFECTIVE_BATCH, R_SUPER_ADMIN, R_EFFECTIVE] },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const ownerId = ctx.P.OWNER.userId!;

    await ctx.step("OWNER (super-admin) → allowed:true reason:super_admin for everything", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        EFFECTIVE_BATCH,
        {
          probes: [
            { action: "account.write" },
            { action: "project.create" },
            // project action against a NONEXISTENT project — still allowed,
            // proving the bypass runs before any membership lookup.
            {
              action: "project.delete",
              resourceType: "project",
              resourceId: "00000000-0000-0000-0000-000000000000",
            },
          ],
        },
        { params: { accountId: team.id, userId: ownerId } },
      );
      r.status(200)
        .body()
        .has("$.results[0].allowed", true)
        .has("$.results[0].reason", "super_admin")
        .has("$.results[1].reason", "super_admin")
        .has("$.results[2].allowed", true)
        .has("$.results[2].reason", "super_admin");
    });

    await ctx.step("revoke OWNER's super-admin → still allowed but via account_role, NOT super_admin", async () => {
      const rev = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          SUPER_ADMIN,
          { isSuperAdmin: false },
          { params: { accountId: team.id, userId: ownerId } },
        );
      rev.status(200).body().has("$.is_super_admin", false);

      const r = await ctx.client.as(ctx.P.OWNER).get(EFFECTIVE, {
        params: { accountId: team.id, userId: ownerId },
        query: { action: "account.write" },
      });
      r.status(200).body().has("$.allowed", true).has("$.reason", "account_role");
    });
  },
);

// ─── IAM-10: no deny precedence (deny-wins does not exist) ──────────────────
// V2 has no deny rules — access is allow-by-role, max-role-wins across
// direct + group sources. The classic allow+deny conflict is not
// constructible through any real route. Closest assertion: a low direct role
// and a high group grant on the SAME project → effective = the MAX role, and
// the lower grant never vetoes the higher. (deny-wins itself is unverifiable
// black-box because the feature was removed.)

flow(
  "IAM-10",
  {
    domain: "iam",
    serial: true,
    routes: [R_EFFECTIVE, R_GROUPS_POST, R_GROUP_MEMBERS_POST, R_PROJECT_GRANTS_POST],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const member = await team.addMember("member");
    const project = await team.project();

    // Low direct role: Viewer (cannot delete).
    await ctx.step("give member a direct Viewer role on the project", async () => {
      await team.grantProjectRole(project.id, member.userId!, "viewer");
    });

    // High group grant: Manager (can delete) on the same project.
    let groupId = "";
    await ctx.step("create a group, add the member, grant the group Manager on the project", async () => {
      const g = await ctx.client
        .as(ctx.P.OWNER)
        .post(GROUPS, { name: ctx.fixtures.name("grp") }, { params: { accountId: team.id } });
      g.status(201);
      groupId = g.json<any>().group_id;

      const add = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          GROUP_MEMBERS,
          { userId: member.userId! },
          { params: { accountId: team.id, groupId } },
        );
      add.status(200).body().has("$.added", 1);

      const grant = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          PROJECT_GRANTS,
          { group_id: groupId, role: "manager" },
          { params: { projectId: project.id } },
        );
      grant.status(201).body().has("$.role", "manager");
    });

    await ctx.step("max-role-wins: project.delete allowed (Manager grant overrides the lower Viewer; nothing denies)", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get(EFFECTIVE, {
        params: { accountId: team.id, userId: member.userId! },
        query: { action: "project.delete", resourceType: "project", resourceId: project.id },
      });
      r.status(200).body().has("$.allowed", true).has("$.reason", "project_role");
    });
  },
);

// ─── IAM-11: PATs inherit the minter (no token-only policy eval) ────────────
// V2 has no per-token policies. An unscoped account PAT carries no narrowing
// rule set; its access equals the user it was minted by. We assert the
// minter's effective set is exactly the engine's role decision (the same
// answer a PAT minted by them would inherit). Per-token policy evaluation is
// unverifiable black-box because that feature does not exist.

flow(
  "IAM-11",
  { domain: "iam", serial: true, routes: [R_EFFECTIVE, R_EFFECTIVE_BATCH] },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const ownerId = ctx.P.OWNER.userId!;

    await ctx.step("minter (super-admin OWNER) effective = super_admin — a PAT inherits this, not a policy subset", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get(EFFECTIVE, {
        params: { accountId: team.id, userId: ownerId },
        query: { action: "account.write" },
      });
      // PARTIAL: the engine has no token dimension on this endpoint, so we
      // assert the inherited (minter) decision the PAT would carry. There is
      // no narrowing-policy state to construct and contrast against.
      r.status(200).body().has("$.allowed", true).has("$.reason", "super_admin");
    });

    await ctx.step("a plain member's inherited set is account-reads only (what their PAT would carry)", async () => {
      const member = await team.addMember("member");
      const r = await ctx.client.as(ctx.P.OWNER).post(
        EFFECTIVE_BATCH,
        { probes: [{ action: "account.read" }, { action: "account.write" }] },
        { params: { accountId: team.id, userId: member.userId! } },
      );
      r.status(200)
        .body()
        .has("$.results[0].allowed", true)
        .has("$.results[1].allowed", false);
    });
  },
);

// ─── IAM-12: legacy role bridge ─────────────────────────────────────────────
// account_role maps to the V2 action set: a plain member gets account-reads
// only (no account.write, no project.create → cannot reach all projects); a
// project_members row bridges to the matching project role.

flow(
  "IAM-12",
  { domain: "iam", serial: true, routes: [R_EFFECTIVE_BATCH, R_EFFECTIVE] },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const member = await team.addMember("member");
    const admin = await team.addMember("admin");
    const project = await team.project();

    await ctx.step("plain member: account.read allowed, account.write + project.create denied", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        EFFECTIVE_BATCH,
        {
          probes: [
            { action: "account.read" },
            { action: "account.write" },
            { action: "project.create" },
          ],
        },
        { params: { accountId: team.id, userId: member.userId! } },
      );
      r.status(200)
        .body()
        .has("$.results[0].allowed", true)
        .has("$.results[0].reason", "account_role")
        .has("$.results[1].allowed", false)
        .has("$.results[1].reason", "account_role_insufficient")
        .has("$.results[2].allowed", false);
    });

    await ctx.step("admin bridges to Administrator-level set: account.write allowed", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get(EFFECTIVE, {
        params: { accountId: team.id, userId: admin.userId! },
        query: { action: "account.write" },
      });
      r.status(200).body().has("$.allowed", true).has("$.reason", "account_role");
    });

    await ctx.step("project_members row bridges to the project role: direct Editor → project.write allowed", async () => {
      await team.grantProjectRole(project.id, member.userId!, "editor");
      const r = await ctx.client.as(ctx.P.OWNER).get(EFFECTIVE, {
        params: { accountId: team.id, userId: member.userId! },
        query: { action: "project.write", resourceType: "project", resourceId: project.id },
      });
      r.status(200).body().has("$.allowed", true).has("$.reason", "project_role");
    });
  },
);

// ─── IAM-13: scope match ────────────────────────────────────────────────────
// A project group-grant matches only its own project. Grant a group Manager
// on project A; the member is allowed on A (project_role) but denied on
// project B (no_project_membership), and the account-scoped probe (no
// resourceId) is also denied — proving the grant is scoped to A's resource.

flow(
  "IAM-13",
  {
    domain: "iam",
    serial: true,
    routes: [R_EFFECTIVE, R_GROUPS_POST, R_GROUP_MEMBERS_POST, R_PROJECT_GRANTS_POST],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const member = await team.addMember("member");
    const projectA = await team.project();
    const projectB = await team.project();

    let groupId = "";
    await ctx.step("create group, add member, grant group Manager on project A only", async () => {
      const g = await ctx.client
        .as(ctx.P.OWNER)
        .post(GROUPS, { name: ctx.fixtures.name("grp") }, { params: { accountId: team.id } });
      g.status(201);
      groupId = g.json<any>().group_id;

      const add = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          GROUP_MEMBERS,
          { userId: member.userId! },
          { params: { accountId: team.id, groupId } },
        );
      add.status(200).body().has("$.added", 1);

      const grant = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          PROJECT_GRANTS,
          { group_id: groupId, role: "manager" },
          { params: { projectId: projectA.id } },
        );
      grant.status(201);
    });

    await ctx.step("matching scope (project A) → project.delete allowed via project_role", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get(EFFECTIVE, {
        params: { accountId: team.id, userId: member.userId! },
        query: { action: "project.delete", resourceType: "project", resourceId: projectA.id },
      });
      r.status(200).body().has("$.allowed", true).has("$.reason", "project_role");
    });

    await ctx.step("non-matching scope (project B, no grant) → denied no_project_membership", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get(EFFECTIVE, {
        params: { accountId: team.id, userId: member.userId! },
        query: { action: "project.delete", resourceType: "project", resourceId: projectB.id },
      });
      r.status(200)
        .body()
        .has("$.allowed", false)
        .has("$.reason", "no_project_membership");
    });

    await ctx.step("account-scoped probe (no resourceId) → project.delete denied (grant is resource-scoped)", async () => {
      // With no resourceType the engine treats target as account; a
      // project.* action then fails project_target_required.
      const r = await ctx.client.as(ctx.P.OWNER).get(EFFECTIVE, {
        params: { accountId: team.id, userId: member.userId! },
        query: { action: "project.delete" },
      });
      r.status(200).body().has("$.allowed", false);
    });
  },
);
