/**
 * Files / commits / branches — read-only git surface over a provisioned repo.
 * Maps to spec §13 (FILE-1..FILE-10). Each flow uses a real freshly-provisioned
 * project (ctx.fixtures.sharedProject()) which has an initial commit on its default
 * branch, so the git helpers operate on real data — we chain off the live
 * commit list to exercise commits/:sha and commits/:sha/diff.
 */
import { flow } from "../core/flow";

flow(
  "FILE-1",
  { domain: "files", tags: ["smoke"], routes: ["GET /v1/projects/:projectId/files"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("OWNER lists repo tree → 200 array", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/projects/:projectId/files", { params: { projectId: p.id } });
      r.status(200).body().exists("$");
    });
    await ctx.step("NONMEMBER → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/projects/:projectId/files", { params: { projectId: p.id } });
      r.status([403, 404]);
    });
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/projects/:projectId/files", { params: { projectId: p.id } });
      r.status(401);
    });
  },
);

flow(
  "FILE-2",
  { domain: "files", routes: ["GET /v1/projects/:projectId/files/content"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    // Discover a real file path from the tree so content fetch hits live data.
    const tree = await ctx.client
      .as(ctx.P.OWNER)
      .get("/v1/projects/:projectId/files", { params: { projectId: p.id } });
    const entries = tree.json<Array<{ path: string; type?: string }>>() ?? [];
    const firstFile = entries.find((e) => e && e.type !== "tree" && e.type !== "dir" && e.path);

    await ctx.step("absent path param → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/files/content", { params: { projectId: p.id } });
      r.status(400);
    });
    if (firstFile) {
      await ctx.step("known file path → 200 with content", async () => {
        const r = await ctx.client
          .as(ctx.P.OWNER)
          .get("/v1/projects/:projectId/files/content", {
            params: { projectId: p.id },
            query: { path: firstFile.path },
          });
        r.status(200).body().has("$.path", firstFile.path).exists("$.content");
      });
    }
    await ctx.step("a path the repository does not hold → 404 File not found, never a 500", async () => {
      (await ctx.client.as(ctx.P.OWNER).get("/v1/projects/:projectId/files/content", { params: { projectId: p.id }, query: { path: "ke2e-no-such-file.txt" } }))
        .status(404).body().has("$.error", "File not found");
    });
    await ctx.step("absolute and traversal paths → 404 File not found", async () => {
      for (const path of ["/workspace/AGENTS.md", "../etc/passwd"]) {
        (await ctx.client.as(ctx.P.OWNER).get("/v1/projects/:projectId/files/content", { params: { projectId: p.id }, query: { path } }))
          .status(404).body().has("$.error", "File not found");
      }
    });
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/projects/:projectId/files/content", {
          params: { projectId: p.id },
          query: { path: "README.md" },
        });
      r.status(401);
    });
  },
);

flow(
  "FILE-3",
  { domain: "files", routes: ["GET /v1/projects/:projectId/files/search"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("absent q param → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/files/search", { params: { projectId: p.id } });
      r.status(400);
    });
    await ctx.step("filename search → 200 with results array", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/files/search", {
          params: { projectId: p.id },
          query: { q: "." },
        });
      r.status(200).body().has("$.content_search", false).exists("$.results");
    });
    await ctx.step("content grep (content=1) → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/files/search", {
          params: { projectId: p.id },
          query: { q: "a", content: "1" },
        });
      r.status(200).body().has("$.content_search", true).exists("$.results");
    });
    await ctx.step("NONMEMBER → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/projects/:projectId/files/search", {
          params: { projectId: p.id },
          query: { q: "x" },
        });
      r.status([403, 404]);
    });
  },
);

flow(
  "FILE-4",
  { domain: "files", routes: ["GET /v1/projects/:projectId/files/history"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("absent path param → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/files/history", { params: { projectId: p.id } });
      r.status(400);
    });
    await ctx.step("history for a path → 200 (or 400 if path unknown to git)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/files/history", {
          params: { projectId: p.id },
          query: { path: "README.md" },
        });
      r.status([200, 400]);
    });
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/projects/:projectId/files/history", {
          params: { projectId: p.id },
          query: { path: "README.md" },
        });
      r.status(401);
    });
  },
);

flow(
  "FILE-5",
  { domain: "files", routes: ["GET /v1/projects/:projectId/files/archive"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("repo archive (no path) → 200 workspace.zip", async () => {
      (await ctx.client.as(ctx.P.OWNER).get("/v1/projects/:projectId/files/archive", { params: { projectId: p.id } }))
        .status(200)
        .headerEquals("content-type", "application/zip")
        .headerEquals("content-disposition", 'attachment; filename="workspace.zip"');
    });
    await ctx.step("an absolute archive path → 400 Invalid path", async () => {
      (await ctx.client.as(ctx.P.OWNER).get("/v1/projects/:projectId/files/archive", { params: { projectId: p.id }, query: { path: "/workspace" } }))
        .status(400).body().has("$.error", "Invalid path");
    });
    await ctx.step("NONMEMBER → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/projects/:projectId/files/archive", { params: { projectId: p.id } });
      r.status([403, 404]);
    });
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/projects/:projectId/files/archive", { params: { projectId: p.id } });
      r.status(401);
    });
  },
);

flow(
  "FILE-6",
  { domain: "files", tags: ["smoke"], routes: ["GET /v1/projects/:projectId/branches"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedSeededProject();
    await ctx.step("OWNER lists seeded default branch → 200 with remote tip", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/branches", { params: { projectId: p.id } });
      const body = r.json<{ default_branch: string }>();
      r.status(200)
        .body()
        .exists("$.default_branch")
        .has("$.branches[0].name", body.default_branch)
        .has("$.branches[0].is_default", true)
        .exists("$.branches[0].tip");
    });
    await ctx.step("NONMEMBER → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/projects/:projectId/branches", { params: { projectId: p.id } });
      r.status([403, 404]);
    });
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/projects/:projectId/branches", { params: { projectId: p.id } });
      r.status(401);
    });
  },
);

flow(
  "FILE-7",
  {
    domain: "files",
    tags: ["smoke"],
    routes: [
      "GET /v1/projects/:projectId/commits",
      "GET /v1/projects/:projectId/commits/:sha",
      "GET /v1/projects/:projectId/commits/:sha/diff",
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();

    let headSha: string | undefined;
    await ctx.step("OWNER lists commits → 200 with commits[] (or 400 if the managed mirror has no readable history yet)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/commits", { params: { projectId: p.id } });
      r.status([200, 400]);
      if (r.statusCode === 200) {
        r.body().exists("$.commits");
        const body = r.json<{ commits?: Array<{ hash?: string; sha?: string }> }>();
        const head = body?.commits?.[0];
        headSha = head?.sha ?? head?.hash;
      }
    });

    await ctx.step("commits/:sha for HEAD → 200 with files[]", async () => {
      if (!headSha) {
        // Repo had no readable commit list (mirror unavailable in this env);
        // nothing real to chain off — skip the positive assertion.
        return;
      }
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/commits/:sha", {
          params: { projectId: p.id, sha: headSha },
        });
      // Initial (parentless) commit may 400 when computing changed files.
      r.status([200, 400]);
      if (r.statusCode === 200) r.body().exists("$.files");
    });

    await ctx.step("commits/:sha bogus hash → 400/404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/commits/:sha", {
          params: { projectId: p.id, sha: "0000000000000000000000000000000000000000" },
        });
      r.status([400, 404]);
    });

    await ctx.step("commits/:sha/diff for HEAD → 200 with patch (or 400 for the parentless initial commit)", async () => {
      if (!headSha) return;
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/commits/:sha/diff", {
          params: { projectId: p.id, sha: headSha },
        });
      // A fresh repo's only commit is the initial (parentless) commit; diffing it
      // can return 400 (no parent to diff against). Accept both.
      r.status([200, 400]);
      if (r.statusCode === 200) r.body().exists("$.patch");
    });

    await ctx.step("commits/:sha/diff bogus hash → 400/404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/commits/:sha/diff", {
          params: { projectId: p.id, sha: "0000000000000000000000000000000000000000" },
        });
      r.status([400, 404]);
    });

    await ctx.step("commits NONMEMBER → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/projects/:projectId/commits", { params: { projectId: p.id } });
      r.status([403, 404]);
    });
    await ctx.step("commits ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/projects/:projectId/commits", { params: { projectId: p.id } });
      r.status(401);
    });
  },
);

flow(
  "FILE-11",
  {
    domain: "files",
    routes: ["GET /v1/projects/:projectId/files", "GET /v1/projects/:projectId/files/content", "GET /v1/projects/:projectId/files/archive"],
  },
  async (ctx) => {
    if (ctx.env.target !== "local") return; // deployed pushes go through the git proxy; local pushes hit the bare repo
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { Client: PgClient } = await import("pg");
    const p = await ctx.fixtures.sharedProject();
    const owner = ctx.client.as(ctx.P.OWNER);
    const db = new PgClient({ connectionString: ctx.env.databaseUrl! });
    await db.connect();
    const work = mkdtempSync(join(tmpdir(), "ke2e-file11-"));
    try {
      const { rows } = await db.query("SELECT repo_url, default_branch FROM kortix.projects WHERE project_id = $1", [p.id]);
      const repoUrl = String(rows[0]?.repo_url ?? "");
      const base = String(rows[0]?.default_branch || "main");
      const branch = `ke2e-fresh-${Date.now().toString(36)}`;
      await ctx.step("warm the mirror with a default-branch read", async () => {
        (await owner.get("/v1/projects/:projectId/files", { params: { projectId: p.id } })).status(200);
      });
      await ctx.step("push a new branch straight to the repository, then read it at that ref at once → 200 + listed", async () => {
        const git = (...a: string[]) => execFileSync("git", a, { cwd: work, stdio: "pipe" });
        git("clone", "-q", "--branch", base, repoUrl, ".");
        git("checkout", "-q", "-b", branch);
        writeFileSync(join(work, "fresh.txt"), "pushed just now\n");
        mkdirSync(join(work, "docs"));
        writeFileSync(join(work, "docs/guide.md"), "guide\n");
        git("add", "-A");
        git("-c", "user.name=KE2E", "-c", "user.email=ke2e@kortix.invalid", "commit", "-qm", "fresh");
        git("push", "-q", "origin", `HEAD:refs/heads/${branch}`);
        const read = await owner.get("/v1/projects/:projectId/files/content", {
          params: { projectId: p.id },
          query: { path: "fresh.txt", ref: branch },
        });
        read.status(200).body().has("$.content", "pushed just now\n");
        const list = await owner.get("/v1/projects/:projectId/files", { params: { projectId: p.id }, query: { ref: branch } });
        list.status(200);
        if (!list.json<Array<{ path: string }>>().some((e) => e.path === "fresh.txt")) throw new Error("fresh.txt missing from the branch listing");
      });
      await ctx.step("list and archive a subtree at that ref → only its files; a zip named after the folder", async () => {
        const list = await owner.get("/v1/projects/:projectId/files", { params: { projectId: p.id }, query: { ref: branch, path: "docs" } });
        list.status(200);
        const paths = list.json<Array<{ path: string }>>().map((e) => e.path);
        if (!paths.some((x) => x.endsWith("guide.md")) || paths.some((x) => x.endsWith("fresh.txt"))) throw new Error(`subtree listing: ${JSON.stringify(paths)}`);
        (await owner.get("/v1/projects/:projectId/files/archive", { params: { projectId: p.id }, query: { ref: branch, path: "docs" } }))
          .status(200)
          .headerEquals("content-type", "application/zip")
          .headerEquals("content-disposition", 'attachment; filename="docs.zip"');
      });
      await ctx.step("an unknown branch → 404", async () => {
        const r = await owner.get("/v1/projects/:projectId/files/content", {
          params: { projectId: p.id },
          query: { path: "fresh.txt", ref: "ke2e-no-such-branch" },
        });
        r.status(404);
      });
    } finally {
      rmSync(work, { recursive: true, force: true });
      await db.end();
    }
  },
);

flow(
  "FILE-12",
  { domain: "files", routes: ["GET /v1/projects/:projectId/files/raw"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    const tree = await ctx.client
      .as(ctx.P.OWNER)
      .get("/v1/projects/:projectId/files", { params: { projectId: p.id } });
    const entries = tree.json<Array<{ path: string; type?: string }>>() ?? [];
    const firstFile = entries.find((e) => e && e.type !== "tree" && e.type !== "dir" && e.path);

    await ctx.step("absent path param → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/files/raw", { params: { projectId: p.id } });
      r.status(400);
    });
    if (firstFile) {
      await ctx.step("known file path → 200 whose bytes decode to the content read", async () => {
        const raw = await ctx.client
          .as(ctx.P.OWNER)
          .get("/v1/projects/:projectId/files/raw", {
            params: { projectId: p.id },
            query: { path: firstFile.path },
          });
        raw.status(200);
        const text = await ctx.client
          .as(ctx.P.OWNER)
          .get("/v1/projects/:projectId/files/content", {
            params: { projectId: p.id },
            query: { path: firstFile.path },
          });
        text.status(200);
        // The byte route and the string route answer the same text file.
        if (raw.text() !== text.json<{ content: string }>().content) {
          throw new Error("raw bytes do not match the content read");
        }
      });
    }
    await ctx.step("a missing path → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/files/raw", {
          params: { projectId: p.id },
          query: { path: "ke2e-no-such-file.bin" },
        });
      r.status(404);
    });
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/projects/:projectId/files/raw", {
          params: { projectId: p.id },
          query: { path: "README.md" },
        });
      r.status(401);
    });
  },
);
