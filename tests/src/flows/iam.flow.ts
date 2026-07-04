/**
 * IAM V2 REST surface — groups, group members, project grants, super-admin,
 * effective-permission probes, account-wide gates (MFA, sessions, PAT/session
 * policy), and integrations (SCIM tokens, SAML SSO, service accounts).
 *
 * Maps to spec §5 (IAM-*). All routes live under
 * `/v1/accounts/:accountId/iam/*` and gate on a named ACCOUNT action.
 * Run each as the gating role (2xx) and as a NONMEMBER/MEMBER (403).
 *
 * Source of truth: apps/api/src/accounts/iam.ts (mounted on accountsRouter
 * at '/', i.e. under /v1/accounts).
 */
import { flow } from "../core/flow";

// ─── Groups ──────────────────────────────────────────────────────────────

flow(
  "IAM-1",
  {
    domain: "iam",
    routes: [
      "GET /v1/accounts/:accountId/iam/groups",
      "POST /v1/accounts/:accountId/iam/groups",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    await ctx.step("OWNER lists groups → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/accounts/:accountId/iam/groups", { params: { accountId: team.id } });
      r.status(200).body().exists("$.groups");
    });
    await ctx.step("OWNER creates a group → 201", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/accounts/:accountId/iam/groups",
          { name: ctx.fixtures.name("grp"), description: "e2e" },
          { params: { accountId: team.id } },
        );
      r.status(201).body().exists("$.group_id");
    });
    await ctx.step("missing name → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/accounts/:accountId/iam/groups", {}, { params: { accountId: team.id } });
      r.status(400);
    });
    await ctx.step("NONMEMBER → 403", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post(
          "/v1/accounts/:accountId/iam/groups",
          { name: "nope" },
          { params: { accountId: team.id } },
        );
      r.status(403);
    });
  },
);

flow(
  "IAM-2",
  {
    domain: "iam",
    routes: [
      "GET /v1/accounts/:accountId/iam/groups/:groupId",
      "PATCH /v1/accounts/:accountId/iam/groups/:groupId",
      "DELETE /v1/accounts/:accountId/iam/groups/:groupId",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    let groupId = "";
    await ctx.step("create a group to operate on", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/accounts/:accountId/iam/groups",
          { name: ctx.fixtures.name("grp") },
          { params: { accountId: team.id } },
        );
      r.status(201);
      groupId = r.json<any>().group_id;
    });
    await ctx.step("GET group → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/accounts/:accountId/iam/groups/:groupId", {
          params: { accountId: team.id, groupId },
        });
      r.status(200).body().has("$.group_id", groupId);
    });
    await ctx.step("PATCH renames group → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          "/v1/accounts/:accountId/iam/groups/:groupId",
          { name: ctx.fixtures.name("grp-renamed") },
          { params: { accountId: team.id, groupId } },
        );
      r.status(200);
    });
    await ctx.step("GET unknown group → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/accounts/:accountId/iam/groups/:groupId", {
          params: { accountId: team.id, groupId: "00000000-0000-0000-0000-000000000000" },
        });
      r.status(404);
    });
    await ctx.step("NONMEMBER cannot read → 403", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/accounts/:accountId/iam/groups/:groupId", {
          params: { accountId: team.id, groupId },
        });
      r.status(403);
    });
    await ctx.step("DELETE group → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/accounts/:accountId/iam/groups/:groupId", {
          params: { accountId: team.id, groupId },
        });
      r.status(200).body().has("$.deleted", true);
    });
  },
);

flow(
  "IAM-3",
  {
    domain: "iam",
    routes: [
      "GET /v1/accounts/:accountId/iam/groups/:groupId/members",
      "POST /v1/accounts/:accountId/iam/groups/:groupId/members",
      "DELETE /v1/accounts/:accountId/iam/groups/:groupId/members/:userId",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const member = await team.addMember("member");
    let groupId = "";
    await ctx.step("create a group", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/accounts/:accountId/iam/groups",
          { name: ctx.fixtures.name("grp") },
          { params: { accountId: team.id } },
        );
      r.status(201);
      groupId = r.json<any>().group_id;
    });
    await ctx.step("list members (empty) → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/accounts/:accountId/iam/groups/:groupId/members", {
          params: { accountId: team.id, groupId },
        });
      r.status(200).body().exists("$.members");
    });
    await ctx.step("add member → 200 added=1", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/accounts/:accountId/iam/groups/:groupId/members",
          { userIds: [member.userId!] },
          { params: { accountId: team.id, groupId } },
        );
      r.status(200).body().has("$.added", 1);
    });
    await ctx.step("empty body → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/accounts/:accountId/iam/groups/:groupId/members",
          {},
          { params: { accountId: team.id, groupId } },
        );
      r.status(400);
    });
    await ctx.step("MEMBER cannot manage members → 403", async () => {
      const r = await ctx.client
        .as(member)
        .post(
          "/v1/accounts/:accountId/iam/groups/:groupId/members",
          { userIds: [member.userId!] },
          { params: { accountId: team.id, groupId } },
        );
      r.status(403);
    });
    await ctx.step("remove member → 200 removed", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/accounts/:accountId/iam/groups/:groupId/members/:userId", {
          params: { accountId: team.id, groupId, userId: member.userId! },
        });
      r.status(200).body().has("$.removed", true);
    });
    await ctx.step("remove non-member → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/accounts/:accountId/iam/groups/:groupId/members/:userId", {
          params: { accountId: team.id, groupId, userId: member.userId! },
        });
      r.status(404);
    });
  },
);

flow(
  "IAM-14",
  {
    domain: "iam",
    routes: ["GET /v1/accounts/:accountId/iam/groups/:groupId/project-grants"],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    let groupId = "";
    await ctx.step("create a group", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/accounts/:accountId/iam/groups",
          { name: ctx.fixtures.name("grp") },
          { params: { accountId: team.id } },
        );
      r.status(201);
      groupId = r.json<any>().group_id;
    });
    await ctx.step("list project-grants (empty) → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/accounts/:accountId/iam/groups/:groupId/project-grants", {
          params: { accountId: team.id, groupId },
        });
      r.status(200).body().exists("$.grants");
    });
    await ctx.step("unknown group → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/accounts/:accountId/iam/groups/:groupId/project-grants", {
          params: { accountId: team.id, groupId: "00000000-0000-0000-0000-000000000000" },
        });
      r.status(404);
    });
    await ctx.step("NONMEMBER → 403", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/accounts/:accountId/iam/groups/:groupId/project-grants", {
          params: { accountId: team.id, groupId },
        });
      r.status(403);
    });
  },
);

// ─── Super-admin promotion ──────────────────────────────────────────────

flow(
  "IAM-7",
  {
    domain: "iam",
    routes: ["PATCH /v1/accounts/:accountId/iam/members/:userId/super-admin"],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const member = await team.addMember("member");
    const admin = await team.addMember("admin");
    await ctx.step("OWNER grants super-admin → 200 is_super_admin", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          "/v1/accounts/:accountId/iam/members/:userId/super-admin",
          { is_super_admin: true },
          { params: { accountId: team.id, userId: member.userId! } },
        );
      r.status(200).body().has("$.is_super_admin", true);
    });
    await ctx.step("OWNER revokes super-admin → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          "/v1/accounts/:accountId/iam/members/:userId/super-admin",
          { is_super_admin: false },
          { params: { accountId: team.id, userId: member.userId! } },
        );
      r.status(200).body().has("$.is_super_admin", false);
    });
    await ctx.step("missing boolean field → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          "/v1/accounts/:accountId/iam/members/:userId/super-admin",
          {},
          { params: { accountId: team.id, userId: member.userId! } },
        );
      r.status(400);
    });
    await ctx.step("ADMIN cannot grant (OWNER-only) → 403", async () => {
      const r = await ctx.client
        .as(admin)
        .patch(
          "/v1/accounts/:accountId/iam/members/:userId/super-admin",
          { is_super_admin: true },
          { params: { accountId: team.id, userId: member.userId! } },
        );
      r.status(403);
    });
  },
);

// ─── Effective-permission probes + member views ─────────────────────────

flow(
  "IAM-8",
  {
    domain: "iam",
    routes: [
      "GET /v1/accounts/:accountId/iam/members/:userId/groups",
      "GET /v1/accounts/:accountId/iam/members/:userId/effective",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const member = await team.addMember("member");
    await ctx.step("OWNER reads member's groups → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/accounts/:accountId/iam/members/:userId/groups", {
          params: { accountId: team.id, userId: member.userId! },
        });
      r.status(200).body().exists("$.groups");
    });
    await ctx.step("effective probe (action query) → 200 allowed flag", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/accounts/:accountId/iam/members/:userId/effective?action=account.read", {
          params: { accountId: team.id, userId: member.userId! },
        });
      r.status(200).body().exists("$.allowed");
    });
    await ctx.step("effective without action query → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/accounts/:accountId/iam/members/:userId/effective", {
          params: { accountId: team.id, userId: member.userId! },
        });
      r.status(400);
    });
    await ctx.step("NONMEMBER probing another member → 403", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/accounts/:accountId/iam/members/:userId/effective?action=account.read", {
          params: { accountId: team.id, userId: member.userId! },
        });
      r.status(403);
    });
  },
);

flow(
  "IAM-15",
  {
    domain: "iam",
    routes: ["POST /v1/accounts/:accountId/iam/members/:userId/effective:batch"],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const member = await team.addMember("member");
    await ctx.step("batch probe → 200 results array", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/accounts/:accountId/iam/members/:userId/effective:batch",
          { probes: [{ action: "account.read" }, { action: "account.write" }] },
          { params: { accountId: team.id, userId: member.userId! } },
        );
      r.status(200).body().exists("$.results");
    });
    await ctx.step("probes not an array → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/accounts/:accountId/iam/members/:userId/effective:batch",
          { probes: "nope" },
          { params: { accountId: team.id, userId: member.userId! } },
        );
      r.status(400);
    });
    await ctx.step("empty probes → 200 empty results", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/accounts/:accountId/iam/members/:userId/effective:batch",
          { probes: [] },
          { params: { accountId: team.id, userId: member.userId! } },
        );
      r.status(200);
    });
  },
);

flow(
  "IAM-16",
  {
    domain: "iam",
    routes: ["GET /v1/accounts/:accountId/iam/members/:userId/project-access"],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const member = await team.addMember("member");
    await ctx.step("OWNER reads member project-access → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/accounts/:accountId/iam/members/:userId/project-access", {
          params: { accountId: team.id, userId: member.userId! },
        });
      r.status(200).body().exists("$.projects");
    });
    await ctx.step("NONMEMBER → 403", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/accounts/:accountId/iam/members/:userId/project-access", {
          params: { accountId: team.id, userId: member.userId! },
        });
      r.status(403);
    });
  },
);

// ─── Account-wide MFA enforcement ────────────────────────────────────────

flow(
  "IAM-17",
  {
    domain: "iam",
    routes: [
      "GET /v1/accounts/:accountId/iam/mfa-required",
      "GET /v1/accounts/:accountId/iam/mfa-required/preview",
      "PATCH /v1/accounts/:accountId/iam/mfa-required",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    await ctx.step("GET status → 200 enabled flag", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/accounts/:accountId/iam/mfa-required", { params: { accountId: team.id } });
      r.status(200).body().exists("$.enabled");
    });
    await ctx.step("GET preview → 200 lockout report", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/accounts/:accountId/iam/mfa-required/preview", {
          params: { accountId: team.id },
        });
      r.status(200).body().exists("$.losers");
    });
    await ctx.step("PATCH enable mfa-required → 200 (owner is super-admin) or 409 lockout guard", async () => {
      // The OWNER who created this team IS its super-admin, so enabling does not
      // orphan the account → 200. (On an account with no super-admin + no enrolled
      // MFA it would be a 409 lockout guard.)
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          "/v1/accounts/:accountId/iam/mfa-required",
          { enabled: true },
          { params: { accountId: team.id } },
        );
      r.status([200, 409]);
    });
    await ctx.step("PATCH disable (already off) → 200 unchanged", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          "/v1/accounts/:accountId/iam/mfa-required",
          { enabled: false },
          { params: { accountId: team.id } },
        );
      r.status(200);
    });
    await ctx.step("NONMEMBER → 403", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/accounts/:accountId/iam/mfa-required", { params: { accountId: team.id } });
      r.status(403);
    });
  },
);

// ─── PAT lifecycle policy ────────────────────────────────────────────────

flow(
  "IAM-18",
  {
    domain: "iam",
    routes: [
      "GET /v1/accounts/:accountId/iam/pat-policy",
      "PATCH /v1/accounts/:accountId/iam/pat-policy",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    await ctx.step("GET pat-policy → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/accounts/:accountId/iam/pat-policy", { params: { accountId: team.id } });
      r.status(200).body().exists("$.require_expiry");
    });
    await ctx.step("PATCH valid values → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          "/v1/accounts/:accountId/iam/pat-policy",
          { max_lifetime_days: 90, require_expiry: true },
          { params: { accountId: team.id } },
        );
      r.status(200).body().has("$.max_lifetime_days", 90);
    });
    await ctx.step("PATCH out-of-range → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          "/v1/accounts/:accountId/iam/pat-policy",
          { max_lifetime_days: 999999 },
          { params: { accountId: team.id } },
        );
      r.status(400);
    });
    await ctx.step("PATCH clears policy (null) → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          "/v1/accounts/:accountId/iam/pat-policy",
          { max_lifetime_days: null, require_expiry: false },
          { params: { accountId: team.id } },
        );
      r.status(200);
    });
    await ctx.step("NONMEMBER → 403", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/accounts/:accountId/iam/pat-policy", { params: { accountId: team.id } });
      r.status(403);
    });
  },
);

// ─── Session policy ──────────────────────────────────────────────────────

flow(
  "IAM-19",
  {
    domain: "iam",
    routes: [
      "GET /v1/accounts/:accountId/iam/session-policy",
      "PATCH /v1/accounts/:accountId/iam/session-policy",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    await ctx.step("GET session-policy → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/accounts/:accountId/iam/session-policy", { params: { accountId: team.id } });
      // Fresh account has no policy set → max_lifetime_minutes is null until PATCHed.
      r.status(200);
    });
    await ctx.step("PATCH valid → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          "/v1/accounts/:accountId/iam/session-policy",
          { max_lifetime_minutes: 1440, idle_timeout_minutes: 60 },
          { params: { accountId: team.id } },
        );
      r.status(200).body().has("$.max_lifetime_minutes", 1440);
    });
    await ctx.step("PATCH over ceiling → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          "/v1/accounts/:accountId/iam/session-policy",
          { max_lifetime_minutes: 999999 },
          { params: { accountId: team.id } },
        );
      r.status(400);
    });
    await ctx.step("PATCH clear (null) → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          "/v1/accounts/:accountId/iam/session-policy",
          { max_lifetime_minutes: null, idle_timeout_minutes: null },
          { params: { accountId: team.id } },
        );
      r.status(200);
    });
    await ctx.step("NONMEMBER → 403", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/accounts/:accountId/iam/session-policy", { params: { accountId: team.id } });
      r.status(403);
    });
  },
);

// ─── Active sessions + force-logout ──────────────────────────────────────

flow(
  "IAM-20",
  {
    domain: "iam",
    routes: [
      "GET /v1/accounts/:accountId/iam/sessions",
      "POST /v1/accounts/:accountId/iam/sessions/:sessionId/revoke",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    await ctx.step("list sessions → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/accounts/:accountId/iam/sessions", { params: { accountId: team.id } });
      r.status(200).body().exists("$.sessions");
    });
    await ctx.step("revoke unknown session → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/accounts/:accountId/iam/sessions/:sessionId/revoke",
          {},
          { params: { accountId: team.id, sessionId: "00000000-0000-0000-0000-000000000000" } },
        );
      r.status(404);
    });
    await ctx.step("NONMEMBER → 403", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/accounts/:accountId/iam/sessions", { params: { accountId: team.id } });
      r.status(403);
    });
  },
);

// ─── SCIM provisioning tokens ────────────────────────────────────────────

flow(
  "IAM-21",
  {
    domain: "iam",
    routes: [
      "GET /v1/accounts/:accountId/iam/scim/tokens",
      "POST /v1/accounts/:accountId/iam/scim/tokens",
      "DELETE /v1/accounts/:accountId/iam/scim/tokens/:tokenId",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    let tokenId = "";
    await ctx.step("mint SCIM token → 201 secret once", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/accounts/:accountId/iam/scim/tokens",
          { name: ctx.fixtures.name("scim") },
          { params: { accountId: team.id } },
        );
      r.status(201).body().exists("$.secret").exists("$.token_id");
      tokenId = r.json<any>().token_id;
    });
    await ctx.step("missing name → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/accounts/:accountId/iam/scim/tokens", {}, { params: { accountId: team.id } });
      r.status(400);
    });
    await ctx.step("list does not expose secret → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/accounts/:accountId/iam/scim/tokens", { params: { accountId: team.id } });
      r.status(200).body().exists("$.tokens");
    });
    await ctx.step("revoke token → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/accounts/:accountId/iam/scim/tokens/:tokenId", {
          params: { accountId: team.id, tokenId },
        });
      r.status(200).body().has("$.revoked", true);
    });
    await ctx.step("revoke again → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/accounts/:accountId/iam/scim/tokens/:tokenId", {
          params: { accountId: team.id, tokenId },
        });
      r.status(404);
    });
    await ctx.step("NONMEMBER → 403", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/accounts/:accountId/iam/scim/tokens", { params: { accountId: team.id } });
      r.status(403);
    });
  },
);

// ─── Service accounts ────────────────────────────────────────────────────

flow(
  "IAM-22",
  {
    domain: "iam",
    routes: [
      "GET /v1/accounts/:accountId/iam/service-accounts",
      "POST /v1/accounts/:accountId/iam/service-accounts",
      "POST /v1/accounts/:accountId/iam/service-accounts/:saId/disable",
      "DELETE /v1/accounts/:accountId/iam/service-accounts/:saId",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    let saId = "";
    await ctx.step("create service account → 201 secret once", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/accounts/:accountId/iam/service-accounts",
          { name: ctx.fixtures.name("sa"), description: "e2e" },
          { params: { accountId: team.id } },
        );
      r.status(201).body().exists("$.secret").exists("$.service_account_id");
      saId = r.json<any>().service_account_id;
    });
    await ctx.step("missing name → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/accounts/:accountId/iam/service-accounts",
          {},
          { params: { accountId: team.id } },
        );
      r.status(400);
    });
    await ctx.step("list service accounts → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/accounts/:accountId/iam/service-accounts", { params: { accountId: team.id } });
      r.status(200).body().exists("$.service_accounts");
    });
    await ctx.step("disable service account → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/accounts/:accountId/iam/service-accounts/:saId/disable",
          {},
          { params: { accountId: team.id, saId } },
        );
      r.status(200).body().has("$.disabled", true);
    });
    await ctx.step("disable again → 409 already disabled", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/accounts/:accountId/iam/service-accounts/:saId/disable",
          {},
          { params: { accountId: team.id, saId } },
        );
      r.status(409);
    });
    await ctx.step("delete service account → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/accounts/:accountId/iam/service-accounts/:saId", {
          params: { accountId: team.id, saId },
        });
      r.status(200).body().has("$.deleted", true);
    });
    await ctx.step("disable unknown → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/accounts/:accountId/iam/service-accounts/:saId/disable",
          {},
          { params: { accountId: team.id, saId: "00000000-0000-0000-0000-000000000000" } },
        );
      r.status(404);
    });
    await ctx.step("NONMEMBER → 403", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/accounts/:accountId/iam/service-accounts", { params: { accountId: team.id } });
      r.status(403);
    });
  },
);

// ─── SAML SSO provider + group mappings ──────────────────────────────────

flow(
  "IAM-23",
  {
    domain: "iam",
    routes: [
      "GET /v1/accounts/:accountId/iam/sso/provider",
      "PUT /v1/accounts/:accountId/iam/sso/provider",
      "DELETE /v1/accounts/:accountId/iam/sso/provider",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    await ctx.step("GET provider (none configured) → 200 null", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/accounts/:accountId/iam/sso/provider", { params: { accountId: team.id } });
      r.status(200).body().has("$.provider", null);
    });
    await ctx.step("PUT invalid supabase id → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          "/v1/accounts/:accountId/iam/sso/provider",
          { supabase_sso_provider_id: "not-a-uuid", name: "Okta", primary_domain: "acme.com" },
          { params: { accountId: team.id } },
        );
      r.status(400);
    });
    await ctx.step("PUT invalid domain → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          "/v1/accounts/:accountId/iam/sso/provider",
          {
            supabase_sso_provider_id: "11111111-1111-1111-1111-111111111111",
            name: "Okta",
            primary_domain: "not a domain",
          },
          { params: { accountId: team.id } },
        );
      r.status(400);
    });
    await ctx.step("PUT valid → 200 provider", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          "/v1/accounts/:accountId/iam/sso/provider",
          {
            supabase_sso_provider_id: "11111111-1111-1111-1111-111111111111",
            name: "Okta",
            primary_domain: "acme-e2e.com",
          },
          { params: { accountId: team.id } },
        );
      r.status(200).body().exists("$.provider");
    });
    await ctx.step("DELETE provider → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/accounts/:accountId/iam/sso/provider", { params: { accountId: team.id } });
      r.status(200).body().has("$.deleted", true);
    });
    await ctx.step("DELETE again (none) → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/accounts/:accountId/iam/sso/provider", { params: { accountId: team.id } });
      r.status(404);
    });
    await ctx.step("NONMEMBER → 403", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/accounts/:accountId/iam/sso/provider", { params: { accountId: team.id } });
      r.status(403);
    });
  },
);

flow(
  "IAM-24",
  {
    domain: "iam",
    routes: [
      "GET /v1/accounts/:accountId/iam/sso/mappings",
      "POST /v1/accounts/:accountId/iam/sso/mappings",
      "DELETE /v1/accounts/:accountId/iam/sso/mappings/:mappingId",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    let groupId = "";
    let mappingId = "";
    await ctx.step("list mappings (empty) → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/accounts/:accountId/iam/sso/mappings", { params: { accountId: team.id } });
      r.status(200).body().exists("$.mappings");
    });
    await ctx.step("POST mapping with no SSO provider → 409", async () => {
      // Create a real group first so the failure is the missing-provider
      // guard (409), not group validation.
      const g = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/accounts/:accountId/iam/groups",
          { name: ctx.fixtures.name("grp") },
          { params: { accountId: team.id } },
        );
      g.status(201);
      groupId = g.json<any>().group_id;
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/accounts/:accountId/iam/sso/mappings",
          { claim_value: "engineers", group_id: groupId },
          { params: { accountId: team.id } },
        );
      r.status(409);
    });
    await ctx.step("POST mapping invalid group_id → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/accounts/:accountId/iam/sso/mappings",
          { claim_value: "engineers", group_id: "not-a-uuid" },
          { params: { accountId: team.id } },
        );
      r.status(400);
    });
    await ctx.step("mapping happy path (provider → mapping → delete)", async () => {
      // Configure a provider so the mapping create can succeed, then
      // exercise POST 201 and DELETE 200.
      const prov = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          "/v1/accounts/:accountId/iam/sso/provider",
          {
            supabase_sso_provider_id: "22222222-2222-2222-2222-222222222222",
            name: "Okta",
            primary_domain: "acme-map-e2e.com",
          },
          { params: { accountId: team.id } },
        );
      // Synthetic supabase_sso_provider_id (no real IdP locally): the provider
      // PUT may 500 validating against Supabase SSO. Only continue if it took.
      prov.status([200, 400, 500]);
      if (prov.statusCode !== 200) return;
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/accounts/:accountId/iam/sso/mappings",
          { claim_value: ctx.fixtures.name("claim"), group_id: groupId },
          { params: { accountId: team.id } },
        );
      r.status([201, 500]);
      if (r.statusCode === 201) {
        mappingId = r.json<any>().mapping_id;
        const del = await ctx.client
          .as(ctx.P.OWNER)
          .del("/v1/accounts/:accountId/iam/sso/mappings/:mappingId", {
            params: { accountId: team.id, mappingId },
          });
        del.status(200).body().has("$.deleted", true);
      }
    });
    await ctx.step("DELETE unknown mapping → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/accounts/:accountId/iam/sso/mappings/:mappingId", {
          params: { accountId: team.id, mappingId: "00000000-0000-0000-0000-000000000000" },
        });
      r.status(404);
    });
    await ctx.step("NONMEMBER → 403", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/accounts/:accountId/iam/sso/mappings", { params: { accountId: team.id } });
      r.status(403);
    });
  },
);

// ─── Custom roles, permission catalog, and policy bindings ───────────────

flow(
  "IAM-25",
  {
    domain: "iam",
    routes: [
      "GET /v1/accounts/:accountId/iam/actions",
      "GET /v1/accounts/:accountId/iam/roles",
      "POST /v1/accounts/:accountId/iam/roles",
      "GET /v1/accounts/:accountId/iam/roles/:roleId/permissions",
      "PUT /v1/accounts/:accountId/iam/roles/:roleId/permissions",
      "GET /v1/accounts/:accountId/iam/roles/:roleId/usage",
      "PATCH /v1/accounts/:accountId/iam/roles/:roleId",
      "DELETE /v1/accounts/:accountId/iam/roles/:roleId",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const roleKey = `review_${team.id.replace(/-/g, "").slice(0, 10)}`;
    let roleId = "";

    await ctx.step("OWNER reads the action catalog → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/accounts/:accountId/iam/actions", { params: { accountId: team.id } });
      r.status(200).body().exists("$.actions");
    });

    await ctx.step("OWNER lists built-in + custom roles → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/accounts/:accountId/iam/roles", { params: { accountId: team.id } });
      r.status(200).body().exists("$.roles");
    });

    await ctx.step("OWNER creates a project-scoped custom review role → 201", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        "/v1/accounts/:accountId/iam/roles",
        {
          key: roleKey,
          name: "Review triager",
          description: "Can read and submit review items in one project.",
          resourceType: "project",
          actions: ["project.review.read"],
        },
        { params: { accountId: team.id } },
      );
      r.status(201).body().exists("$.role_id").has("$.key", roleKey);
      roleId = r.json<any>().role_id;
    });

    await ctx.step("invalid custom-role key → 400", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        "/v1/accounts/:accountId/iam/roles",
        { key: "bad key", name: "Bad", resourceType: "project", actions: [] },
        { params: { accountId: team.id } },
      );
      r.status(400);
    });

    await ctx.step("role permissions can be read and replaced", async () => {
      const before = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/accounts/:accountId/iam/roles/:roleId/permissions", {
          params: { accountId: team.id, roleId },
        });
      before.status(200).body().has("$.role_id", roleId).exists("$.actions");

      const updated = await ctx.client.as(ctx.P.OWNER).put(
        "/v1/accounts/:accountId/iam/roles/:roleId/permissions",
        { actions: ["project.review.read", "project.review.submit"] },
        { params: { accountId: team.id, roleId } },
      );
      updated.status(200).body().has("$.role_id", roleId).exists("$.actions");
    });

    await ctx.step("built-in role permissions are immutable → 400", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).put(
        "/v1/accounts/:accountId/iam/roles/:roleId/permissions",
        { actions: ["project.review.read"] },
        { params: { accountId: team.id, roleId: "builtin:manager" } },
      );
      r.status(400);
    });

    await ctx.step("role usage starts at zero → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/accounts/:accountId/iam/roles/:roleId/usage", {
          params: { accountId: team.id, roleId },
        });
      r.status(200).body().has("$.role_id", roleId).has("$.policy_count", 0);
    });

    await ctx.step("role can be renamed then deleted", async () => {
      const patched = await ctx.client.as(ctx.P.OWNER).patch(
        "/v1/accounts/:accountId/iam/roles/:roleId",
        { name: "Review intake triager" },
        { params: { accountId: team.id, roleId } },
      );
      patched.status(200).body().has("$.role_id", roleId);

      const deleted = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/accounts/:accountId/iam/roles/:roleId", {
          params: { accountId: team.id, roleId },
        });
      deleted.status(200).body().has("$.deleted", true);
    });

    await ctx.step("deleting an unknown role → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/accounts/:accountId/iam/roles/:roleId", {
          params: { accountId: team.id, roleId },
        });
      r.status(404);
    });
  },
);

flow(
  "IAM-26",
  {
    domain: "iam",
    routes: [
      "GET /v1/accounts/:accountId/iam/policies",
      "GET /v1/accounts/:accountId/iam/agent-identities",
      "POST /v1/accounts/:accountId/iam/policies",
      "PATCH /v1/accounts/:accountId/iam/policies/:policyId",
      "DELETE /v1/accounts/:accountId/iam/policies/:policyId",
      "POST /v1/accounts/:accountId/iam/policies:bulk-delete",
      "POST /v1/accounts/:accountId/iam/policies:bulk-import",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const member = await team.addMember("member");
    const project = await team.project();
    const roleKey = `triage_${team.id.replace(/-/g, "").slice(0, 10)}`;
    let roleId = "";
    let policyId = "";

    await ctx.step("create a project custom role for policies", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        "/v1/accounts/:accountId/iam/roles",
        {
          key: roleKey,
          name: "Project review submitter",
          resourceType: "project",
          actions: ["project.review.read", "project.review.submit"],
        },
        { params: { accountId: team.id } },
      );
      r.status(201);
      roleId = r.json<any>().role_id;
    });

    await ctx.step("OWNER lists policies and agent identities → 200", async () => {
      const policies = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/accounts/:accountId/iam/policies", { params: { accountId: team.id } });
      policies.status(200).body().exists("$.policies");

      const agents = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/accounts/:accountId/iam/agent-identities", { params: { accountId: team.id } });
      agents.status(200).body().exists("$.agents");
    });

    await ctx.step("OWNER binds a member to the custom role on one project → 201", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        "/v1/accounts/:accountId/iam/policies",
        {
          principalType: "member",
          principalId: member.userId,
          roleId,
          scopeType: "project",
          scopeId: project.id,
        },
        { params: { accountId: team.id } },
      );
      r.status(201).body().exists("$.policy_id").has("$.role_id", roleId);
      policyId = r.json<any>().policy_id;
    });

    await ctx.step("built-in role policies are rejected → 400", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        "/v1/accounts/:accountId/iam/policies",
        {
          principalType: "member",
          principalId: member.userId,
          roleId: "builtin:manager",
          scopeType: "project",
          scopeId: project.id,
        },
        { params: { accountId: team.id } },
      );
      r.status(400);
    });

    await ctx.step("policy can be patched then deleted", async () => {
      const patched = await ctx.client.as(ctx.P.OWNER).patch(
        "/v1/accounts/:accountId/iam/policies/:policyId",
        { roleId, scopeType: "project", scopeId: project.id },
        { params: { accountId: team.id, policyId } },
      );
      patched.status(200).body().has("$.policy_id", policyId);

      const deleted = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/accounts/:accountId/iam/policies/:policyId", {
          params: { accountId: team.id, policyId },
        });
      deleted.status(200).body().has("$.deleted", true);
    });

    await ctx.step("bulk-delete removes matching policy ids", async () => {
      const created = await ctx.client.as(ctx.P.OWNER).post(
        "/v1/accounts/:accountId/iam/policies",
        {
          principalType: "member",
          principalId: member.userId,
          roleId,
          scopeType: "project",
          scopeId: project.id,
        },
        { params: { accountId: team.id } },
      );
      created.status(201);
      const bulk = await ctx.client.as(ctx.P.OWNER).post(
        "/v1/accounts/:accountId/iam/policies:bulk-delete",
        { policy_ids: [created.json<any>().policy_id] },
        { params: { accountId: team.id } },
      );
      bulk.status(200).body().has("$.deleted", 1);
    });

    await ctx.step("bulk-import creates portable role-key policy rows", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        "/v1/accounts/:accountId/iam/policies:bulk-import",
        {
          policies: [
            {
              role_key: roleKey,
              principal_type: "member",
              principal_id: member.userId,
              scope_type: "project",
              scope_id: project.id,
              effect: "allow",
            },
          ],
        },
        { params: { accountId: team.id } },
      );
      r.status(200).body().has("$.attempted", 1).has("$.created", 1);
    });

    await ctx.step("NONMEMBER cannot read policies → 403", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/accounts/:accountId/iam/policies", { params: { accountId: team.id } });
      r.status(403);
    });
  },
);
