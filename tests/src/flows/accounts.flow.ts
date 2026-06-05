/**
 * Accounts & identity — authenticated. Maps to spec §4 (ME-*, ACCT-*, MEM-*, TOK-*).
 * Needs OWNER + NONMEMBER principals (provisioned per run).
 */
import { flow } from "../core/flow";

flow("ME-1", { domain: "accounts", tags: ["smoke"], routes: ["GET /v1/accounts/me"] }, async (ctx) => {
  await ctx.step("OWNER sees own identity", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/accounts/me");
    r.status(200).body().exists("$.user_id").exists("$.email");
  });
  await ctx.step("ANON → 401", async () => {
    const r = await ctx.client.as(ctx.P.ANON).get("/v1/accounts/me");
    r.status(401);
  });
});

flow("ACCT-1", { domain: "accounts", routes: ["GET /v1/accounts"] }, async (ctx) => {
  await ctx.step("list memberships", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/accounts");
    r.status(200);
  });
});

flow(
  "ACCT-2",
  { domain: "accounts", routes: ["POST /v1/accounts", "GET /v1/accounts/:accountId"], serial: true },
  async (ctx) => {
    let accountId = "";
    await ctx.step("create team account → caller is owner", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post("/v1/accounts", { name: ctx.fixtures.name("team") });
      r.status(201).body().has("$.personal_account", false).has("$.account_role", "owner");
      accountId = r.json<any>().account_id;
      ctx.track("account", accountId);
    });
    await ctx.step("owner can read it", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/accounts/:accountId", { params: { accountId } });
      r.status(200).body().has("$.account_id", accountId);
    });
    await ctx.step("NONMEMBER cannot read it → 403", async () => {
      const r = await ctx.client.as(ctx.P.NONMEMBER).get("/v1/accounts/:accountId", { params: { accountId } });
      r.status(403);
    });
  },
);

flow(
  "TOK-1",
  { domain: "accounts", routes: ["POST /v1/accounts/tokens", "GET /v1/accounts/tokens", "DELETE /v1/accounts/tokens/:tokenId"], serial: true },
  async (ctx) => {
    let tokenId = "";
    await ctx.step("mint PAT → secret returned once", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post("/v1/accounts/tokens", { name: ctx.fixtures.name("tok") });
      r.status(201).body().exists("$.secret_key").exists("$.token_id");
      tokenId = r.json<any>().token_id;
    });
    await ctx.step("list does not expose the secret", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/accounts/tokens");
      r.status(200);
    });
    await ctx.step("revoke it", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).del("/v1/accounts/tokens/:tokenId", { params: { tokenId } });
      r.status(200).body().has("$.ok", true);
    });
  },
);

flow("TOK-2", { domain: "accounts", routes: ["POST /v1/accounts/tokens"] }, async (ctx) => {
  await ctx.step("missing name → 400", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).post("/v1/accounts/tokens", {});
    r.status(400);
  });
});

flow("ACCT-4", { domain: "accounts", serial: true, routes: ["PATCH /v1/accounts/:accountId"] }, async (ctx) => {
  const team = await ctx.fixtures.team();
  await ctx.step("OWNER renames account", async () => {
    const r = await ctx.client
      .as(ctx.P.OWNER)
      .patch("/v1/accounts/:accountId", { name: ctx.fixtures.name("renamed") }, { params: { accountId: team.id } });
    r.status(200);
  });
  await ctx.step("MEMBER cannot rename → 403", async () => {
    const member = await team.addMember("member");
    const r = await ctx.client
      .as(member)
      .patch("/v1/accounts/:accountId", { name: "nope" }, { params: { accountId: team.id } });
    r.status(403);
  });
});

flow("ACCT-5", { domain: "accounts", serial: true, routes: ["GET /v1/accounts/:accountId/audit"] }, async (ctx) => {
  const team = await ctx.fixtures.team();
  await ctx.step("member reads audit log", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/accounts/:accountId/audit", { params: { accountId: team.id } });
    r.status(200);
  });
});

flow(
  "MEM-1",
  { domain: "accounts", serial: true, routes: ["GET /v1/accounts/:accountId/members", "POST /v1/accounts/:accountId/members"] },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    await ctx.step("add an admin member → 201 status added", async () => {
      await team.addMember("admin");
    });
    await ctx.step("list members → owner + admin present", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/accounts/:accountId/members", { params: { accountId: team.id } });
      r.status(200);
    });
    await ctx.step("NONMEMBER cannot list → 403", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/accounts/:accountId/members", { params: { accountId: team.id } });
      r.status(403);
    });
  },
);

flow(
  "MEM-2",
  { domain: "accounts", serial: true, routes: ["POST /v1/accounts/:accountId/members"] },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const member = await team.addMember("member");
    await ctx.step("inviting an existing member again → 409", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/accounts/:accountId/members", { email: member.email, role: "member" }, { params: { accountId: team.id } });
      r.status(409);
    });
    await ctx.step("MEMBER cannot invite → 403", async () => {
      const r = await ctx.client
        .as(member)
        .post("/v1/accounts/:accountId/members", { email: "x@ke2e.kortix.test", role: "member" }, { params: { accountId: team.id } });
      r.status(403);
    });
  },
);

flow(
  "MEM-3",
  { domain: "accounts", serial: true, routes: ["PATCH /v1/accounts/:accountId/members/:userId"] },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const member = await team.addMember("member");
    await ctx.step("OWNER promotes member → admin", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch("/v1/accounts/:accountId/members/:userId", { role: "admin" }, { params: { accountId: team.id, userId: member.userId! } });
      r.status(200);
    });
    await ctx.step("invalid role → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch("/v1/accounts/:accountId/members/:userId", { role: "wizard" }, { params: { accountId: team.id, userId: member.userId! } });
      r.status(400);
    });
  },
);

flow(
  "MEM-4",
  { domain: "accounts", serial: true, routes: ["DELETE /v1/accounts/:accountId/members/:userId"] },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const member = await team.addMember("member");
    await ctx.step("OWNER removes member → ok", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/accounts/:accountId/members/:userId", { params: { accountId: team.id, userId: member.userId! } });
      r.status(200).body().has("$.ok", true);
    });
  },
);

flow(
  "MEM-5",
  { domain: "accounts", serial: true, routes: ["POST /v1/accounts/:accountId/leave"] },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const member = await team.addMember("member");
    await ctx.step("member leaves → ok", async () => {
      const r = await ctx.client.as(member).post("/v1/accounts/:accountId/leave", {}, { params: { accountId: team.id } });
      r.status(200);
    });
    await ctx.step("non-member leave → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post("/v1/accounts/:accountId/leave", {}, { params: { accountId: team.id } });
      r.status(404);
    });
  },
);

flow("INV-1", { domain: "accounts", serial: true, routes: ["GET /v1/accounts/:accountId/invites"] }, async (ctx) => {
  const team = await ctx.fixtures.team();
  await ctx.step("list pending invites", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/accounts/:accountId/invites", { params: { accountId: team.id } });
    r.status(200);
  });
});

flow("DEL-1", { domain: "accounts", routes: ["GET /v1/account/deletion-status"] }, async (ctx) => {
  await ctx.step("OWNER reads deletion status", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/account/deletion-status");
    r.status(200);
  });
});

// ACCT-3 — GET a single account: a member reads it (200, with role + counts);
// a NONMEMBER is forbidden (403).
flow(
  "ACCT-3",
  { domain: "accounts", serial: true, routes: ["GET /v1/accounts/:accountId"] },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    await ctx.step("OWNER (member) reads the account → 200", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/accounts/:accountId", { params: { accountId: team.id } });
      r.status(200).body().has("$.account_id", team.id).exists("$.role").exists("$.member_count");
    });
    await ctx.step("NONMEMBER → 403", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/accounts/:accountId", { params: { accountId: team.id } });
      r.status(403);
    });
  },
);

// TOK-3 — account-PAT revoke semantics: revoke → 200; unknown/already-revoked
// → 404; a revoked secret used on any route → 401.
flow(
  "TOK-3",
  {
    domain: "accounts",
    serial: true,
    routes: ["POST /v1/accounts/tokens", "DELETE /v1/accounts/tokens/:tokenId", "GET /v1/accounts/me"],
  },
  async (ctx) => {
    let tokenId = "";
    let secret = "";
    await ctx.step("mint an account PAT", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post("/v1/accounts/tokens", { name: ctx.fixtures.name("revoke") });
      r.status(201).body().exists("$.secret_key").exists("$.token_id");
      const j = r.json<any>();
      tokenId = j.token_id;
      secret = j.secret_key;
    });
    await ctx.step("secret authenticates before revoke → 200", async () => {
      const r = await ctx.client.withBearer(secret).get("/v1/accounts/me");
      r.status(200);
    });
    await ctx.step("revoke → 200 {ok:true}", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).del("/v1/accounts/tokens/:tokenId", { params: { tokenId } });
      r.status(200).body().has("$.ok", true);
    });
    await ctx.step("revoke again (already revoked) → 404", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).del("/v1/accounts/tokens/:tokenId", { params: { tokenId } });
      r.status(404);
    });
    await ctx.step("revoke an unknown id → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/accounts/tokens/:tokenId", { params: { tokenId: "00000000-0000-0000-0000-000000000000" } });
      r.status(404);
    });
    await ctx.step("revoked secret on any route → 401", async () => {
      const r = await ctx.client.withBearer(secret).get("/v1/accounts/me");
      r.status(401);
    });
  },
);

// TOK-4 — project-scoped PAT (enforceTokenProjectScope): allowed only on its
// own project + the `/accounts/me` self-identity probe; every other surface
// (a different project, project-list, account-level routes) → 403.
flow(
  "TOK-4",
  {
    domain: "accounts",
    serial: true,
    routes: [
      "POST /v1/projects/:projectId/cli-token",
      "DELETE /v1/projects/:projectId/cli-token/:tokenId",
      "GET /v1/projects/:projectId",
      "GET /v1/projects/:projectId/secrets",
      "GET /v1/projects",
      "GET /v1/accounts/me",
      "GET /v1/accounts/tokens",
    ],
  },
  async (ctx) => {
    const projA = await ctx.fixtures.project();
    const projB = await ctx.fixtures.project();
    let secret = "";
    let tokenId = "";
    await ctx.step("mint a project-scoped PAT on project A", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/cli-token", { name: ctx.fixtures.name("proj-pat") }, { params: { projectId: projA.id } });
      r.status(201).body().exists("$.secret_key").has("$.project_id", projA.id);
      const j = r.json<any>();
      secret = j.secret_key;
      tokenId = j.token_id;
    });
    const pat = () => ctx.client.withBearer(secret, "PAT_PROJ");
    await ctx.step("allowed: GET its own project → 200", async () => {
      const r = await pat().get("/v1/projects/:projectId", { params: { projectId: projA.id } });
      r.status(200);
    });
    await ctx.step("allowed: GET its own project's secrets → 200", async () => {
      const r = await pat().get("/v1/projects/:projectId/secrets", { params: { projectId: projA.id } });
      r.status(200);
    });
    await ctx.step("allowed: self-identity probe /accounts/me → 200", async () => {
      const r = await pat().get("/v1/accounts/me");
      r.status(200);
    });
    await ctx.step("denied: a different project → 403", async () => {
      const r = await pat().get("/v1/projects/:projectId", { params: { projectId: projB.id } });
      r.status(403);
    });
    await ctx.step("denied: enumerate projects → 403", async () => {
      const r = await pat().get("/v1/projects");
      r.status(403);
    });
    await ctx.step("denied: account-level route → 403", async () => {
      const r = await pat().get("/v1/accounts/tokens");
      r.status(403);
    });
    await ctx.step("revoke the project token → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/projects/:projectId/cli-token/:tokenId", { params: { projectId: projA.id, tokenId } });
      r.status(200).body().has("$.ok", true);
    });
  },
);
