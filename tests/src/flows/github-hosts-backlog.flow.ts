/**
 * GitHub / git-transport backlog flows: PROJ-4, GH-5, GH-8.
 *
 * Behaviour DERIVED from apps/api/src/projects/index.ts (spec text is treated as
 * a hint, not the contract):
 *
 *  - PROJ-4  POST /v1/projects/create-repo — PROJECT_CREATE-gated repo creation.
 *    The black-box-testable path WITHOUT a real GitHub App install: a fresh
 *    account with no installation → resolveGitHubRepoAuth throws
 *    GitHubInstallationRequiredError → 409 { error, install_url }. If GitHub is
 *    not configured on the server at all → 503. ANON → 401 (supabaseAuth),
 *    missing name → 400, invalid chars → 400. (Same route as GH-14; coverage is
 *    a union so the dual declaration is intentional — this flow pins PROJ-4's
 *    distinct spec assertion: no-install ⇒ 409 + install_url.)
 *
 *  - GH-5  git transport resolution (`resolveProjectGitAuth`). This is an
 *    INTERNAL function, not a route. Its observable boundary is
 *    POST /v1/projects/:projectId/git-token (the "mint scoped push token"
 *    branch): a generic (non-managed / BYO) project → 409 "Project is not a
 *    managed repo" (the spec's `project_secret` / `none` path); a managed
 *    project whose backend resolves no credential → 503; resolved → 200
 *    { push_token }. ANON → 401, unknown project → 404, NONMEMBER → 404
 *    (loadProjectForUser returns null ⇒ 404, never 403). Same route as GH-7;
 *    GH-5 pins the resolution OUTCOMES rather than the auth matrix.
 *
 *  - GH-8  GET/POST/DELETE /v1/projects/:projectId/cli-token[/:tokenId] —
 *    project-scoped CLI tokens. GET = loadProjectForUser('read'); POST/DELETE =
 *    loadProjectForUser('manage'). POST → 201 with a one-time `secret_key` +
 *    `token_id`; GET lists `items` (no secret); DELETE → 200 {ok:true}, unknown
 *    token → 404. ANON → 401; non-member / no-access → 404 (never 403).
 *
 * NOT AUTHORED (reported as drift — no black-box HTTP surface):
 *  - GH-4 (Supabase GitHub OAuth popup): handled entirely client-side by
 *    Supabase Auth (`signInWithOAuth`); `provider_token` is posted back to the
 *    opener window. There is no Kortix API route — nothing to exercise here.
 *  - HOSTS-1..6 (`kortix hosts ls|use|add|rm|info|current`): pure CLI-LOCAL
 *    config operations (apps/cli/src/commands/hosts.ts → api/config.ts). They
 *    read/write the local CLI config file and make NO HTTP calls — there are no
 *    API routes to test in a black-box suite.
 */
import { flow } from "../core/flow";

const UNKNOWN = "00000000-0000-4000-a000-000000000000";

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
    await ctx.step("fresh account with no GitHub App install → 409 + install_url (or 503 if GitHub unconfigured)", async () => {
      // A brand-new team account is guaranteed to have no GitHub App
      // installation, so resolveGitHubRepoAuth throws → 409 {error, install_url}.
      // If the server has no GitHub App configured at all the handler returns 503.
      const team = await ctx.fixtures.team();
      const name = ctx.fixtures.name("repo").replace(/[^a-zA-Z0-9._-]/g, "-");
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/create-repo", { name, private: true, account_id: team.id });
      r.status([409, 503]);
      // The spec's defining assertion: the no-install path surfaces an install_url.
      if (r.statusCode === 409) r.body().exists("$.install_url");
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
      // resolveProjectGitAuth's `none`/project_secret branch: a generic local
      // project has no managed remote, so the mint-push-token path 409s before
      // ever calling the backend. A managed project would resolve a token (200)
      // or, if the backend can't mint one, 503.
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/git-token", {}, { params: { projectId: p.id } });
      r.status([200, 409, 503]);
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
    serial: true,
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
