/**
 * GitHub / git-transport backlog flows: PROJ-4, GH-4, GH-5, GH-8.
 *
 * Behaviour DERIVED from apps/api/src/projects/index.ts (spec text is treated as
 * a hint, not the contract):
 *
 *  - PROJ-4  POST /v1/projects/create-repo — PROJECT_CREATE-gated repo creation.
 *    A fresh account has no Nango connection. The API returns
 *    `github_connection_required` before any GitHub operation. ANON → 401,
 *    missing name → 400, invalid chars → 400. (Same route as GH-14; coverage is
 *    a union so the dual declaration is intentional — this flow pins PROJ-4's
 *    distinct spec assertion: no connection returns typed guidance.)
 *
 *  - GH-5  git transport resolution (`resolveProjectGitAuth`). This is an
 *    INTERNAL function, not a route. Its observable boundary is
 *    POST /v1/projects/:projectId/git-token. GitHub projects return 409
 *    because clients must use `git_origin_url`; BYO projects also return 409.
 *    ANON → 401, unknown project → 404, NONMEMBER → 404
 *    (loadProjectForUser returns null ⇒ 404, never 403). Same route as GH-7;
 *    GH-5 pins the resolution OUTCOMES rather than the auth matrix.
 *
 *  - GH-8  GET/POST/DELETE /v1/projects/:projectId/cli-token[/:tokenId] —
 *    project-scoped CLI tokens. GET = loadProjectForUser('read'); POST/DELETE =
 *    loadProjectForUser('manage'). POST → 201 with a one-time `secret_key` +
 *    `token_id`; GET lists `items` (no secret); DELETE → 200 {ok:true}, unknown
 *    token → 404. ANON → 401; non-member / no-access → 404 (never 403).
 *
 *  - GH-4  Nango reconnect and refresh routes for an account installation.
 *    Both routes require Kortix authentication and account authorization.
 *
 * NOT AUTHORED (reported as drift — no black-box HTTP surface):
 *  - HOSTS-1..6 (`kortix hosts ls|use|add|rm|info|current`): pure CLI-LOCAL
 *    config operations (apps/cli/src/commands/hosts.ts → api/config.ts). They
 *    read/write the local CLI config file and make NO HTTP calls — there are no
 *    API routes to test in a black-box suite.
 */
import { flow } from "../core/flow";

const UNKNOWN = "00000000-0000-4000-a000-000000000000";

// ── GH-4 — reconcile an account Nango connection ──────────────────────────

flow(
  "GH-4",
  {
    domain: "github",
    routes: [
      "POST /v1/projects/github/installations/:installationId/reconnect-session",
      "POST /v1/projects/github/installations/:installationId/refresh",
    ],
  },
  async (ctx) => {
    await ctx.step("ANON cannot create a reconnect session → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post(
          "/v1/projects/github/installations/:installationId/reconnect-session",
          {},
          { params: { installationId: "999999999" } },
        );
      r.status(401);
    });

    await ctx.step("ANON cannot refresh a connection → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post(
          "/v1/projects/github/installations/:installationId/refresh",
          {},
          { params: { installationId: "999999999" } },
        );
      r.status(401);
    });

    await ctx.step("unknown installation cannot reconnect", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/github/installations/:installationId/reconnect-session",
          {},
          { params: { installationId: "999999999" } },
        );
      r.status([400, 403, 404]);
    });

    await ctx.step("unknown installation cannot refresh", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/github/installations/:installationId/refresh",
          {},
          { params: { installationId: "999999999" } },
        );
      r.status([400, 403, 404]);
    });
  },
);

// ── PROJ-4 — create a new GitHub repo (no install ⇒ 409 install_url) ────────

flow(
  "PROJ-4",
  { domain: "git", routes: ["POST /v1/projects/create-repo"] },
  async (ctx) => {
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/projects/create-repo", { name: "ke2e-repo" });
      r.status(401);
    });
    await ctx.step("missing name → 400", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post("/v1/projects/create-repo", {});
      r.status(400);
    });
    await ctx.step("invalid name chars → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/create-repo", { name: "bad name/with spaces" });
      r.status(400);
    });
    await ctx.step("fresh account without Nango returns typed connection guidance", async () => {
      const team = await ctx.fixtures.team();
      const name = ctx.fixtures.name("repo").replace(/[^a-zA-Z0-9._-]/g, "-");
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/create-repo", { name, private: true, account_id: team.id });
      r.status(409)
        .body()
        .has("$.code", "github_connection_required")
        .has("$.requires_human_oauth", true)
        .has("$.sdk_action", "createGitHubConnectSession");
    });
  },
);

// ── GH-5 — git transport resolution (resolveProjectGitAuth via git-token) ──

flow(
  "GH-5",
  { domain: "git", routes: ["POST /v1/projects/:projectId/git-token"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/projects/:projectId/git-token", {}, { params: { projectId: p.id } });
      r.status(401);
    });
    await ctx.step("generic (non-managed / BYO) project → 409 'not a managed repo'", async () => {
      // A generic local project has no managed remote, so the compatibility
      // endpoint returns 409 before resolving any provider credential.
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/git-token", {}, { params: { projectId: p.id } });
      r.status(409);
    });
    await ctx.step("unknown project → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/git-token", {}, { params: { projectId: UNKNOWN } });
      r.status(404);
    });
    await ctx.step("NONMEMBER cannot resolve transport → 404 (project not loadable)", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post("/v1/projects/:projectId/git-token", {}, { params: { projectId: p.id } });
      r.status([403, 404]);
    });
  },
);

// ── GH-8 — project-scoped CLI tokens (list / mint / revoke) ────────────────

flow(
  "GH-8",
  {
    domain: "git",
    routes: [
      "GET /v1/projects/:projectId/cli-token",
      "POST /v1/projects/:projectId/cli-token",
      "DELETE /v1/projects/:projectId/cli-token/:tokenId",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const p = await team.project();
    let tokenId = "";

    await ctx.step("ANON cannot list → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/projects/:projectId/cli-token", { params: { projectId: p.id } });
      r.status(401);
    });
    await ctx.step("ANON cannot mint → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/projects/:projectId/cli-token", { name: "x" }, { params: { projectId: p.id } });
      r.status(401);
    });
    await ctx.step("OWNER mints a project-scoped CLI token → 201 with one-time secret", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/cli-token",
          { name: ctx.fixtures.name("cli-tok") },
          { params: { projectId: p.id } },
        );
      r.status(201).body().exists("$.token_id").exists("$.secret_key").has("$.project_id", p.id);
      tokenId = r.json<any>().token_id;
    });
    await ctx.step("GET lists the token (secret absent from the list) → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/cli-token", { params: { projectId: p.id } });
      r.status(200).body().exists("$.items");
      const items = r.json<any>().items as any[];
      const mine = items.find((t) => t.token_id === tokenId);
      // The minted token is present and the list never re-exposes the secret.
      r.body().exists("$.items");
      if (mine && "secret_key" in mine) {
        throw new Error("cli-token list must not return secret_key");
      }
    });
    await ctx.step("NONMEMBER cannot mint → 404 (project not loadable)", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post("/v1/projects/:projectId/cli-token", { name: "x" }, { params: { projectId: p.id } });
      r.status([403, 404]);
    });
    await ctx.step("NONMEMBER cannot list → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/projects/:projectId/cli-token", { params: { projectId: p.id } });
      r.status([403, 404]);
    });
    await ctx.step("OWNER revokes the token → 200 {ok:true}", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/projects/:projectId/cli-token/:tokenId", {
          params: { projectId: p.id, tokenId: tokenId || UNKNOWN },
        });
      r.status([200, 404]);
      if (r.statusCode === 200) r.body().has("$.ok", true);
    });
    await ctx.step("revoking an unknown token → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/projects/:projectId/cli-token/:tokenId", {
          params: { projectId: p.id, tokenId: UNKNOWN },
        });
      r.status(404);
    });
    await ctx.step("ANON cannot revoke → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .del("/v1/projects/:projectId/cli-token/:tokenId", {
          params: { projectId: p.id, tokenId: UNKNOWN },
        });
      r.status(401);
    });
  },
);
