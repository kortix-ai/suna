/**
 * Projects — authenticated CRUD + access. Maps to spec §13 (PROJ-1..8).
 */
import { ProjectSchema } from "@kortix/api-contract";
import { isMyKortixAgentName } from "../../../packages/shared/src/my-kortix-agent";
import { Client } from "../core/client";
import { flow } from "../core/flow";
import { waitFor } from "../core/poll";
import { AgentPrincipalsWorld } from "../fixtures/agent-principals";
import { createDatabaseSession, fundDatabaseAccount } from "../fixtures/database-project";

flow("PROJ-1", { domain: "projects", tags: ["deployed", "smoke"], routes: ["GET /v1/workspaces", "GET /v1/projects"] }, async (ctx) => {
  await ctx.step("OWNER lists projects; every row matches the contract Project", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/workspaces");
    r.status(200).body().schema(ProjectSchema.array());
  });
  await ctx.step("ANON → 401", async () => {
    const r = await ctx.client.as(ctx.P.ANON).get("/v1/workspaces");
    r.status(401);
  });
  // GET /v1/projects?account_id= keeps its single-account meaning (GET /v1/workspaces lists every account).
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

flow("PROJ-3", { domain: "projects", requires: ["managedGit"], routes: ["POST /v1/projects/provision", "GET /v1/workspaces/managed-git/status"] }, async (ctx) => {
  await ctx.step("managed-git status reports configured:true on a managed-git target", async () => {
    (await ctx.client.as(ctx.P.OWNER).get("/v1/workspaces/managed-git/status")).status(200).body().has("$.configured", true);
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
          // An empty team account: the OWNER's default one already holds its
          // project (409 workspace_has_project before the provider is validated).
          account_id: (await ctx.fixtures.team()).id,
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

flow("PROJ-5", { domain: "projects", routes: ["GET /v1/workspaces/:projectId"] }, async (ctx) => {
  const p = await ctx.fixtures.project();
  await ctx.step("OWNER reads project; the body matches the contract Project", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/workspaces/:projectId", { params: { projectId: p.id } });
    r.status(200).body().has("$.project_id", p.id).schema(ProjectSchema);
  });
  await ctx.step("NONMEMBER → 403/404", async () => {
    const r = await ctx.client.as(ctx.P.NONMEMBER).get("/v1/workspaces/:projectId", { params: { projectId: p.id } });
    r.status([403, 404]);
  });
  await ctx.step("unknown project → 404", async () => {
    const r = await ctx.client
      .as(ctx.P.OWNER)
      .get("/v1/workspaces/:projectId", { params: { projectId: "00000000-0000-4000-a000-000000000000" } });
    r.status(404);
  });
  await ctx.step("a read stamps last_opened_at → a later read carries it", async () => {
    await waitFor(
      async () => (await ctx.client.as(ctx.P.OWNER).get("/v1/workspaces/:projectId", { params: { projectId: p.id } })).json<{ last_opened_at: string | null }>(),
      { until: (b) => typeof b.last_opened_at === "string", timeoutMs: 5_000, intervalMs: 250, description: "last_opened_at stamp" },
    );
  });
});

flow("PROJ-6", { domain: "projects", routes: ["GET /v1/workspaces/:projectId/detail"] }, async (ctx) => {
  const p = await ctx.fixtures.project();
  await ctx.step("detail returns project + manifest", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/workspaces/:projectId/detail", { params: { projectId: p.id } });
    r.status(200);
  });
  await ctx.step("NONMEMBER → 404 workspace_not_found", async () => {
    const r = await ctx.client.as(ctx.P.NONMEMBER).get("/v1/workspaces/:projectId/detail", { params: { projectId: p.id } });
    r.status(404).body().has("$.code", "workspace_not_found");
  });
  if (ctx.env.target === "local") {
    await ctx.step("detail of a git-backed project: manager role, a config block, and file_count equal to the files listed", async () => {
      const g = await ctx.fixtures.project({ managedGit: true });
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/workspaces/:projectId/detail", { params: { projectId: g.id } });
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
    await ctx.step("platform admin WITHOUT the bypass header → no standing access (404 workspace_not_found)", async () => {
      const r = await admin.get("/v1/workspaces/:projectId/detail", { params: { projectId: p.id } });
      r.status(404).body().has("$.code", "workspace_not_found");
    });
    // The header is retired (#10246): an admin opens a project by acting as
    // its account (IMP-2), so the header must grant nothing here either.
    await ctx.step("platform admin WITH the retired x-kortix-admin-bypass header → still no access (404 workspace_not_found)", async () => {
      const r = await admin.get("/v1/workspaces/:projectId/detail", {
        params: { projectId: p.id },
        headers: { "x-kortix-admin-bypass": "1" },
      });
      r.status(404).body().has("$.code", "workspace_not_found");
    });
  }
});

flow("PROJ-7", { domain: "projects", routes: ["PATCH /v1/workspaces/:projectId"] }, async (ctx) => {
  const p = await ctx.fixtures.project();
  // A rename commits project.name to kortix.yaml first (#10883), so it needs a
  // reachable repository: APP-15 covers it. This fixture has none.
  await ctx.step("OWNER patches default_branch and manifest_path; repo_url in the body is ignored", async () => {
    const before = await ctx.client.as(ctx.P.OWNER).get("/v1/workspaces/:projectId", { params: { projectId: p.id } });
    before.status(200);
    const { name, repo_url: repoUrl } = before.json<{ name: string; repo_url: string }>();
    const r = await ctx.client.as(ctx.P.OWNER).patch(
      "/v1/workspaces/:projectId",
      { default_branch: "release", manifest_path: "ops/kortix.yaml", repo_url: "https://github.com/example-org/should-not-change.git" },
      { params: { projectId: p.id } },
    );
    r.status(200).body().has("$.name", name).has("$.default_branch", "release").has("$.manifest_path", "ops/kortix.yaml").has("$.repo_url", repoUrl);
  });
  await ctx.step("a project member (floor role) cannot patch the project → 403", async () => {
    const team = await ctx.fixtures.team();
    const tp = await team.project();
    const member = await team.addMember("member");
    await team.grantProjectRole(tp.id, member.userId!, "member");
    (await ctx.client.as(member).patch("/v1/workspaces/:projectId", { name: "nope" }, { params: { projectId: tp.id } })).status(403);
  });
  await ctx.step("NONMEMBER cannot patch → 403/404", async () => {
    const r = await ctx.client
      .as(ctx.P.NONMEMBER)
      .patch("/v1/workspaces/:projectId", { name: "nope" }, { params: { projectId: p.id } });
    r.status([403, 404]);
  });
});

flow(
  "PROJ-18",
  {
    domain: "projects",
    // `managedGit` ⇒ managed provisioning is available; `stripe` ⇒ a real
    // billing target, where the rule must hold on the Free plan too.
    requires: ["managedGit", "stripe"],
    serial: true,
    routes: ["GET /v1/projects", "POST /v1/projects/provision", "GET /v1/projects/quota"],
  },
  async (ctx) => {
    // NONMEMBER is a fresh, unfunded (Free) person: their default account
    // holds at most its one project.
    const list = await ctx.client.as(ctx.P.NONMEMBER).get("/v1/projects");
    list.status(200);
    let accountId: string | undefined = list.json<any[]>()?.[0]?.account_id;

    if (!accountId) {
      await ctx.step("free account: its one project is allowed (201)", async () => {
        let r = await ctx.client.as(ctx.P.NONMEMBER).post("/v1/projects/provision", { name: ctx.fixtures.name("free-1") });
        // The managed Git host can return a transient 502. Retry before deciding the contract failed.
        for (let attempt = 1; r.statusCode === 502 && attempt < 4; attempt += 1) {
          await Bun.sleep(2_000 * attempt);
          r = await ctx.client.as(ctx.P.NONMEMBER).post("/v1/projects/provision", { name: ctx.fixtures.name(`free-1-retry-${attempt}`) });
        }
        r.status(201).body().exists("$.project_id");
        ctx.track("project", r.json<any>().project_id);
        accountId = r.json<any>().account_id;
      });
    }

    await ctx.step("a 2nd project naming the same account (the published CLI's shape) → 201, a new workspace in its own account; the first account's quota stays capped, limit 1", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post("/v1/projects/provision", { name: ctx.fixtures.name("free-2"), account_id: accountId }, { query: { account_id: accountId! } });
      r.status(201).body().exists("$.workspace_id");
      ctx.track("project", r.json<any>().project_id);
      if (r.json<any>().account_id === accountId) throw new Error("the 2nd project landed in the occupied account");
      (await ctx.client.as(ctx.P.NONMEMBER).get("/v1/projects/quota", { query: { account_id: accountId! } }))
        .status(200)
        .body()
        .has("$.capped", true)
        .has("$.limit", 1);
    });
  },
);

flow("PROJ-8", {
  domain: "projects",
  routes: [
    "DELETE /v1/workspaces/:projectId",
    "GET /v1/workspaces/:projectId",
    "POST /v1/connectors/workspaces/:projectId/connectors",
    "GET /v1/connectors/workspaces/:projectId/connectors",
  ],
}, async (ctx) => {
  // Local uses a database fixture so deletion remains hermetic. Remote targets
  // provision a managed repository and then archive it through the same route.
  let id = "";
  if (ctx.env.target === "local") {
    // managedGit: the connector-create step commits kortix.yaml, which a
    // database-only fixture's ke2e.invalid remote cannot take.
    // A team's workspace: its own account (1:1), so deleting it schedules the
    // 14-day close. The OWNER's default account holds every database fixture
    // project and is split_pending, which archives without a date.
    id = (await (await ctx.fixtures.team()).project({ name: ctx.fixtures.name("del"), managedGit: true })).id;
  } else {
    await ctx.step("OWNER provisions a project to archive", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post("/v1/projects/provision", { name: ctx.fixtures.name("del") });
      r.status([200, 201]).body().exists("$.project_id");
      id = r.json<any>().project_id;
    });
  }
  await ctx.step("OWNER adds an HTTP connector to the project", async () => {
    const r = await ctx.client
      .as(ctx.P.OWNER)
      .post(
        "/v1/connectors/workspaces/:projectId/connectors",
        {
          slug: `ke2e-proj8-${Date.now().toString(36)}`,
          provider: "http",
          baseUrl: "https://fixture.example.test",
          auth: { type: "none" },
        },
        { params: { projectId: id } },
      );
    r.status(200).body().has("$.ok", true);
  });
  await ctx.step("OWNER cannot add a connector under the built-in Telegram slug → 400, nothing written", async () => {
    const r = await ctx.client
      .as(ctx.P.OWNER)
      .post(
        "/v1/connectors/workspaces/:projectId/connectors",
        { slug: "kortix_telegram", provider: "http", baseUrl: "https://fixture.example.test", auth: { type: "none" } },
        { params: { projectId: id } },
      );
    r.status(400).body().has("$.error", '"kortix_telegram" is reserved for a built-in channel connection. Pick a different slug.');
  });
  await ctx.step("the project lists exactly its one connector", async () => {
    const r = await ctx.client
      .as(ctx.P.OWNER)
      .get("/v1/connectors/workspaces/:projectId/connectors", { params: { projectId: id } });
    const rows = r.status(200).json<{ connectors: unknown[] }>().connectors;
    if (rows.length !== 1) throw new Error(`expected the project to list 1 connector, listed ${rows.length}`);
  });
  await ctx.step("OWNER deletes the workspace → 200 deleted: true, archived: true (kept for older clients), repo_deleted: false, a deletion date 14 days out", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).del("/v1/workspaces/:projectId", { params: { projectId: id } });
    r.status(200).body().has("$.ok", true).has("$.deleted", true).has("$.archived", true).has("$.repo_deleted", false).exists("$.deletion_scheduled_for");
  });
  await ctx.step("the owner still reads it during the 14-day grace: state deleting; its connector routes → 409 workspace_deleting", async () => {
    // K2: deleting a workspace closes it. Its owner keeps reading and can
    // restore it until the grace ends; the deletion sweep then purges its rows.
    (await ctx.client.as(ctx.P.OWNER).get("/v1/workspaces/:projectId", { params: { projectId: id } }))
      .status(200).body().has("$.state", "deleting");
    (await ctx.client.as(ctx.P.OWNER).get("/v1/connectors/workspaces/:projectId/connectors", { params: { projectId: id } }))
      .status(409).body().has("$.code", "workspace_deleting");
  });
});

flow("PROJ-36", { domain: "projects", routes: ["PUT /v1/workspaces/:projectId/git/repository", "GET /v1/workspaces/:projectId"] }, async (ctx) => {
  const project = await ctx.fixtures.project({ name: ctx.fixtures.name("repo-replace") });
  const path = "/v1/workspaces/:projectId/git/repository";
  const params = { projectId: project.id };
  let expectedRepoUrl = "";
  await ctx.step("OWNER reads the repository before attempting replacement", async () => {
    const response = await ctx.client.as(ctx.P.OWNER).get("/v1/workspaces/:projectId", { params });
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
    const current = await ctx.client.as(ctx.P.OWNER).get("/v1/workspaces/:projectId", { params });
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
    const current = await ctx.client.as(ctx.P.OWNER).get("/v1/workspaces/:projectId", { params });
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
  { domain: "projects", routes: ["GET /v1/workspaces/:projectId/detail"] },
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
        writeFileSync(join(work, "kortix.yaml"), "imports:\n  - domains/kortix.yaml\n");
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
        const r = await owner.get("/v1/workspaces/:projectId/detail", { params: { projectId: project.id } });
        r.status(200);
        const config =
          r.json<{ config: { agent_discovery: string; agents?: Array<{ name: string; enabled?: boolean; path: string }> } }>().config;
        if (config.agent_discovery !== "declarative") throw new Error(`agent_discovery ${config.agent_discovery}`);
        // My Kortix is listed too; the check is about the declared agents.
        const agents = (config.agents ?? []).filter((a) => !isMyKortixAgentName(a.name));
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

// PROJ-47 — kortix.yaml has one format and no version. The project detail
// reports the manifest's health: what is wrong, where, and how bad. A running
// project never stops on it; the issues are for the person (or agent) who fixes the file.
type ManifestHealth = {
  path: string | null;
  state: string;
  errors: number;
  warnings: number;
  issues: Array<{ path: string; message: string; severity: "error" | "warning"; line?: number; column?: number }>;
};
const HEALTHY_MANIFEST =
  "project:\n  name: ke2e-manifest-health\ndefault_agent: worker\nagents:\n  worker:\n    prompt: You keep the project tidy.\n    tools: all\n";

flow(
  "PROJ-47",
  { domain: "projects", requires: ["database"], timeoutMs: 180_000, routes: ["GET /v1/workspaces/:projectId/detail"] },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project({ managedGit: true });
    const world = await AgentPrincipalsWorld.open(ctx, { accountId: team.id, projectId: project.id });
    // The detail serves the warm git mirror and refreshes it behind the response.
    const healthOf = async (text: string, message: string) => {
      await world.writeManifest(text, message);
      const config = await waitFor(
        async () =>
          (await world.owner.get("/v1/workspaces/:projectId/detail", { params: { projectId: project.id } }))
            .status(200)
            .json<{ config: { manifest_raw: string | null; manifest_health: ManifestHealth } }>().config,
        { until: (c) => c.manifest_raw === text, timeoutMs: 60_000, intervalMs: 1_000, description: `detail to serve "${message}"` },
      );
      return config.manifest_health;
    };
    const fail = (what: string, health: ManifestHealth) => {
      throw new Error(`${what}: ${JSON.stringify(health)}`);
    };
    try {
      await ctx.step("a kortix.yaml with no kortix_version → manifest_health ok, 0 errors, 0 warnings, no issues", async () => {
        const health = await healthOf(HEALTHY_MANIFEST, "ke2e: healthy manifest");
        if (health.state !== "ok" || health.path !== "kortix.yaml" || health.errors !== 0 || health.warnings !== 0 || health.issues.length !== 0) {
          fail("expected ok with no issues", health);
        }
      });

      await ctx.step("an unknown agent key and a non-string model → state issues with both errors, each at its line", async () => {
        const text = `${HEALTHY_MANIFEST}    descripton: Tidies.\n  reviewer:\n    prompt: You review changes.\n    tools: all\n    model: 42\n`;
        const health = await healthOf(text, "ke2e: two agent errors");
        if (health.state !== "issues" || health.errors !== 2 || health.warnings !== 0) fail("expected 2 errors", health);
        const unknown = health.issues.find((i) => i.path === "agents.worker.descripton");
        const model = health.issues.find((i) => i.path === "agents.reviewer.model");
        if (unknown?.severity !== "error" || unknown.line !== 8 || !/description/.test(unknown.message)) {
          fail("the unknown key is not an error at line 8 that suggests `description`", health);
        }
        if (model?.severity !== "error" || model.line !== 12) fail("the bad model is not an error at line 12", health);
      });

      await ctx.step("kortix_version: 3 → one warning (obsolete, ignored); the body still validates", async () => {
        const health = await healthOf(`kortix_version: 3\n${HEALTHY_MANIFEST}`, "ke2e: obsolete version key");
        const [issue] = health.issues;
        if (health.state !== "issues" || health.errors !== 0 || health.warnings !== 1 || issue?.path !== "kortix_version" || issue.line !== 1) {
          fail("expected one kortix_version warning at line 1", health);
        }
      });

      await ctx.step("kortix_version: 2 → one legacy-format warning that names `kortix validate --fix`; the converted body is validated", async () => {
        const health = await healthOf(`kortix_version: 2\n${HEALTHY_MANIFEST}    descripton: Tidies.\n`, "ke2e: legacy format");
        const legacy = health.issues.find((i) => i.path === "kortix_version");
        const unknown = health.issues.find((i) => i.path === "agents.worker.descripton");
        if (health.state !== "issues" || health.errors !== 1 || health.warnings !== 1) fail("expected 1 error and 1 warning", health);
        if (legacy?.severity !== "warning" || legacy.line !== 1 || !legacy.message.includes("kortix validate --fix")) {
          fail("the legacy warning is not at line 1 or does not name `kortix validate --fix`", health);
        }
        if (unknown?.severity !== "error" || unknown.line !== 9) fail("the unknown key in the converted body is not an error at line 9", health);
      });
    } finally {
      await world.close();
    }
  },
);

flow(
  "PROJ-42",
  { domain: "projects", routes: ["GET /v1/workspaces/managed-git/status", "POST /v1/projects/provision", "GET /v1/workspaces"] },
  async (ctx) => {
    const owner = ctx.client.as(ctx.P.OWNER);
    await ctx.step("provision into an account the caller is not a member of → 403", async () => {
      const foreign = ctx.P.NONMEMBER.accountId;
      if (!foreign) throw new Error("NONMEMBER fixture has no account id");
      const r = await owner.post("/v1/projects/provision", { name: ctx.fixtures.name("foreign-acct"), account_id: foreign });
      r.status(403).body().has("$.message", "You do not have access to this workspace");
    });
    const status = await owner.get("/v1/workspaces/managed-git/status");
    status.status(200);
    const { configured, provider } = status.json<{ configured: boolean; provider: string }>();
    if (!configured) {
      await ctx.step("managed git unconfigured → POST /provision 503 naming the provider; no project registered", async () => {
        const name = ctx.fixtures.name("unconfigured");
        const r = await owner.post("/v1/projects/provision", { name });
        r.status(503).body().has("$.error", `Managed git provider "${provider}" is not configured on this server`);
        const list = await owner.get("/v1/workspaces");
        list.status(200);
        if (list.json<Array<{ name: string }>>().some((project) => project.name === name)) throw new Error("a refused provision registered a project");
      });
    }
  },
);

/**
 * The GitHub App install prompt: 409 with an `install_url` key. The local
 * profile configures no App slug, so the value is null there and a URL on a
 * deployed target; the CLI shows its retry prompt either way.
 */
function expectInstallPrompt(r: { statusCode: number; text(): string; json<T>(): T }): void {
  if (r.statusCode !== 409) throw new Error(`expected 409 install prompt, got ${r.statusCode} ${r.text().slice(0, 200)}`);
  const body = r.json<Record<string, unknown>>();
  if (!("install_url" in body)) throw new Error(`409 without install_url: ${r.text().slice(0, 200)}`);
  if (body.install_url !== null && typeof body.install_url !== "string") throw new Error(`install_url ${JSON.stringify(body.install_url)}`);
}

// PROJ-41 — the workspace rule on POST /v1/projects (import): an account holds
// one active project, on every plan. The published CLI names its occupied
// account; a person then gets a new workspace (byo-new-workspace.ts), created
// only after GitHub validated the repository, so the local profile (no GitHub
// App) answers 409 install_url and creates nothing. A workspace key keeps the
// refusal. PROJ-18 owns the deployed rule through /provision.
flow(
  "PROJ-41",
  {
    domain: "projects",
    requires: ["database"],
    routes: ["POST /v1/projects", "GET /v1/projects/quota", "GET /v1/accounts", "POST /v1/workspaces/:workspaceId/tokens", "DELETE /v1/workspaces/:projectId"],
  },
  async (ctx) => {
    if (ctx.env.target !== "local") return;
    const team = await ctx.fixtures.team();
    const first = await team.project();
    const owner = ctx.client.as(ctx.P.OWNER);
    const body = () => ({ account_id: team.id, name: ctx.fixtures.name("quota-probe"), repo_url: "https://github.com/example-org/quota-probe" });
    // Only the accounts this import would create (a new workspace is named
    // after its project): other flows create accounts for OWNER concurrently.
    const probeName = body().name;
    const accountIds = async () =>
      (await owner.get("/v1/accounts")).status(200).json<Array<{ account_id: string; name?: string }>>()
        .filter((a) => a.name === probeName).map((a) => a.account_id).sort();
    const personCreate = async () => {
      const before = await accountIds();
      const r = await owner.post("/v1/projects", body());
      expectInstallPrompt(r);
      if (r.json<{ code?: string }>().code === "workspace_has_project") throw new Error("a person got workspace_has_project");
      const after = await accountIds();
      if (after.join() !== before.join()) throw new Error(`a refused import created an account: ${after.length - before.length}`);
    };
    await ctx.step("an account that holds its project → the owner's import goes to a new workspace: no GitHub App → 409 install_url, never workspace_has_project, no account created; /quota says capped, limit 1, no upgrade copy", async () => {
      await personCreate();
      const quota = (await owner.get("/v1/projects/quota", { query: { account_id: team.id } })).status(200);
      quota.body().has("$.capped", true).has("$.limit", 1).has("$.count", 1);
      if (/upgrade/i.test(String(quota.json<any>().message))) throw new Error(`quota offers an upgrade: ${quota.json<any>().message}`);
    });
    await ctx.step("a workspace key of the account → 403/409, never a second project in it", async () => {
      const minted = await owner.post(`/v1/workspaces/${first.id}/tokens`, { name: "proj41-key", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
      minted.status(201);
      const key = ctx.client.withBearer(minted.json<{ secret_key: string }>().secret_key, "PROJ41_KEY");
      const r = await key.post("/v1/projects", body());
      r.status([403, 409]);
      if (r.statusCode === 409) r.body().has("$.code", "workspace_has_project").has("$.workspace_id", first.id);
    });
    await ctx.step("a paid plan does not change the rule → the same answers, /quota still capped", async () => {
      await fundDatabaseAccount(ctx.env, team.id);
      await personCreate();
      (await owner.get("/v1/projects/quota", { query: { account_id: team.id } })).status(200).body().has("$.capped", true);
    });
    await ctx.step("deleting the one project closes the workspace (K2) → a create into it → 403 workspace_closed, never a second project", async () => {
      (await owner.del("/v1/workspaces/:projectId", { params: { projectId: first.id } })).status(200);
      (await owner.post("/v1/projects", body())).status(403).body().has("$.code", "workspace_closed");
    });
  },
);

// PROJ-49 — the published `kortix ship` BYO shape: POST
// /v1/projects/link-repository with `account_id` of the occupied account and
// no new_workspace flag. A person never meets 409 workspace_has_project; the
// new workspace is created only after GitHub accepts the repository, so a
// token GitHub refuses (400) and a missing App installation (409 install_url)
// create no account. The local profile has no GitHub: the 201 path is proved
// against a fake GitHub in byo-new-workspace.integration.test.ts.
flow(
  "PROJ-49",
  {
    domain: "projects",
    requires: ["database"],
    routes: ["POST /v1/projects/link-repository", "GET /v1/accounts", "POST /v1/workspaces/:workspaceId/tokens"],
  },
  async (ctx) => {
    if (ctx.env.target !== "local") return;
    const team = await ctx.fixtures.team();
    const w = await team.project();
    const owner = ctx.client.as(ctx.P.OWNER);
    const shipBody = (token?: string) => ({
      repo_url: "https://github.com/example-org/ship-probe",
      name: ctx.fixtures.name("ship-probe"),
      account_id: team.id,
      ...(token ? { github_token: token } : {}),
    });
    // Only the accounts this link would create (a new workspace is named after
    // its project): other flows create accounts for OWNER concurrently.
    const probeName = shipBody().name;
    const accountIds = async () =>
      (await owner.get("/v1/accounts")).status(200).json<Array<{ account_id: string; name?: string }>>()
        .filter((a) => a.name === probeName).map((a) => a.account_id).sort();
    await ctx.step("kortix ship --github-token with a token GitHub refuses → 400 from validation, never workspace_has_project, no account created", async () => {
      const before = await accountIds();
      const r = await owner.post("/v1/projects/link-repository", shipBody("ghp_synthetic_refused"));
      r.status(400);
      if (r.json<{ code?: string }>().code === "workspace_has_project") throw new Error("a person got workspace_has_project");
      if ((await accountIds()).join() !== before.join()) throw new Error("a refused link created an account");
    });
    await ctx.step("kortix ship through the GitHub App, not installed → 409 install_url (the CLI's retry prompt), no account created", async () => {
      const before = await accountIds();
      const r = await owner.post("/v1/projects/link-repository", shipBody());
      expectInstallPrompt(r);
      if (r.json<{ code?: string }>().code === "workspace_has_project") throw new Error("a person got workspace_has_project");
      if ((await accountIds()).join() !== before.join()) throw new Error("an install prompt created an account");
    });
    await ctx.step("a workspace key of the account → 403/409 workspace_has_project, nothing created", async () => {
      const minted = await owner.post(`/v1/workspaces/${w.id}/tokens`, { name: "proj49-key", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
      minted.status(201);
      const key = ctx.client.withBearer(minted.json<{ secret_key: string }>().secret_key, "PROJ49_KEY");
      const r = await key.post("/v1/projects/link-repository", shipBody("ghp_synthetic_refused"));
      r.status([403, 409]);
      if (r.statusCode === 409) r.body().has("$.code", "workspace_has_project");
    });
  },
);

// PROJ-48 — the published CLI (<= 0.14) names its active account on
// `kortix projects create` and `kortix ship`. On the legacy provision route a
// person naming an occupied account they may create in gets a new workspace,
// never the 409; a workspace key never does. The local profile has no managed
// Git, so the new workspace stops at 503 there; PROJ-18 proves the 201.
flow(
  "PROJ-48",
  {
    domain: "projects",
    routes: ["POST /v1/projects/provision", "POST /v1/workspaces/:workspaceId/tokens"],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const w = await team.project();
    const owner = ctx.client.as(ctx.P.OWNER);
    await ctx.step("the owner names the occupied account in the body and the query → never 409 workspace_has_project", async () => {
      const r = await owner.post("/v1/projects/provision", { name: ctx.fixtures.name("cli-compat"), account_id: team.id }, { query: { account_id: team.id } });
      if (r.statusCode === 409) throw new Error(`409: ${r.text().slice(0, 300)}`);
      if (r.statusCode === 201) {
        ctx.track("project", r.json<any>().project_id);
        if (r.json<any>().account_id === team.id) throw new Error("the new project landed in the occupied account");
      } else {
        r.status(503);
      }
    });
    await ctx.step("a workspace key of the account names it → 403, nothing is created", async () => {
      const minted = await owner.post(`/v1/workspaces/${w.id}/tokens`, { name: "proj48-key", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
      minted.status(201);
      const key = ctx.client.withBearer(minted.json<{ secret_key: string }>().secret_key, "PROJ48_KEY");
      (await key.post("/v1/projects/provision", { name: ctx.fixtures.name("cli-compat-key"), account_id: team.id })).status([403, 409]);
    });
  },
);

/**
 * PROJ-40 — deleting a workspace closes its side doors (KRTX-1714). The delete
 * archives the project, and the revoke routes answer 404 after it, so a door
 * that ignored `projects.status` stayed open for good: a public share link
 * kept resolving and a kgw_ key kept authorizing billed LLM calls.
 */
flow(
  "PROJ-40",
  {
    domain: "projects",
    requires: ["database"],
    routes: [
      "POST /v1/workspaces/:projectId/gateway/keys",
      "POST /v1/workspaces/:projectId/sessions/:sessionId/public-shares",
      "GET /v1/p/public-share/:token",
      "POST /v1/llm/chat/completions",
      "DELETE /v1/workspaces/:projectId",
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

    let key = "";
    let token = "";
    await ctx.step("the owner mints a kgw_ key and a public file link", async () => {
      const minted = await owner.post("/v1/workspaces/:projectId/gateway/keys", { name: "ci" }, { params });
      minted.status(200).body().exists("$.secret_key");
      key = minted.json<{ secret_key: string }>().secret_key;
      const share = await owner.post(
        "/v1/workspaces/:projectId/sessions/:sessionId/public-shares",
        { file: { path: "/workspace/notes.md" } },
        { params: { ...params, sessionId } },
      );
      share.status(201);
      token = share.json<{ share: { public_token: string } }>().share.public_token;
    });

    const gateway = () => new Client(ctx.env.gatewayUrl).withBearer(key, "PROJECT_GATEWAY_KEY");
    const ask = () => gateway().post("/v1/llm/chat/completions", { model: "kimi-k3", max_tokens: 1, messages: [] });

    await ctx.step("while the workspace is live: the gateway accepts the key and the link resolves", async () => {
      const r = await ask();
      if (r.statusCode === 401) throw new Error(`the live key was refused: ${r.text().slice(0, 200)}`);
      // A local database session has no sandbox, so the token edge answers its
      // honest 503 ("not ready") — the point is that it is never an auth error.
      (await anon.get("/v1/p/public-share/:token", { params: { token } })).status([200, 503]);
    });

    await ctx.step("the owner deletes the workspace", async () => {
      (await owner.del("/v1/workspaces/:projectId", { params })).status(200).body().has("$.archived", true);
    });

    await ctx.step("after the delete: the kgw_ key → 401 and the link → 410", async () => {
      (await ask()).status(401);
      (await anon.get("/v1/p/public-share/:token", { params: { token } })).status(410);
    });
  },
);
