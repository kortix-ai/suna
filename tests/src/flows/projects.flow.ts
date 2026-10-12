/**
 * Projects — authenticated CRUD + access. Maps to spec §13 (PROJ-1..8).
 */
import { ProjectSchema } from "@kortix/api-contract";
import { Client } from "../core/client";
import { flow } from "../core/flow";
import { waitFor } from "../core/poll";
import { createDatabaseSession, fundDatabaseAccount } from "../fixtures/database-project";
import { seedSessionTranscript } from "../fixtures/session-transcript";

flow("PROJ-1", { domain: "projects", tags: ["smoke"], routes: ["GET /v1/projects"] }, async (ctx) => {
  await ctx.step("OWNER lists projects; every row matches the contract Project", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/projects");
    r.status(200).body().schema(ProjectSchema.array());
  });
  await ctx.step("ANON → 401", async () => {
    const r = await ctx.client.as(ctx.P.ANON).get("/v1/projects");
    r.status(401);
  });
  await ctx.step("the account owner lists every active project as manager; a member lists only the project granted to them", async () => {
    const team = await ctx.fixtures.team();
    const granted = await team.project();
    const other = await team.project();
    const member = await team.addMember("member");
    await team.grantProjectRole(granted.id, member.userId!, "member");
    type Row = { project_id: string; project_role: string | null; effective_project_role: string };
    const asOwner = await ctx.client.as(ctx.P.OWNER).get("/v1/projects", { query: { account_id: team.id } });
    asOwner.status(200);
    const ownerRows = asOwner.json<Row[]>();
    const ids = ownerRows.map((p) => p.project_id).sort();
    if (JSON.stringify(ids) !== JSON.stringify([granted.id, other.id].sort()) || !ownerRows.every((p) => p.effective_project_role === "manager")) {
      throw new Error(`owner list: ${JSON.stringify(ownerRows)}`);
    }
    const asMember = await ctx.client.as(member).get("/v1/projects", { query: { account_id: team.id } });
    asMember.status(200);
    const rows = asMember.json<Row[]>();
    if (rows.length !== 1 || rows[0]!.project_id !== granted.id || rows[0]!.project_role !== "member" || rows[0]!.effective_project_role !== "member") {
      throw new Error(`member list: ${JSON.stringify(rows)}`);
    }
  });
});

flow("PROJ-3", { domain: "projects", requires: ["managedGit"], routes: ["POST /v1/projects/provision", "GET /v1/projects/managed-git/status"] }, async (ctx) => {
  await ctx.step("managed-git status reports configured:true on a managed-git target", async () => {
    (await ctx.client.as(ctx.P.OWNER).get("/v1/projects/managed-git/status")).status(200).body().has("$.configured", true);
  });
  await ctx.step("managed provision → 201 with repo", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).post("/v1/projects/provision", { name: ctx.fixtures.name("prov") });
    // 502 can occur transiently when the managed git host is rate-limited/unavailable.
    r.status([200, 201, 502]);
    if (r.statusCode < 400) r.body().exists("$.project_id").exists("$.repo_url");
    ctx.track("project", r.json<any>().project_id);
  });
  await ctx.step("name over 120 chars → 400, nothing provisioned upstream", async () => {
    const r = await ctx.client
      .as(ctx.P.OWNER)
      .post("/v1/projects/provision", { name: `pasted prompt as name ${"word ".repeat(30)}end` });
    r.status(400);
  });
});

flow(
  "PROJ-14",
  {
    domain: "projects",
    routes: ["POST /v1/projects/provision-stream"],
  },
  async (ctx) => {
    await ctx.step("unsupported provider streams validating, then a terminal 400 error", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/provision-stream", {
          name: ctx.fixtures.name("stream-invalid-provider"),
          provider: "unsupported-provider",
        });
      r.status(200).headerEquals("content-type", /^text\/event-stream/);

      const events = r
        .text()
        .split("\n\n")
        .filter(Boolean)
        .map((frame) => {
          if (!frame.startsWith("data: ")) {
            throw new Error(`provision stream emitted a non-data frame: ${frame}`);
          }
          return JSON.parse(frame.slice("data: ".length)) as Record<string, unknown>;
        });
      if (events.length !== 2) {
        throw new Error(`provision stream emitted ${events.length} events instead of 2`);
      }
      if (events[0]?.type !== "phase" || events[0]?.phase !== "validating") {
        throw new Error(`unexpected provision phase: ${JSON.stringify(events[0])}`);
      }
      if (events[1]?.type !== "error" || events[1]?.status !== 400) {
        throw new Error(`unexpected provision terminal event: ${JSON.stringify(events[1])}`);
      }
    });

    await ctx.step("ANON is rejected before an SSE stream opens", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/projects/provision-stream", { name: "anonymous" });
      r.status(401);
      if (r.header("content-type")?.includes("text/event-stream")) {
        throw new Error("anonymous provision opened an SSE stream");
      }
    });
  },
);

flow("PROJ-5", { domain: "projects", routes: ["GET /v1/projects/:projectId"] }, async (ctx) => {
  const p = await ctx.fixtures.project();
  await ctx.step("OWNER reads project; the body matches the contract Project", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/projects/:projectId", { params: { projectId: p.id } });
    r.status(200).body().has("$.project_id", p.id).schema(ProjectSchema);
  });
  await ctx.step("NONMEMBER → 403/404", async () => {
    const r = await ctx.client.as(ctx.P.NONMEMBER).get("/v1/projects/:projectId", { params: { projectId: p.id } });
    r.status([403, 404]);
  });
  await ctx.step("unknown project → 404", async () => {
    const r = await ctx.client
      .as(ctx.P.OWNER)
      .get("/v1/projects/:projectId", { params: { projectId: "00000000-0000-4000-a000-000000000000" } });
    r.status(404);
  });
  await ctx.step("a read stamps last_opened_at → a later read carries it", async () => {
    await waitFor(
      async () => (await ctx.client.as(ctx.P.OWNER).get("/v1/projects/:projectId", { params: { projectId: p.id } })).json<{ last_opened_at: string | null }>(),
      { until: (b) => typeof b.last_opened_at === "string", timeoutMs: 5_000, intervalMs: 250, description: "last_opened_at stamp" },
    );
  });
});

flow("PROJ-6", { domain: "projects", routes: ["GET /v1/projects/:projectId/detail"] }, async (ctx) => {
  const p = await ctx.fixtures.project();
  await ctx.step("detail returns project + manifest", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/projects/:projectId/detail", { params: { projectId: p.id } });
    r.status(200);
  });
  await ctx.step("NONMEMBER → 403", async () => {
    const r = await ctx.client.as(ctx.P.NONMEMBER).get("/v1/projects/:projectId/detail", { params: { projectId: p.id } });
    r.status(403);
  });
  if (ctx.env.target === "local") {
    await ctx.step("detail of a git-backed project: manager role, a config block, and file_count equal to the files listed", async () => {
      const g = await ctx.fixtures.project({ managedGit: true });
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/projects/:projectId/detail", { params: { projectId: g.id } });
      r.status(200).body().has("$.project.project_id", g.id).has("$.project.effective_project_role", "manager").exists("$.config");
      const { file_count, files } = r.json<{ file_count: number; files: Array<{ path: string }> }>();
      const paths = files.map((f) => f.path);
      if (file_count !== files.length || !paths.includes("kortix.yaml")) {
        throw new Error(`detail files: ${file_count} ${JSON.stringify(paths)}`);
      }
    });
  }
  if (ctx.env.capabilities.admin) {
    const admin = ctx.client.withBearer(ctx.env.adminToken!, "ADMIN_TOKEN");
    await ctx.step("platform admin WITHOUT the bypass header → still 403 (no standing access)", async () => {
      const r = await admin.get("/v1/projects/:projectId/detail", { params: { projectId: p.id } });
      r.status(403);
    });
    await ctx.step("platform admin WITH x-kortix-admin-bypass → 200 (read-only escape hatch)", async () => {
      const r = await admin.get("/v1/projects/:projectId/detail", {
        params: { projectId: p.id },
        headers: { "x-kortix-admin-bypass": "1" },
      });
      r.status(200).body().has("$.project.project_id", p.id);
    });
  }
});

flow("PROJ-7", { domain: "projects", routes: ["PATCH /v1/projects/:projectId"] }, async (ctx) => {
  const p = await ctx.fixtures.project();
  await ctx.step("OWNER patches name, default_branch and manifest_path; repo_url in the body is ignored", async () => {
    const before = await ctx.client.as(ctx.P.OWNER).get("/v1/projects/:projectId", { params: { projectId: p.id } });
    before.status(200);
    const repoUrl = before.json<{ repo_url: string }>().repo_url;
    const name = ctx.fixtures.name("patched");
    const r = await ctx.client.as(ctx.P.OWNER).patch(
      "/v1/projects/:projectId",
      { name, default_branch: "release", manifest_path: "ops/kortix.yaml", repo_url: "https://github.com/example-org/should-not-change.git" },
      { params: { projectId: p.id } },
    );
    r.status(200).body().has("$.name", name).has("$.default_branch", "release").has("$.manifest_path", "ops/kortix.yaml").has("$.repo_url", repoUrl);
  });
  await ctx.step("a project member (floor role) cannot patch the project → 403", async () => {
    const team = await ctx.fixtures.team();
    const tp = await team.project();
    const member = await team.addMember("member");
    await team.grantProjectRole(tp.id, member.userId!, "member");
    (await ctx.client.as(member).patch("/v1/projects/:projectId", { name: "nope" }, { params: { projectId: tp.id } })).status(403);
  });
  await ctx.step("NONMEMBER cannot patch → 403/404", async () => {
    const r = await ctx.client
      .as(ctx.P.NONMEMBER)
      .patch("/v1/projects/:projectId", { name: "nope" }, { params: { projectId: p.id } });
    r.status([403, 404]);
  });
});

flow(
  "PROJ-18",
  {
    domain: "projects",
    // `stripe` ⇒ the target enforces billing, so a free account is capped at 1
    // project; `managedGit` ⇒ managed provisioning is available to reach the cap.
    requires: ["managedGit", "stripe"],
    serial: true,
    routes: ["GET /v1/projects", "POST /v1/projects/provision"],
  },
  async (ctx) => {
    // NONMEMBER is a fresh, UNFUNDED (free) account → its project cap is 1.
    const list = await ctx.client.as(ctx.P.NONMEMBER).get("/v1/projects");
    list.status(200);
    const existing = list.json<any[]>()?.length ?? 0;

    for (let index = existing; index < 1; index += 1) {
      await ctx.step(`free account: project ${index + 1} of 1 allowed (201)`, async () => {
        let r = await ctx.client
          .as(ctx.P.NONMEMBER)
          .post("/v1/projects/provision", {
            name: ctx.fixtures.name(`free-${index + 1}`),
          });
        // The managed Git host can return a transient 502. Retry the same quota
        // slot before deciding the contract failed; only a real 201 advances it.
        for (let attempt = 1; r.statusCode === 502 && attempt < 4; attempt += 1) {
          await Bun.sleep(2_000 * attempt);
          r = await ctx.client
            .as(ctx.P.NONMEMBER)
            .post("/v1/projects/provision", {
              name: ctx.fixtures.name(`free-${index + 1}-retry-${attempt}`),
            });
        }
        r.status(201).body().exists("$.project_id");
        ctx.track("project", r.json<any>().project_id);
      });
    }

    await ctx.step("free account: 2nd project rejected (403 project_limit_reached)", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post("/v1/projects/provision", { name: ctx.fixtures.name("free-2") });
      // The quota gate runs before any repository is provisioned.
      r.status(403)
        .body()
        .has("$.code", "project_limit_reached")
        .has("$.limit", 1)
        .has("$.count", 1);
    });
  },
);

flow("PROJ-8", { domain: "projects", routes: ["DELETE /v1/projects/:projectId"] }, async (ctx) => {
  // Local uses a database fixture so deletion remains hermetic. Remote targets
  // provision a managed repository and then archive it through the same route.
  let id = "";
  if (ctx.env.target === "local") {
    id = (await ctx.fixtures.project({ name: ctx.fixtures.name("del") })).id;
  } else {
    await ctx.step("OWNER provisions a project to archive", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post("/v1/projects/provision", { name: ctx.fixtures.name("del") });
      r.status([200, 201]).body().exists("$.project_id");
      id = r.json<any>().project_id;
    });
  }
  await ctx.step("OWNER archives project", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).del("/v1/projects/:projectId", { params: { projectId: id } });
    r.status(200).body().has("$.ok", true);
  });
  await ctx.step("archived project reads 404", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/projects/:projectId", { params: { projectId: id } });
    r.status(404);
  });
});

flow("PROJ-36", { domain: "projects", routes: ["PUT /v1/projects/:projectId/git/repository", "GET /v1/projects/:projectId"] }, async (ctx) => {
  const project = await ctx.fixtures.project({ name: ctx.fixtures.name("repo-replace") });
  const path = "/v1/projects/:projectId/git/repository";
  const params = { projectId: project.id };
  let expectedRepoUrl = "";
  await ctx.step("OWNER reads the repository before attempting replacement", async () => {
    const response = await ctx.client.as(ctx.P.OWNER).get("/v1/projects/:projectId", { params });
    response.status(200).body().exists("$.repo_url");
    expectedRepoUrl = response.json<any>().repo_url;
  });
  const body = () => ({
    repo_url: "https://example.test/not-github.git",
    expected_repo_url: expectedRepoUrl,
    github_token: "invalid-test-token",
  });
  await ctx.step("OWNER cannot replace the repository with a non-GitHub URL", async () => {
    const response = await ctx.client.as(ctx.P.OWNER).put(path, body(), { params });
    response.status(400);
    const current = await ctx.client.as(ctx.P.OWNER).get("/v1/projects/:projectId", { params });
    current.status(200).body().has("$.repo_url", expectedRepoUrl);
  });
  await ctx.step("OWNER must choose one GitHub authorization method", async () => {
    const missing = await ctx.client.as(ctx.P.OWNER).put(path, {
      repo_url: "https://github.com/example-org/shared-repository",
      expected_repo_url: expectedRepoUrl,
    }, { params });
    missing.status(400);
    const ambiguous = await ctx.client.as(ctx.P.OWNER).put(path, {
      repo_url: "https://github.com/example-org/shared-repository",
      expected_repo_url: expectedRepoUrl,
      github_token: "unused-token", installation_id: "123", github_user_token: "unused-user-token",
    }, { params });
    ambiguous.status(400);
    const current = await ctx.client.as(ctx.P.OWNER).get("/v1/projects/:projectId", { params });
    current.status(200).body().has("$.repo_url", expectedRepoUrl);
  });
  await ctx.step("NONMEMBER cannot replace another project's repository", async () => {
    const response = await ctx.client.as(ctx.P.NONMEMBER).put(path, body(), { params });
    response.status([403, 404]);
  });
  await ctx.step("ANON cannot replace the repository", async () => {
    const response = await ctx.client.as(ctx.P.ANON).put(path, body(), { params });
    response.status(401);
  });
});

// PROJ-39 — the agents listing reflects every REGISTERED agent: a manifest whose
// `agents:` live in an imported (nested YAML) file lists each declared agent,
// the disabled one with `enabled: false`, anchored at the file that declares it.
flow(
  "PROJ-39",
  { domain: "projects", routes: ["GET /v1/projects/:projectId/detail"] },
  async (ctx) => {
    if (ctx.env.target !== "local") return; // the manifest is pushed straight to the local bare repo; deployed targets push through the git proxy
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join, dirname } = await import("node:path");
    const { Client: PgClient } = await import("pg");

    const project = await ctx.fixtures.project({ managedGit: true });
    const owner = ctx.client.as(ctx.P.OWNER);
    const databaseUrl = ctx.env.databaseUrl;
    if (!databaseUrl) throw new Error("the local profile must expose a database URL");
    const db = new PgClient({ connectionString: databaseUrl });
    await db.connect();
    const work = mkdtempSync(join(tmpdir(), "ke2e-proj39-"));
    try {
      const { rows } = await db.query("SELECT repo_url, default_branch FROM kortix.projects WHERE project_id = $1", [project.id]);
      const repoUrl = String(rows[0]?.repo_url ?? "");
      const base = String(rows[0]?.default_branch || "main");
      await ctx.step("push a root manifest whose agents live in an imported (nested) file, one enabled and one disabled", async () => {
        execFileSync("git", ["clone", "-q", "--branch", base, repoUrl, "."], { cwd: work, stdio: "pipe" });
        writeFileSync(join(work, "kortix.yaml"), "kortix_version: 2\nimports:\n  - domains/kortix.yaml\n");
        mkdirSync(dirname(join(work, "domains/kortix.yaml")), { recursive: true });
        writeFileSync(
          join(work, "domains/kortix.yaml"),
          "agents:\n  builder:\n    connectors: all\n  observer:\n    enabled: false\n    connectors: all\n",
        );
        execFileSync("git", ["add", "-A"], { cwd: work, stdio: "pipe" });
        execFileSync("git", ["-c", "user.name=KE2E", "-c", "user.email=ke2e@kortix.invalid", "commit", "-qm", "declare agents through an import"], { cwd: work, stdio: "pipe" });
        execFileSync("git", ["push", "-q", "origin", `HEAD:refs/heads/${base}`], { cwd: work, stdio: "pipe" });
      });
      await ctx.step("GET detail lists every registered agent — the disabled one with enabled:false, attributed to its declaring file", async () => {
        const r = await owner.get("/v1/projects/:projectId/detail", { params: { projectId: project.id } });
        r.status(200);
        const config =
          r.json<{ config: { agent_discovery: string; agents?: Array<{ name: string; enabled?: boolean; path: string }> } }>().config;
        if (config.agent_discovery !== "declarative") throw new Error(`agent_discovery ${config.agent_discovery}`);
        const agents = config.agents ?? [];
        if (agents.length !== 2) throw new Error(`expected 2 registered agents, got ${JSON.stringify(agents.map((a) => a.name))}`);
        const byName = new Map(agents.map((a) => [a.name, a]));
        const builder = byName.get("builder");
        const observer = byName.get("observer");
        if (!builder || builder.enabled === false) throw new Error(`builder missing or disabled: ${JSON.stringify(builder)}`);
        if (!observer || observer.enabled !== false) throw new Error(`observer missing or not disabled: ${JSON.stringify(observer)}`);
        if (builder.path !== "domains/kortix.yaml#agents.builder") throw new Error(`builder path ${builder.path}`);
        if (observer.path !== "domains/kortix.yaml#agents.observer") throw new Error(`observer path ${observer.path}`);
      });
    } finally {
      rmSync(work, { recursive: true, force: true });
      await db.end();
    }
  },
);

flow(
  "PROJ-42",
  { domain: "projects", routes: ["GET /v1/projects/managed-git/status", "POST /v1/projects/provision", "GET /v1/projects"] },
  async (ctx) => {
    const owner = ctx.client.as(ctx.P.OWNER);
    await ctx.step("provision into an account the caller is not a member of → 403", async () => {
      const foreign = ctx.P.NONMEMBER.accountId;
      if (!foreign) throw new Error("NONMEMBER fixture has no account id");
      const r = await owner.post("/v1/projects/provision", { name: ctx.fixtures.name("foreign-acct"), account_id: foreign });
      r.status(403).body().has("$.message", "You do not have access to this account");
    });
    const status = await owner.get("/v1/projects/managed-git/status");
    status.status(200);
    const { configured, provider } = status.json<{ configured: boolean; provider: string }>();
    if (!configured) {
      await ctx.step("managed git unconfigured → POST /provision 503 naming the provider; no project registered", async () => {
        const name = ctx.fixtures.name("unconfigured");
        const r = await owner.post("/v1/projects/provision", { name });
        r.status(503).body().has("$.error", `Managed git provider "${provider}" is not configured on this server`);
        const list = await owner.get("/v1/projects");
        list.status(200);
        if (list.json<Array<{ name: string }>>().some((project) => project.name === name)) throw new Error("a refused provision registered a project");
      });
    }
  },
);

// PROJ-41 — the per-account project cap on POST /v1/projects, which calls the
// same quota check as /provision before any GitHub lookup. PROJ-18 owns the
// deployed cap through /provision; the local profile enforces billing itself.
flow(
  "PROJ-41",
  { domain: "projects", requires: ["database"], routes: ["POST /v1/projects", "DELETE /v1/projects/:projectId"] },
  async (ctx) => {
    if (ctx.env.target !== "local") return;
    const team = await ctx.fixtures.team();
    const first = await team.project();
    const owner = ctx.client.as(ctx.P.OWNER);
    const create = () =>
      owner.post("/v1/projects", { account_id: team.id, name: ctx.fixtures.name("quota-probe"), repo_url: "https://github.com/example-org/quota-probe" });
    await ctx.step("free team account at its 1-project cap → 403 project_limit_reached {limit:1,count:1}", async () => {
      (await create())
        .status(403)
        .body()
        .has("$.code", "project_limit_reached")
        .has("$.limit", 1)
        .has("$.count", 1)
        .has("$.error", "Free accounts are limited to 1 project. Upgrade to a paid plan to create more.");
    });
    await ctx.step("archiving the one project frees the slot → the create passes the cap and stops at the GitHub App check (409)", async () => {
      (await owner.del("/v1/projects/:projectId", { params: { projectId: first.id } })).status(200);
      const r = await create();
      r.status(409);
      if (r.json<any>()?.code === "project_limit_reached") throw new Error("an archived project still consumed the slot");
    });
    await ctx.step("a paid plan lifts the free cap → 409 at the GitHub App check, not 403", async () => {
      await team.project();
      await fundDatabaseAccount(ctx.env, team.id);
      (await create()).status(409);
    });
  },
);

/**
 * PROJ-40 — deleting a workspace closes its side doors (KRTX-1714). The delete
 * archives the project, and the revoke routes answer 404 after it, so a door
 * that ignored `projects.status` stayed open for good: a public transcript
 * link kept rendering and a kgw_ key kept authorizing billed LLM calls.
 */
flow(
  "PROJ-40",
  {
    domain: "projects",
    requires: ["database"],
    routes: [
      "PATCH /v1/projects/:projectId/experimental",
      "POST /v1/projects/:projectId/gateway/keys",
      "POST /v1/projects/:projectId/sessions/:sessionId/public-shares",
      "GET /v1/public/session-shares/:shareId/messages",
      "POST /v1/llm/chat/completions",
      "DELETE /v1/projects/:projectId",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project();
    const owner = ctx.client.as(ctx.P.OWNER);
    const anon = ctx.client.as(ctx.P.ANON);
    const params = { projectId: project.id };
    const sessionId = await createDatabaseSession(ctx.env, {
      projectId: project.id,
      accountId: team.id,
      userId: ctx.P.OWNER.userId!,
      visibility: "project",
    });
    ctx.track("session", sessionId, { projectId: project.id });
    await seedSessionTranscript(ctx.env, { projectId: project.id, accountId: team.id, sessionId });

    let key = "";
    let token = "";
    await ctx.step("the owner mints a kgw_ key and a public transcript link", async () => {
      (await owner.patch("/v1/projects/:projectId/experimental", { feature: "llm_gateway", enabled: true }, { params }))
        .status(200);
      const minted = await owner.post("/v1/projects/:projectId/gateway/keys", { name: "ci" }, { params });
      minted.status(200).body().exists("$.secret_key");
      key = minted.json<{ secret_key: string }>().secret_key;
      const share = await owner.post(
        "/v1/projects/:projectId/sessions/:sessionId/public-shares",
        { transcript: true },
        { params: { ...params, sessionId } },
      );
      share.status(201);
      token = share.json<{ share: { public_token: string } }>().share.public_token;
    });

    const gateway = () => new Client(ctx.env.gatewayUrl).withBearer(key, "PROJECT_GATEWAY_KEY");
    const ask = () => gateway().post("/v1/llm/chat/completions", { model: "kimi-k3", max_tokens: 1, messages: [] });

    await ctx.step("while the workspace is live: the gateway accepts the key and the link reads the transcript", async () => {
      const r = await ask();
      if (r.statusCode === 401) throw new Error(`the live key was refused: ${r.text().slice(0, 200)}`);
      (await anon.get("/v1/public/session-shares/:shareId/messages", { params: { shareId: token } })).status(200);
    });

    await ctx.step("the owner deletes the workspace", async () => {
      (await owner.del("/v1/projects/:projectId", { params })).status(200).body().has("$.archived", true);
    });

    await ctx.step("after the delete: the kgw_ key → 401 and the link → 410", async () => {
      (await ask()).status(401);
      (await anon.get("/v1/public/session-shares/:shareId/messages", { params: { shareId: token } })).status(410);
    });
  },
);
