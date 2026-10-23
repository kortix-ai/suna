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
  { domain: "files", tags: ["deployed", "smoke"], routes: ["GET /v1/projects/:projectId/files"] },
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
    await ctx.step("absolute, traversal and NUL-containing paths → 404 File not found", async () => {
      // No `../`: an edge WAF answers that itself (403) before the API sees it.
      for (const path of ["/workspace/AGENTS.md", "..", "ke2e/..", "\0", "\0a", "a\0b", "a\0"]) {
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

/**
 * FILE-13 — the Files tree lists every folder, however many files sort before
 * it (KRTX-1723). The recursive list stops at 1,000 files, and the tree built
 * from it lost every folder past file 1,000. `depth=1` lists one level,
 * complete; `limit`/`cursor` page it for "Load more"; the recursive list says
 * when it is cut; content search names the line of every match.
 */
flow(
  "FILE-13",
  {
    domain: "files",
    requires: ["database"],
    routes: [
      "GET /v1/projects/:projectId/files",
      "GET /v1/projects/:projectId/files/content",
      "GET /v1/projects/:projectId/files/search",
    ],
  },
  async (ctx) => {
    if (ctx.env.target !== "local") return;
    const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { execFileSync } = await import("node:child_process");
    const { Client: PgClient } = await import("pg");
    const project = await ctx.fixtures.project({ managedGit: true });
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { projectId: project.id };
    let repoUrl = "";
    let defaultBranch = "main";

    /** Clones `from`, lets `edit` change the work tree, commits, and pushes to `to`. */
    const pushCommit = async (from: string, to: string, message: string, edit: (work: string) => Promise<void>) => {
      const work = await mkdtemp(join(tmpdir(), "ke2e-file13-"));
      try {
        const git = (...args: string[]) => execFileSync("git", args, { cwd: work, stdio: "pipe" });
        git("clone", "-q", "--branch", from, repoUrl, ".");
        await edit(work);
        git("add", "-A");
        git("-c", "user.name=KE2E", "-c", "user.email=ke2e@kortix.invalid", "commit", "-q", "--allow-empty", "-m", message);
        git("push", "-q", "origin", `HEAD:refs/heads/${to}`);
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    };

    await ctx.step("the repository holds 1,200 files under a/ and one under z/", async () => {
      const databaseUrl = ctx.env.databaseUrl!;
      const db = new PgClient({
        connectionString: databaseUrl,
        ssl: /localhost|127\.0\.0\.1/.test(databaseUrl) ? false : { rejectUnauthorized: false },
      });
      await db.connect();
      const { rows } = await db.query("SELECT repo_url, default_branch FROM kortix.projects WHERE project_id = $1", [project.id]);
      await db.end();
      repoUrl = rows[0].repo_url;
      defaultBranch = rows[0].default_branch || "main";
      await pushCommit(defaultBranch, defaultBranch, "1,201 files", async (work) => {
        await mkdir(join(work, "a"));
        await mkdir(join(work, "z"));
        for (let i = 0; i < 1200; i++) await writeFile(join(work, "a", `f${String(i).padStart(4, "0")}.txt`), `${i}\n`);
        await writeFile(join(work, "z", "last.txt"), "last\n");
      });
    });

    await ctx.step("depth=1 at the root lists every top-level folder and file", async () => {
      const r = await owner.get("/v1/projects/:projectId/files", { params, query: { depth: "1" } });
      r.status(200).body().has("$.truncated", false);
      const entries = r.json<{ entries: Array<{ path: string; type: string }> }>().entries;
      const want = [{ path: "a", type: "directory" }, { path: "z", type: "directory" }, { path: "README.md", type: "file" }];
      for (const entry of want) {
        if (!entries.some((e) => e.path === entry.path && e.type === entry.type)) throw new Error(`root lacks ${entry.path}`);
      }
    });

    await ctx.step("depth=1 without limit or cursor lists a 1,200-file folder whole with next_cursor null, and the folder that sorts after it", async () => {
      const a = await owner.get("/v1/projects/:projectId/files", { params, query: { path: "a", depth: "1" } });
      a.status(200).body().has("$.truncated", false).has("$.next_cursor", null);
      if (a.json<{ entries: unknown[] }>().entries.length !== 1200) throw new Error("a/ is not complete");
      const z = await owner.get("/v1/projects/:projectId/files", { params, query: { path: "z", depth: "1" } });
      z.status(200).body().has("$.entries[0].path", "z/last.txt");
    });

    let firstCursor = "";
    await ctx.step("limit=500 walks a/ as 500 + 500 + 200 pages, every name once, and the last page has next_cursor null", async () => {
      type Page = { entries: Array<{ path: string }>; truncated: boolean; next_cursor: string | null };
      const sizes: number[] = [];
      const names: string[] = [];
      let cursor: string | null = null;
      do {
        const r = await owner.get("/v1/projects/:projectId/files", {
          params,
          query: { path: "a", depth: "1", limit: "500", ...(cursor ? { cursor } : {}) },
        });
        r.status(200);
        const page = r.json<Page>();
        if (page.truncated !== (page.next_cursor !== null)) throw new Error("truncated disagrees with next_cursor");
        if (!firstCursor && page.next_cursor) firstCursor = page.next_cursor;
        sizes.push(page.entries.length);
        names.push(...page.entries.map((e) => e.path));
        cursor = page.next_cursor;
      } while (cursor && sizes.length < 10);
      if (sizes.join(",") !== "500,500,200") throw new Error(`pages of ${sizes.join(",")}, want 500,500,200`);
      const want = Array.from({ length: 1200 }, (_, i) => `a/f${String(i).padStart(4, "0")}.txt`);
      if (names.join("\n") !== want.join("\n")) throw new Error("the pages do not list every name of a/ once, in order");
    });

    await ctx.step("a push between pages skips or repeats nothing: the later pages read the commit the first page read", async () => {
      type Page = { entries: Array<{ path: string }>; next_cursor: string | null };
      // A branch of its own: a read at an explicit branch fetches a push at
      // once (FILE-11), so the API sees the second commit before page 2.
      const branch = "file13-pages";
      await pushCommit(defaultBranch, branch, "the 1,200 files", async () => {});
      const first = await owner.get("/v1/projects/:projectId/files", {
        params,
        query: { path: "a", depth: "1", limit: "500", ref: branch },
      });
      first.status(200);
      const names = first.json<Page>().entries.map((e) => e.path);
      let cursor = first.json<Page>().next_cursor;
      if (!cursor) throw new Error("page 1 of a/ has no next_cursor");

      // One file added before the cursor, one after it, and one removed after it.
      await pushCommit(branch, branch, "change a/ between pages", async (work) => {
        await rm(join(work, "a", "f0700.txt"));
        await writeFile(join(work, "a", "f0100x.txt"), "x\n");
        await writeFile(join(work, "a", "f0600x.txt"), "x\n");
      });
      // The API reads the new commit: the added file reads back at the branch.
      (await owner.get("/v1/projects/:projectId/files/content", { params, query: { path: "a/f0600x.txt", ref: branch } })).status(200);

      for (let pages = 1; cursor && pages < 10; pages++) {
        const r = await owner.get("/v1/projects/:projectId/files", {
          params,
          query: { path: "a", depth: "1", limit: "500", ref: branch, cursor },
        });
        r.status(200);
        names.push(...r.json<Page>().entries.map((e) => e.path));
        cursor = r.json<Page>().next_cursor;
      }
      const want = Array.from({ length: 1200 }, (_, i) => `a/f${String(i).padStart(4, "0")}.txt`);
      if (names.join("\n") !== want.join("\n")) throw new Error("the pages after a push do not list the first page's commit exactly");

      // A new walk reads the new commit.
      const fresh = await owner.get("/v1/projects/:projectId/files", { params, query: { path: "a", depth: "1", ref: branch } });
      fresh.status(200);
      const now = fresh.json<Page>().entries.map((e) => e.path);
      if (now.length !== 1201 || !now.includes("a/f0600x.txt") || now.includes("a/f0700.txt")) {
        throw new Error(`a new listing of ${branch} does not show the pushed commit`);
      }
    });

    await ctx.step("limit=0, limit=2001, a garbage cursor and a cursor of another folder → 400", async () => {
      const bad = [
        { path: "a", depth: "1", limit: "0" },
        { path: "a", depth: "1", limit: "2001" },
        { path: "a", depth: "1", cursor: "garbage" },
        { path: "z", depth: "1", cursor: firstCursor },
      ];
      for (const query of bad) {
        const r = await owner.get("/v1/projects/:projectId/files", { params, query });
        r.status(400);
      }
    });

    await ctx.step("content search reads back the path, line number and line text of a match", async () => {
      const r = await owner.get("/v1/projects/:projectId/files/search", { params, query: { q: "last", content: "1" } });
      r.status(200).body().has("$.content_search", true);
      const results = r.json<{ results: Array<{ path: string; line_number?: number; line_text?: string }> }>().results;
      const match = results.find((m) => m.path === "z/last.txt");
      if (match?.line_number !== 1 || match.line_text !== "last") {
        throw new Error(`z/last.txt match is ${JSON.stringify(match)}, want line 1 "last"`);
      }
    });

    await ctx.step("the recursive list is cut at 1,000 and says so", async () => {
      const r = await owner.get("/v1/projects/:projectId/files", { params });
      r.status(200);
      if (r.json<unknown[]>().length !== 1000) throw new Error(`recursive list returned ${r.json<unknown[]>().length}`);
      if (r.header("x-kortix-truncated") !== "1") throw new Error("the cut list carries no X-Kortix-Truncated");
    });

    await ctx.step("without depth, limit and cursor are ignored as before: limit=5000 and a garbage cursor → 200, 1,000 files", async () => {
      const r = await owner.get("/v1/projects/:projectId/files", { params, query: { limit: "5000", cursor: "garbage" } });
      r.status(200);
      if (r.json<unknown[]>().length !== 1000) throw new Error(`recursive list returned ${r.json<unknown[]>().length}`);
    });
  },
);

flow('FILE-14', { domain: 'files', routes: ['GET /v1/projects/:projectId/files/content', 'PUT /v1/projects/:projectId/files/content'] }, async (ctx) => {
  const p = await ctx.fixtures.sharedProject();
  const params = { projectId: p.id };
  const owner = ctx.client.as(ctx.P.OWNER);
  const read = await owner.get('/v1/projects/:projectId/files/content', { params, query: { path: 'README.md' } });
  read.status(200);
  const original = read.json<{ ref: string; content: string; revision: string }>();
  const body = { path: 'README.md', ref: original.ref, content: original.content + '\nowner file edit regression\n', expected_revision: original.revision };
  await ctx.step('owner commits a viewed file and reads the persisted edit', async () => {
    (await owner.put('/v1/projects/:projectId/files/content', body, { params })).status(200).body().exists('$.commit_sha');
    const after = await owner.get('/v1/projects/:projectId/files/content', { params, query: { path: body.path } });
    after.status(200).body().has('$.content', body.content);
  });
  await ctx.step('stale revision cannot overwrite the committed edit', async () => {
    (await owner.put('/v1/projects/:projectId/files/content', body, { params })).status(409);
  });
  await ctx.step('anonymous and unrelated users cannot commit', async () => {
    (await ctx.client.as(ctx.P.ANON).put('/v1/projects/:projectId/files/content', body, { params })).status(401);
    (await ctx.client.as(ctx.P.NONMEMBER).put('/v1/projects/:projectId/files/content', body, { params })).status([403, 404]);
  });
});
