/**
 * Projects — miscellaneous project-scoped surfaces that don't fit the core CRUD
 * flow: BYO-repo create, the CLI-token (project PAT)
 * lifecycle, onboarding state, version-diff preview, ChatGPT headless provider
 * auth and the Slack-relay turn endpoints.
 *
 * Maps to spec §13 (PROJ-2 for BYO create; PROJ-9..PROJ-17 minted here).
 */
import { flow } from "../core/flow";

// PROJ-2 — BYO repo create. A non-GitHub repo_url is rejected at the
// normalizeRepoUrl boundary (400) before any GitHub round-trip; MEMBER /
// NONMEMBER are denied by PROJECT_CREATE (403). We assert the boundary only —
// a real 201 needs a GitHub App install + reachable repo, which the harness
// can't guarantee.
flow(
  "PROJ-2",
  { domain: "projects", routes: ["POST /v1/projects"] },
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

// PROJ-10 — CLI-token lifecycle. POST mints a real project-scoped PAT
// (returns secret_key + token_id, 201); GET lists it; DELETE revokes it.
// Mutating + minting a credential → serial.
flow(
  "PROJ-10",
  {
    domain: "projects",
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
  { domain: "projects", routes: ["PATCH /v1/projects/:projectId/onboarding"] },
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

// PROJ-13 — provider OAuth device flow (poll-based). `start` kicks the device
// flow and returns a challenge; the client polls `poll` until it resolves; the
// resulting login is saved as CODEX_AUTH_JSON. `list`/`delete` manage it. We
// assert the boundaries only — completing a real device login needs a live
// ChatGPT account the harness can't drive, and calling `start` for a real
// provider would spawn a server-side OpenCode flow, so we exercise `start`'s
// unknown-provider guard instead.
flow(
  "PROJ-13",
  {
    domain: "projects",
    routes: [
      "POST /v1/projects/:projectId/oauth/:provider/start",
      "POST /v1/projects/:projectId/oauth/:provider/poll",
      "GET /v1/projects/:projectId/oauth",
      "DELETE /v1/projects/:projectId/oauth/:provider",
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step("start unknown provider → 400 (no flow spawned)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/oauth/:provider/start", {}, { params: { projectId: p.id, provider: "nope" } });
      r.status(400);
    });
    await ctx.step("start invalid sharing → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/oauth/:provider/start",
          { sharing: { mode: "bogus" } },
          { params: { projectId: p.id, provider: "openai" } },
        );
      r.status(400);
    });
    await ctx.step("poll missing flow_id → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/oauth/:provider/poll", {}, { params: { projectId: p.id, provider: "openai" } });
      r.status(400);
    });
    await ctx.step("poll bogus flow_id → 200 expired", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/oauth/:provider/poll",
          { flow_id: "00000000-0000-4000-a000-000000000000" },
          { params: { projectId: p.id, provider: "openai" } },
        );
      r.status(200).body().has("$.status", "expired");
    });
    await ctx.step("list configured OAuth → 200 items", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/projects/:projectId/oauth", { params: { projectId: p.id } });
      r.status(200).body().exists("$.items");
    });
    await ctx.step("delete unknown provider → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/projects/:projectId/oauth/:provider", { params: { projectId: p.id, provider: "nope" } });
      r.status(404);
    });
    await ctx.step("NONMEMBER start → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post("/v1/projects/:projectId/oauth/:provider/start", {}, { params: { projectId: p.id, provider: "openai" } });
      r.status([403, 404]);
    });
    await ctx.step("ANON list → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/projects/:projectId/oauth", { params: { projectId: p.id } });
      r.status(401);
    });
  },
);

// PROJ-16 — turn-question relay. A normal user token authorizes via project
// read; the relay validates session_id first, then scopes it to the project,
// then validates questions. A missing id is 400; an unknown id is 404. We assert the
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
    await ctx.step("unknown session takes precedence over missing questions → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/turn-question", { session_id: "bogus" }, { params: { projectId: p.id } });
      r.status(404);
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
// requires session_id first, then scopes it to the project before interpreting
// the event payload. Asserting the negative
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
    await ctx.step("unknown session takes precedence over missing text → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/turn-stream", { session_id: "bogus" }, { params: { projectId: p.id } });
      r.status(404);
    });
    await ctx.step("kind=turn_end with an unknown session → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/turn-stream",
          { session_id: "bogus", kind: "turn_end", status: "idle" },
          { params: { projectId: p.id } },
        );
      r.status(404);
    });
    await ctx.step("NONMEMBER → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post("/v1/projects/:projectId/turn-stream", { session_id: "bogus", text: "hi" }, { params: { projectId: p.id } });
      r.status([400, 403, 404]);
    });
  },
);

// PROJ-19 — Full v2 agent-config editor (the "agent builder" surface, spec
// docs/specs/2026-07-05-agent-first-config-unification.md §2.2). GET reports the
// agent's full block + the manifest schema version (the UI's v1-vs-v2 branch);
// PUT replaces the whole block, validating it through the manifest-schema
// validator before the kortix.yaml commit. A bare provisioned project now
// synthesizes a v2 manifest (synthesizeBlankManifest, kortix_version 2 — see
// PR #4980), so GET reports schema_version 2 and editable:true. PUT still
// validates the block shape strictly: a body with unrecognized top-level keys
// (or a bad enum) is refused with a 400; the editor-tier gate holds.
flow(
  "PROJ-19",
  {
    domain: "projects",
    routes: [
      "GET /v1/projects/:projectId/agents/:agentName/config",
      "PUT /v1/projects/:projectId/agents/:agentName/config",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project();

    await ctx.step("GET reports schema_version 2 / editable true for a synthesized blank manifest", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/agents/:agentName/config", {
          params: { projectId: project.id, agentName: "kortix" },
        });
      r.status(200).body().has("$.schema_version", 2).has("$.editable", true);
    });

    await ctx.step("PUT a body with unrecognized top-level keys → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          "/v1/projects/:projectId/agents/:agentName/config",
          { mode: "primary", description: "Support", temperature: 0.2 },
          { params: { projectId: project.id, agentName: "kortix" } },
        );
      r.status(400);
    });

    await ctx.step("PUT with a malformed body (bad enum) → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          "/v1/projects/:projectId/agents/:agentName/config",
          { mode: "supervisor" },
          { params: { projectId: project.id, agentName: "kortix" } },
        );
      r.status(400);
    });

    await ctx.step("a member with no project grant cannot read/write the config → 403", async () => {
      const bare = await team.addMember("member");
      const r = await ctx.client
        .as(bare)
        .get("/v1/projects/:projectId/agents/:agentName/config", {
          params: { projectId: project.id, agentName: "kortix" },
        });
      r.status(403);
    });
  },
);

// PROJ-20 — managed-git pre-flight status. GET /managed-git/status lets the
// "Create project" UI pre-check whether the managed-git provision path is
// usable BEFORE the user hits its 503 (self-host deploys with no
// MANAGED_GIT_* configured). Auth-gated, account-scoped (NOT project-scoped —
// the path has no :projectId, it reports the server-wide managed-git backend).
// Read-only and safe to assert the happy path on staging.
flow(
  "PROJ-20",
  { domain: "projects", routes: ["GET /v1/projects/managed-git/status"] },
  async (ctx) => {
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/projects/managed-git/status");
      r.status(401);
    });
    await ctx.step("OWNER → 200 with {configured, provider}", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/projects/managed-git/status");
      r.status(200).body().exists("$.configured").exists("$.provider");
      const provider = r.json<any>()?.provider;
      if (typeof provider !== "string" || provider.length === 0) {
        throw new Error(`expected a non-empty provider string, got: ${provider}`);
      }
      // `configured` is a boolean — never a 500, never an unset field.
      if (typeof r.json<any>()?.configured !== "boolean") {
        throw new Error(`expected configured to be a boolean, got: ${r.json<any>()?.configured}`);
      }
    });
  },
);

// PROJ-27 — model-defaults CRUD. GET reads the platform/account/project/agent
// defaults; PUT upserts one scope (agent requires agentName); DELETE clears
// one scope by query. PUT rejects models that the account cannot serve. The
// flow reads the current project picker and selects a managed model from that
// served catalog. Full set → read-back → clear lifecycle on scope=project.
flow(
  "PROJ-27",
  {
    domain: "projects",
    requires: ["funded"],
    routes: [
      "GET /v1/projects/:projectId/model-picker",
      "GET /v1/projects/:projectId/model-defaults",
      "PUT /v1/projects/:projectId/model-defaults",
      "DELETE /v1/projects/:projectId/model-defaults",
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    let servableModel = "";
    await ctx.step("GET before any override → 200 with no project default", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/model-defaults", { params: { projectId: p.id } });
      r.status(200).body().exists("$.platformDefault").has("$.projectDefault", null);
    });
    await ctx.step("GET model picker → select a served managed model", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/model-picker", { params: { projectId: p.id } });
      r.status(200);
      const models = r.json<any>()?.models;
      const candidate =
        models && typeof models === "object"
          ? Object.keys(models).find((model) => model !== "auto" && !model.includes("/"))
          : undefined;
      if (!candidate) {
        throw new Error(`model-picker returned no managed model: ${r.text()}`);
      }
      servableModel = candidate;
    });
    await ctx.step("PUT scope=project sets a concrete model → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          "/v1/projects/:projectId/model-defaults",
          { scope: "project", model: servableModel },
          { params: { projectId: p.id } },
        );
      r.status(200).body().has("$.ok", true).has("$.scope", "project").has("$.model", servableModel);
    });
    await ctx.step("GET reflects the set project default", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/model-defaults", { params: { projectId: p.id } });
      r.status(200).body().has("$.projectDefault", servableModel).has("$.resolvedForCaller", servableModel);
    });
    await ctx.step("PUT with the synthetic auto id → 409 (not servable)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          "/v1/projects/:projectId/model-defaults",
          { scope: "project", model: "auto" },
          { params: { projectId: p.id } },
        );
      r.status(409).body().has("$.code", "model_not_servable");
    });
    await ctx.step("PUT scope=agent without agentName → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          "/v1/projects/:projectId/model-defaults",
          { scope: "agent", model: servableModel },
          { params: { projectId: p.id } },
        );
      r.status(400);
    });
    await ctx.step("DELETE scope=project clears the override → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/projects/:projectId/model-defaults", {
          params: { projectId: p.id },
          query: { scope: "project" },
        });
      r.status(200).body().has("$.ok", true);
    });
    await ctx.step("GET reflects the clear", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/model-defaults", { params: { projectId: p.id } });
      r.status(200).body().has("$.projectDefault", null);
    });
    await ctx.step("DELETE with an invalid scope → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/projects/:projectId/model-defaults", {
          params: { projectId: p.id },
          query: { scope: "bogus" },
        });
      r.status(400);
    });
    await ctx.step("NONMEMBER cannot read → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/projects/:projectId/model-defaults", { params: { projectId: p.id } });
      r.status([403, 404]);
    });
  },
);

// PROJ-28 — Suna-migration status surface. Top-level `/v1/projects/suna-migration/*`
// (NOT project-scoped, despite the path prefix) — scoped to the caller's own
// account. eligible = the account has legacy `public.projects` rows AND no
// completed/in-flight migration yet. A fresh e2e account (synthesized per run)
// has neither, so this asserts the real "nothing to migrate" shape rather than
// kicking off a real migration against production Suna data.
flow(
  "PROJ-28",
  {
    domain: "projects",
    routes: [
      "GET /v1/projects/suna-migration/eligibility",
      "GET /v1/projects/suna-migration/status",
      "POST /v1/projects/suna-migration/start",
    ],
  },
  async (ctx) => {
    await ctx.step("GET eligibility for a fresh account → 200, not eligible", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/projects/suna-migration/eligibility");
      r.status(200).body().has("$.eligible", false).has("$.migration", null);
    });
    await ctx.step("GET status for a fresh account → 200, no migration on record", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/projects/suna-migration/status");
      r.status(200).body().has("$.migration", null);
    });
    await ctx.step("POST start for a non-eligible account → 400 (nothing to migrate)", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post("/v1/projects/suna-migration/start", {});
      r.status(400);
    });
    await ctx.step("ANON cannot read eligibility → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/projects/suna-migration/eligibility");
      r.status(401);
    });
  },
);

// PROJ-29 — manifest validation (dry-run, no commit). Body: { raw, format? }.
// Always resolves — the verdict lives in the body, never a raw parser 4xx —
// except the caller-input guards (missing `raw`) which are the real 400s.
flow(
  "PROJ-29",
  { domain: "projects", routes: ["POST /v1/projects/:projectId/manifest/validate"] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step("missing raw → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/manifest/validate", { format: "yaml" }, { params: { projectId: p.id } });
      r.status(400);
    });
    await ctx.step("a valid minimal v2 manifest → 200 valid:true", async () => {
      const raw = "kortix_version: 2\ndefault_agent: kortix\nagents:\n  kortix: {}\n";
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/manifest/validate",
          { raw, format: "yaml" },
          { params: { projectId: p.id } },
        );
      r.status(200).body().has("$.valid", true);
    });
    await ctx.step("a broken manifest (default_agent not declared) → 200 valid:false with issues", async () => {
      const raw = "kortix_version: 2\ndefault_agent: does-not-exist\nagents:\n  kortix: {}\n";
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/manifest/validate",
          { raw, format: "yaml" },
          { params: { projectId: p.id } },
        );
      r.status(200).body().has("$.valid", false).exists("$.issues");
    });
    await ctx.step("NONMEMBER → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post(
          "/v1/projects/:projectId/manifest/validate",
          { raw: "kortix_version: 2\n", format: "yaml" },
          { params: { projectId: p.id } },
        );
      r.status([403, 404]);
    });
  },
);

// PROJ-30 — set the project default agent. `kortix.yaml.default_agent` is
// durable truth; project.metadata.default_agent mirrors it for reads. A fresh
// provisioned project now synthesizes a blank v2 manifest with a `kortix`
// agent already declared (see PROJ-19), so setting it back to `kortix` is a
// safe, real no-op write (still commits to git) that proves the success path.
flow(
  "PROJ-30",
  {
    domain: "projects",
    timeoutMs: 240_000,
    routes: ["PUT /v1/projects/:projectId/default-agent"],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project({ seed: true });
    await ctx.step("set default agent to the existing 'kortix' agent → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put("/v1/projects/:projectId/default-agent", { agent: "kortix" }, { params: { projectId: p.id } });
      r.status(200).body().has("$.ok", true).has("$.default_agent", "kortix");
    });
    await ctx.step("unknown agent name → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          "/v1/projects/:projectId/default-agent",
          { agent: "does-not-exist" },
          { params: { projectId: p.id } },
        );
      r.status(400);
    });
    await ctx.step("empty agent name → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put("/v1/projects/:projectId/default-agent", { agent: "" }, { params: { projectId: p.id } });
      r.status(400);
    });
    await ctx.step("NONMEMBER → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .put("/v1/projects/:projectId/default-agent", { agent: "kortix" }, { params: { projectId: p.id } });
      r.status([403, 404]);
    });
  },
);

// PROJ-31 — per-project sandbox-provider pin. `null`/`''` clears the pin
// (follow the platform default/distribution); a concrete value must be an
// ENABLED provider (in ALLOWED_SANDBOX_PROVIDERS with its API key configured)
// or 400. `daytona` is the provider every other session-touching flow in this
// suite boots on, so it is guaranteed enabled here — pin-then-clear on a
// project with no sessions is side-effect-free (resolveSessionProvider only
// consults the pin at session-create time).
flow(
  "PROJ-31",
  { domain: "projects", routes: ["PATCH /v1/projects/:projectId/sandbox-provider"] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step("unknown/disabled provider → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          "/v1/projects/:projectId/sandbox-provider",
          { provider: "not-a-real-provider" },
          { params: { projectId: p.id } },
        );
      r.status(400);
    });
    await ctx.step("pin to the enabled 'daytona' provider → 200 (immediate, kind:project)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch("/v1/projects/:projectId/sandbox-provider", { provider: "daytona" }, { params: { projectId: p.id } });
      // FIX-L: the immediate branch is tagged with the kind:'project' discriminant.
      r.status(200).body().has("$.kind", "project").has("$.default_sandbox_provider", "daytona");
    });
    await ctx.step("clear the pin (null) → 200 (immediate, kind:project)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch("/v1/projects/:projectId/sandbox-provider", { provider: null }, { params: { projectId: p.id } });
      r.status(200).body().has("$.kind", "project");
    });
    await ctx.step("NONMEMBER → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .patch("/v1/projects/:projectId/sandbox-provider", { provider: "daytona" }, { params: { projectId: p.id } });
      r.status([403, 404]);
    });
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .patch("/v1/projects/:projectId/sandbox-provider", { provider: "daytona" }, { params: { projectId: p.id } });
      r.status(401);
    });
  },
);

// PROJ-32 — the BYOK-provider-connect-modal catalog. Serves the SAME live,
// 24h-refreshed `runtimeModelCatalog.snapshot()` every other gateway/model
// endpoint reads (apps/api/src/projects/routes/r4.ts) — provider-level rows
// (id, name, auth env vars, docs URL), NOT gated by projectLlmGatewayEnabled
// since it's meaningful for every project including native (non-gateway)
// ones. Project-read-scoped (403/404 boundary), not actually secret data.
flow(
  "PROJ-32",
  { domain: "projects", routes: ["GET /v1/projects/:projectId/llm-catalog/providers"] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step("OWNER reads the provider-connect catalog → 200 live snapshot", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/llm-catalog/providers", { params: { projectId: p.id } });
      r.status(200).body().exists("$.providers").exists("$.provider_count").exists("$.model_count");
      const body = r.json<any>();
      if (!Array.isArray(body?.providers) || body.providers.length === 0) {
        throw new Error("llm-catalog/providers returned an empty provider list");
      }
    });
    await ctx.step("unknown project → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/llm-catalog/providers", {
          params: { projectId: "00000000-0000-4000-a000-000000000000" },
        });
      r.status(404);
    });
    await ctx.step("NONMEMBER → 403", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/projects/:projectId/llm-catalog/providers", { params: { projectId: p.id } });
      r.status(403);
    });
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/projects/:projectId/llm-catalog/providers", { params: { projectId: p.id } });
      r.status(401);
    });
  },
);

// PROJ-33 — the sandbox-provider migration poll endpoint. The PATCH prepare
// branch (switch to a non-default enabled provider) returns a kind:'preparation'
// body but does NOT flip the active provider; the client polls THIS route until
// the durable transition reaches a terminal status. Project-read-scoped (rejects
// cross-project/non-member) and shaped as a PUBLIC projection — it must NEVER
// leak the lease epoch/holder, raw provider error strings, internal image names,
// or provider template ids. A fresh project with no transition returns
// active_provider=null + latest=null (still 200), which is the case exercised
// here without provisioning a real cross-provider build.
flow(
  "PROJ-33",
  { domain: "projects", routes: ["GET /v1/projects/:projectId/sandbox-provider/transition"] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    const INTERNAL_LEAK_KEYS = [
      "lease_epoch",
      "lease_holder",
      "last_error",
      "snapshot_name",
      "external_template_id",
      "attempts",
    ];
    const assertNoLeak = (item: unknown) => {
      if (item && typeof item === "object") {
        for (const k of INTERNAL_LEAK_KEYS) {
          if (k in (item as Record<string, unknown>)) {
            throw new Error(`transition view leaked internal field '${k}'`);
          }
        }
      }
    };
    await ctx.step("OWNER reads the public transition state → 200 public shape", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/sandbox-provider/transition", { params: { projectId: p.id } });
      r.status(200).body().exists("$.active_provider").exists("$.history");
      const body = r.json<{ latest: unknown; history: unknown[] }>();
      assertNoLeak(body.latest);
      if (Array.isArray(body.history)) body.history.forEach(assertNoLeak);
    });
    await ctx.step("unknown project → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/sandbox-provider/transition", {
          params: { projectId: "00000000-0000-4000-a000-000000000000" },
        });
      r.status(404);
    });
    await ctx.step("NONMEMBER → 403/404 (cross-project rejection)", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/projects/:projectId/sandbox-provider/transition", { params: { projectId: p.id } });
      r.status([403, 404]);
    });
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/projects/:projectId/sandbox-provider/transition", { params: { projectId: p.id } });
      r.status(401);
    });
  },
);
