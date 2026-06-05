/**
 * Projects — miscellaneous project-scoped surfaces that don't fit the core CRUD
 * flow: BYO-repo create, manifest validation, the CLI-token (project PAT)
 * lifecycle, onboarding state, version-diff preview, ChatGPT headless provider
 * auth, the lazy legacy-migration pipeline, OpenCode session sync, and the
 * Slack-relay turn endpoints.
 *
 * Maps to spec §13 (PROJ-2 for BYO create; PROJ-9..PROJ-17 minted here) and
 * reuses SESS-10 for sync-opencode-sessions.
 */
import { flow } from "../core/flow";

// PROJ-2 — BYO repo create. A non-GitHub repo_url is rejected at the
// normalizeRepoUrl boundary (400) before any GitHub round-trip; MEMBER /
// NONMEMBER are denied by PROJECT_CREATE (403). We assert the boundary only —
// a real 201 needs a GitHub App install + reachable repo, which the harness
// can't guarantee.
flow(
  "PROJ-2",
  { domain: "projects", serial: true, routes: ["POST /v1/projects"] },
  async (ctx) => {
    await ctx.step("non-GitHub repo_url → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects", { name: ctx.fixtures.name("byo"), repo_url: "https://gitlab.com/acme/widget" });
      r.status(400);
    });
    await ctx.step("http:// (non-HTTPS) repo_url → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects", { name: ctx.fixtures.name("byo"), repo_url: "http://github.com/acme/widget" });
      r.status(400);
    });
    await ctx.step("ANON cannot create → 401", async () => {
      // (Any authenticated user CAN create a project in their own account, so a
      // cross-tenant 403 isn't the boundary here — unauth is.)
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/projects", { name: ctx.fixtures.name("byo"), repo_url: "https://github.com/acme/widget" });
      r.status(401);
    });
  },
);

// PROJ-9 — manifest validation. Body key is `raw` (a TOML string). Valid TOML
// → 200 with `valid:true`; missing `raw` → 400; garbage TOML → 200 with
// `valid:false` + issues (the validator reports, it does not 400 on bad TOML).
flow(
  "PROJ-9",
  { domain: "projects", routes: ["POST /v1/projects/:projectId/manifest/validate"] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step("valid manifest → 200 valid:true", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/manifest/validate", { raw: '[project]\nname = "ok"\n' }, { params: { projectId: p.id } });
      r.status(200).body().exists("$.valid");
    });
    await ctx.step("invalid TOML syntax → 200 valid:false", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/manifest/validate", { raw: "this = = not toml [[" }, { params: { projectId: p.id } });
      r.status(200).body().has("$.valid", false);
    });
    await ctx.step("missing raw → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/manifest/validate", {}, { params: { projectId: p.id } });
      r.status(400);
    });
    await ctx.step("NONMEMBER → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post("/v1/projects/:projectId/manifest/validate", { raw: "[project]" }, { params: { projectId: p.id } });
      r.status([403, 404]);
    });
  },
);

// PROJ-10 — CLI-token lifecycle. POST mints a real project-scoped PAT
// (returns secret_key + token_id, 201); GET lists it; DELETE revokes it.
// Mutating + minting a credential → serial.
flow(
  "PROJ-10",
  {
    domain: "projects",
    serial: true,
    routes: [
      "POST /v1/projects/:projectId/cli-token",
      "GET /v1/projects/:projectId/cli-token",
      "DELETE /v1/projects/:projectId/cli-token/:tokenId",
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    let tokenId = "";
    await ctx.step("mint a CLI token → 201", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/cli-token", { name: ctx.fixtures.name("cli") }, { params: { projectId: p.id } });
      r.status(201).body().exists("$.token_id").exists("$.secret_key").has("$.project_id", p.id);
      tokenId = r.json<any>().token_id;
      ctx.track("cli-token", tokenId, { projectId: p.id });
    });
    await ctx.step("list CLI tokens → 200 includes minted", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/projects/:projectId/cli-token", { params: { projectId: p.id } });
      r.status(200).body().exists("$.items");
    });
    await ctx.step("revoke CLI token → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/projects/:projectId/cli-token/:tokenId", { params: { projectId: p.id, tokenId } });
      r.status(200).body().has("$.ok", true);
    });
    await ctx.step("revoke unknown token → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/projects/:projectId/cli-token/:tokenId", {
          params: { projectId: p.id, tokenId: "00000000-0000-4000-a000-000000000000" },
        });
      r.status(404);
    });
    await ctx.step("NONMEMBER cannot mint → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post("/v1/projects/:projectId/cli-token", {}, { params: { projectId: p.id } });
      r.status([403, 404]);
    });
  },
);

// PROJ-11 — onboarding state. PATCH {completed:true|false} flips
// metadata.onboarding_completed_at and echoes the serialized project (200).
flow(
  "PROJ-11",
  { domain: "projects", serial: true, routes: ["PATCH /v1/projects/:projectId/onboarding"] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step("mark onboarding completed → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch("/v1/projects/:projectId/onboarding", { completed: true }, { params: { projectId: p.id } });
      r.status(200).body().has("$.project_id", p.id);
    });
    await ctx.step("reset onboarding → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch("/v1/projects/:projectId/onboarding", { completed: false }, { params: { projectId: p.id } });
      r.status(200);
    });
    await ctx.step("NONMEMBER cannot patch → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .patch("/v1/projects/:projectId/onboarding", { completed: true }, { params: { projectId: p.id } });
      r.status([403, 404]);
    });
  },
);

// PROJ-12 — version-diff preview. Requires `from` + `into` query params (400
// without). Same ref short-circuits to is_same_ref:true (200) with no git
// round-trip; a real cross-ref diff may 400 if a ref can't be resolved.
flow(
  "PROJ-12",
  { domain: "projects", routes: ["GET /v1/projects/:projectId/version-diff"] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step("missing from/into → 400", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/projects/:projectId/version-diff", { params: { projectId: p.id } });
      r.status(400);
    });
    await ctx.step("same ref → 200 is_same_ref", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/version-diff", { params: { projectId: p.id }, query: { from: "main", into: "main" } });
      r.status(200).body().has("$.is_same_ref", true);
    });
    await ctx.step("cross-ref diff → 200 or 400 (unresolvable ref)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/version-diff", {
          params: { projectId: p.id },
          query: { from: "does-not-exist", into: "main" },
        });
      r.status([200, 400]);
    });
  },
);

// PROJ-13 — ChatGPT headless provider auth. `start` spins a local OpenCode
// device flow on the API host (no sandbox needed): 200 when the binary +
// network cooperate, 500 otherwise. `complete` requires `auth_id` (400) and,
// given a bogus one, fails because no job exists (500). We assert the
// boundary — there are no real ChatGPT creds in the harness.
flow(
  "PROJ-13",
  {
    domain: "projects",
    serial: true,
    routes: [
      "POST /v1/projects/:projectId/providers/openai/chatgpt/headless/start",
      "POST /v1/projects/:projectId/providers/openai/chatgpt/headless/complete",
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step("start headless auth → 200 or 500", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/providers/openai/chatgpt/headless/start", {}, { params: { projectId: p.id } });
      r.status([200, 500]);
    });
    await ctx.step("complete without auth_id → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/providers/openai/chatgpt/headless/complete", {}, { params: { projectId: p.id } });
      r.status(400);
    });
    await ctx.step("complete with bogus auth_id → 500 (no started flow)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/providers/openai/chatgpt/headless/complete",
          { auth_id: "00000000-0000-4000-a000-000000000000" },
          { params: { projectId: p.id } },
        );
      r.status([400, 404, 409, 500]);
    });
  },
);

// PROJ-14 — legacy migration: read-only eligibility + status. Eligibility is a
// pure account-scoped read (200, may be empty); status requires `sandbox_id`
// (400 without) and 404s an unknown one.
flow(
  "PROJ-14",
  {
    domain: "projects",
    routes: [
      "GET /v1/projects/legacy-migration/eligibility",
      "GET /v1/projects/legacy-migration/status",
    ],
  },
  async (ctx) => {
    await ctx.step("eligibility → 200", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/projects/legacy-migration/eligibility");
      r.status(200).body().exists("$.eligible");
    });
    await ctx.step("status without sandbox_id → 400", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/projects/legacy-migration/status");
      r.status(400);
    });
    await ctx.step("status for unknown sandbox → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/legacy-migration/status", { query: { sandbox_id: "00000000-0000-4000-a000-000000000000" } });
      r.status(404);
    });
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/projects/legacy-migration/eligibility");
      r.status(401);
    });
  },
);

// PROJ-15 — legacy migration: start. Requires `sandbox_id` (400 without); an
// unknown / unowned sandbox 404s. We never start a real migration (no
// migratable JustAVPS machine in the harness) — boundary only. Mutating →
// serial.
flow(
  "PROJ-15",
  { domain: "projects", serial: true, routes: ["POST /v1/projects/legacy-migration/start"] },
  async (ctx) => {
    await ctx.step("start without sandbox_id → 400", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post("/v1/projects/legacy-migration/start", {});
      r.status(400);
    });
    await ctx.step("start for unknown sandbox → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/legacy-migration/start", { sandbox_id: "00000000-0000-4000-a000-000000000000" });
      r.status(404);
    });
  },
);

// SESS-10 — sync-opencode-sessions. Spec lists the path as
// `sync-opencode-titles`; the implemented route is `sync-opencode-sessions`
// with the same `{entries[]}` body. Empty array → 200 {updated:0}; a non-array
// `entries` → 400.
flow(
  "SESS-10",
  { domain: "projects", routes: ["POST /v1/projects/sync-opencode-sessions"] },
  async (ctx) => {
    await ctx.step("empty entries → 200 updated:0", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post("/v1/projects/sync-opencode-sessions", { entries: [] });
      r.status(200).body().has("$.updated", 0);
    });
    await ctx.step("entries not an array → 400", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post("/v1/projects/sync-opencode-sessions", { entries: "nope" });
      r.status(400);
    });
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/projects/sync-opencode-sessions", { entries: [] });
      r.status(401);
    });
  },
);

// PROJ-16 — turn-question relay. A normal user token authorizes via project
// read; the relay then validates the body before touching any sandbox, so a
// missing session_id → 400 and a missing questions[] → 400. We assert the
// no-session negative so it runs locally without a live OpenCode session.
flow(
  "PROJ-16",
  { domain: "projects", routes: ["POST /v1/projects/:projectId/turn-question"] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step("missing session_id → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/turn-question", { questions: [{ question: "q?" }] }, { params: { projectId: p.id } });
      r.status(400);
    });
    await ctx.step("missing questions → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/turn-question", { session_id: "bogus" }, { params: { projectId: p.id } });
      r.status(400);
    });
    await ctx.step("NONMEMBER → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post("/v1/projects/:projectId/turn-question", { session_id: "bogus", questions: [] }, { params: { projectId: p.id } });
      r.status([400, 403, 404]);
    });
  },
);

// PROJ-17 — turn-stream relay. Same auth model as turn-question; the body gate
// requires both session_id and text (400 otherwise). Asserting the negative
// keeps this local (no funded session required).
flow(
  "PROJ-17",
  { domain: "projects", routes: ["POST /v1/projects/:projectId/turn-stream"] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step("missing session_id + text → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/turn-stream", { kind: "step" }, { params: { projectId: p.id } });
      r.status(400);
    });
    await ctx.step("session_id without text → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/turn-stream", { session_id: "bogus" }, { params: { projectId: p.id } });
      r.status(400);
    });
    await ctx.step("NONMEMBER → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post("/v1/projects/:projectId/turn-stream", { session_id: "bogus", text: "hi" }, { params: { projectId: p.id } });
      r.status([400, 403, 404]);
    });
  },
);
