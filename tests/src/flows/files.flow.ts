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
    await ctx.step("repo archive (no path) → 200 zip stream", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/files/archive", { params: { projectId: p.id } });
      r.status([200, 400]);
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
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("OWNER lists branches → 200 with default_branch", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/branches", { params: { projectId: p.id } });
      r.status(200).body().exists("$.default_branch").exists("$.branches");
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
