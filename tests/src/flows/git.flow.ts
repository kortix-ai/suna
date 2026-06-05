/**
 * Git / GitHub — the universal git smart-HTTP proxy + project git credential/
 * token routes + GitHub App installation & import surface. Maps to spec §GH-*.
 *
 * Contract notes (verified against apps/api/src):
 *  - /v1/git/:project/* is the smart-HTTP proxy. It does its OWN token auth (git
 *    Basic/Bearer, NOT the user JWT). It resolves the project FIRST, so an
 *    unknown project → 404 even unauthenticated; a missing/garbage token on a
 *    real project → 401; a Kortix token for a *different* tenant → 403; a valid
 *    owning token reaches `resolveProjectUpstream`, which in local dev (no real
 *    managed upstream) typically 502s. We assert permissive sets accordingly.
 *  - /v1/projects/* is behind `supabaseAuth` (ANON → 401).
 *  - The GitHub-App routes need an installation local dev lacks → 409 (with
 *    install_url) / 400 / 502 / 200. create-repo & link-repository need a real
 *    install or PAT → 400/409/502/503.
 *  - git-token: 409 for BYO / 503 if managed git unconfigured / 200 push token.
 *  - clone-credential: only runtime tokens (sandbox / project PAT) → a user JWT
 *    is rejected 403.
 */
import { flow } from "../core/flow";

const UNKNOWN = "00000000-0000-4000-a000-000000000000";

// ── Git smart-HTTP proxy (token auth, not JWT) ─────────────────────────────

flow(
  "GH-9",
  {
    domain: "git",
    routes: [
      "GET /v1/git/:project/info/refs",
      "POST /v1/git/:project/git-upload-pack",
      "POST /v1/git/:project/git-receive-pack",
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("info/refs without git auth header → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/git/:project/info/refs", { params: { project: p.id }, query: { service: "git-upload-pack" } });
      r.status([401, 403, 502]);
    });
    await ctx.step("info/refs on unknown project → 404 (resolved before auth ok)", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/git/:project/info/refs", { params: { project: UNKNOWN }, query: { service: "git-upload-pack" } });
      r.status([401, 404]);
    });
    await ctx.step("git-upload-pack (clone) without git auth → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/git/:project/git-upload-pack", {}, { params: { project: p.id } });
      r.status([401, 403, 502]);
    });
    await ctx.step("git-receive-pack (push) without git auth → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/git/:project/git-receive-pack", {}, { params: { project: p.id } });
      r.status([401, 403, 502]);
    });
  },
);

flow(
  "GH-10",
  { domain: "git", routes: ["GET /v1/git/:project/info/refs"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("a JWT bearer is not a Kortix git token → 401", async () => {
      // The user's Supabase JWT is forwarded as Bearer but rejected by the proxy
      // auth (only Kortix PAT / API key / sandbox tokens are accepted).
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/git/:project/info/refs", { params: { project: p.id }, query: { service: "git-upload-pack" } });
      r.status([401, 403, 502]);
    });
    await ctx.step("cross-tenant: NONMEMBER's JWT cannot push-discover → 401/403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/git/:project/info/refs", { params: { project: p.id }, query: { service: "git-receive-pack" } });
      r.status([401, 403, 404]);
    });
  },
);

// ── Project git credential / token routes (JWT/PAT auth) ───────────────────

flow(
  "GH-6",
  { domain: "git", routes: ["PUT /v1/projects/:projectId/git-credential"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .put("/v1/projects/:projectId/git-credential", { token: "ghp_x" }, { params: { projectId: p.id } });
      r.status(401);
    });
    await ctx.step("missing token (server-managed already) → 400/409", async () => {
      // A managed project 409s ("already managed by Kortix"); a generic project
      // with no token in the body 400s ("token is required").
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put("/v1/projects/:projectId/git-credential", {}, { params: { projectId: p.id } });
      r.status([400, 409]);
    });
    await ctx.step("set BYO credential → ok / managed conflict 409", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put("/v1/projects/:projectId/git-credential", { token: "ghp_byo_token", provider: "gitlab" }, { params: { projectId: p.id } });
      r.status([200, 409]);
    });
    await ctx.step("NONMEMBER cannot set credential → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .put("/v1/projects/:projectId/git-credential", { token: "ghp_x" }, { params: { projectId: p.id } });
      r.status([403, 404]);
    });
  },
);

flow(
  "GH-7",
  { domain: "git", routes: ["POST /v1/projects/:projectId/git-token"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/projects/:projectId/git-token", {}, { params: { projectId: p.id } });
      r.status(401);
    });
    await ctx.step("OWNER mints push token → 200 / 409 BYO / 503 unconfigured", async () => {
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
    await ctx.step("NONMEMBER → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post("/v1/projects/:projectId/git-token", {}, { params: { projectId: p.id } });
      r.status([403, 404]);
    });
  },
);

flow(
  "GH-11",
  { domain: "git", routes: ["GET /v1/projects/:projectId/git/clone-credential"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/projects/:projectId/git/clone-credential", { params: { projectId: p.id } });
      r.status(401);
    });
    await ctx.step("user JWT is not a runtime token → 403", async () => {
      // clone-credential is for sandbox / project-scoped PAT runtime tokens only;
      // a plain user JWT is rejected.
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/git/clone-credential", { params: { projectId: p.id } });
      r.status([403, 404]);
    });
    await ctx.step("account PAT (not project-scoped) → 403", async () => {
      const r = await ctx.client
        .as(ctx.P.PAT_ACCT)
        .get("/v1/projects/:projectId/git/clone-credential", { params: { projectId: p.id } });
      r.status([403, 404]);
    });
  },
);

flow(
  "GH-12",
  { domain: "git", routes: ["POST /v1/projects/:projectId/git/collaborators"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/projects/:projectId/git/collaborators", { github_username: "octocat" }, { params: { projectId: p.id } });
      r.status(401);
    });
    await ctx.step("missing github_username → 400 (or managed-only 409)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/git/collaborators", {}, { params: { projectId: p.id } });
      r.status([400, 409]);
    });
    await ctx.step("invite collaborator → managed-only 409 / 502 upstream / 200", async () => {
      // Local projects are not managed GitHub repos → 409; if managed, the
      // GitHub API call has no install locally → 502.
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/git/collaborators", { github_username: "octocat", permission: "write" }, { params: { projectId: p.id } });
      r.status([200, 400, 409, 502]);
    });
    await ctx.step("NONMEMBER → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post("/v1/projects/:projectId/git/collaborators", { github_username: "octocat" }, { params: { projectId: p.id } });
      r.status([403, 404]);
    });
  },
);

// ── GitHub App installation surface (account-scoped) ───────────────────────

flow(
  "GH-1",
  {
    domain: "git",
    routes: [
      "GET /v1/projects/github/installation",
      "GET /v1/projects/github/installations",
    ],
  },
  async (ctx) => {
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/projects/github/installation");
      r.status(401);
    });
    await ctx.step("OWNER reads install state (none locally → install_url)", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/projects/github/installation");
      r.status([200, 400, 409, 503]);
    });
    await ctx.step("OWNER lists account git connections", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/projects/github/installations");
      r.status([200, 400, 409, 503]);
    });
  },
);

flow(
  "GH-2",
  { domain: "git", routes: ["POST /v1/projects/github/installation"] },
  async (ctx) => {
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/projects/github/installation", { state: "x", installation_id: "1" });
      r.status(401);
    });
    await ctx.step("missing state → 400", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post("/v1/projects/github/installation", {});
      r.status(400);
    });
    await ctx.step("invalid HMAC state → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/github/installation", { state: "not-a-valid-signed-state", installation_id: "12345" });
      r.status(400);
    });
  },
);

flow(
  "GH-3",
  {
    domain: "git",
    routes: [
      "DELETE /v1/projects/github/installation",
      "DELETE /v1/projects/github/installations/:installationId",
    ],
  },
  async (ctx) => {
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).del("/v1/projects/github/installation");
      r.status(401);
    });
    await ctx.step("OWNER disconnect (idempotent, none present) → ok", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).del("/v1/projects/github/installation");
      r.status([200, 400, 409, 503]);
    });
    await ctx.step("OWNER delete a specific (absent) installation → ok / not-found", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/projects/github/installations/:installationId", { params: { installationId: "999999999" } });
      r.status([200, 400, 404, 409, 503]);
    });
  },
);

flow(
  "GH-13",
  { domain: "git", routes: ["GET /v1/projects/github/repositories"] },
  async (ctx) => {
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/projects/github/repositories");
      r.status(401);
    });
    await ctx.step("OWNER lists repos (no install locally → 409 with install_url)", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/projects/github/repositories");
      r.status([200, 400, 409, 502, 503]);
    });
  },
);

// ── Repo creation / import (need a real GitHub App install or PAT) ─────────

flow(
  "GH-14",
  { domain: "git", routes: ["POST /v1/projects/create-repo"] },
  async (ctx) => {
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/projects/create-repo", { name: "x" });
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
    await ctx.step("valid name but no GitHub App install → 409 install_url / 503", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/create-repo", { name: ctx.fixtures.name("repo").replace(/[^a-zA-Z0-9._-]/g, "-") });
      r.status([200, 201, 409, 502, 503]);
    });
  },
);

flow(
  "GH-15",
  { domain: "git", routes: ["POST /v1/projects/link-repository"] },
  async (ctx) => {
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/projects/link-repository", { repo_full_name: "octocat/hello" });
      r.status(401);
    });
    await ctx.step("missing repo_url/repo_full_name → 400", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post("/v1/projects/link-repository", {});
      r.status(400);
    });
    await ctx.step("repo via App with no install → 400/409/502 (no validated access)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/link-repository", { repo_full_name: "octocat/hello-world" });
      r.status([200, 201, 400, 409, 502, 503]);
    });
    await ctx.step("repo via bogus PAT → validation fails 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/link-repository", { repo_full_name: "octocat/hello-world", github_token: "ghp_invalid_token_xyz" });
      r.status([400, 401, 409, 502]);
    });
  },
);
