/**
 * Shared filesystems — the "Google Drive between the agents" (spec FS-1..FS-4).
 *
 * Black-box over the real HTTP surface: every assertion below is a status code
 * or a response field, and the write flows read their bytes back rather than
 * trusting the write's own 201. A filesystem whose PUT reports success and
 * whose GET returns different bytes is the failure this is built to catch.
 */
import { flow } from "../core/flow";

const FS_ROUTES = {
  list: "/v1/projects/:projectId/filesystems",
  create: "/v1/projects/:projectId/filesystems",
  drop: "/v1/projects/:projectId/filesystems/:name",
  files: "/v1/projects/:projectId/filesystems/:name/files",
  file: "/v1/projects/:projectId/filesystems/:name/files/:path",
} as const;

/** Unique per run so a re-run never collides with its own leftovers. */
const uniqueName = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

flow(
  "FS-1",
  {
    domain: "filesystems",
    tags: ["smoke"],
    routes: [
      "POST /v1/projects/:projectId/filesystems",
      "GET /v1/projects/:projectId/filesystems",
      "DELETE /v1/projects/:projectId/filesystems/:name",
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    const name = uniqueName("notes");

    await ctx.step("OWNER creates a filesystem → 201 with its name", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(FS_ROUTES.create, { name, description: "shared state" }, { params: { projectId: p.id } });
      r.status(201).body().exists("$.filesystem_id");
      const body = r.json<{ name: string; description: string | null }>();
      if (body?.name !== name) throw new Error(`expected name ${name}, got ${body?.name}`);
    });

    // Two agents racing to create the same shared volume must both succeed.
    await ctx.step("creating the same name again → 200, not a conflict", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(FS_ROUTES.create, { name }, { params: { projectId: p.id } });
      r.status(200);
    });

    await ctx.step("it appears in the project listing", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get(FS_ROUTES.list, { params: { projectId: p.id } });
      r.status(200);
      const body = r.json<{ filesystems: Array<{ name: string }> }>();
      if (!body?.filesystems?.some((f) => f.name === name)) {
        throw new Error(`created filesystem ${name} missing from listing`);
      }
    });

    await ctx.step("an invalid name → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(FS_ROUTES.create, { name: "has/slash" }, { params: { projectId: p.id } });
      r.status(400);
    });

    await ctx.step("NONMEMBER → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get(FS_ROUTES.list, { params: { projectId: p.id } });
      r.status([403, 404]);
    });

    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get(FS_ROUTES.list, { params: { projectId: p.id } });
      r.status(401);
    });

    await ctx.step("OWNER deletes it → 204, and it leaves the listing", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .request("DELETE", FS_ROUTES.drop, { params: { projectId: p.id, name } });
      r.status(204);
      const after = await ctx.client.as(ctx.P.OWNER).get(FS_ROUTES.list, { params: { projectId: p.id } });
      const body = after.json<{ filesystems: Array<{ name: string }> }>();
      if (body?.filesystems?.some((f) => f.name === name)) {
        throw new Error(`deleted filesystem ${name} still listed`);
      }
    });
  },
);

flow(
  "FS-2",
  {
    domain: "filesystems",
    tags: ["smoke"],
    routes: [
      "PUT /v1/projects/:projectId/filesystems/:name/files/:path",
      "GET /v1/projects/:projectId/filesystems/:name/files/:path",
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    const name = uniqueName("state");
    const path = "notes/2026/plan.md";
    const content = "# Plan\n\nhand this to the next agent.\n";

    await ctx.client.as(ctx.P.OWNER).post(FS_ROUTES.create, { name }, { params: { projectId: p.id } });

    await ctx.step("OWNER writes a file → 201 with size and sha256", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).put(FS_ROUTES.file, content, {
        params: { projectId: p.id, name, path },
        raw: true,
        headers: { "content-type": "text/markdown" },
      });
      r.status(201).body().exists("$.sha256");
      const body = r.json<{ size: number; path: string; storage: string }>();
      if (body?.size !== new TextEncoder().encode(content).byteLength) {
        throw new Error(`size ${body?.size} does not match the written bytes`);
      }
      if (body?.path !== path) throw new Error(`path came back as ${body?.path}`);
    });

    // The claim: what comes back is what went in. A PUT that 201s and a GET
    // that returns something else is exactly the bug this flow exists for.
    await ctx.step("GET returns the SAME bytes, its content-type and an etag", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get(FS_ROUTES.file, { params: { projectId: p.id, name, path } });
      r.status(200);
      if (r.text() !== content) throw new Error("bytes read back differ from bytes written");
      const ct = r.header("content-type") ?? "";
      if (!ct.includes("text/markdown")) throw new Error(`content-type was ${ct}`);
      if (!(r.header("etag") ?? "").includes('"')) throw new Error("etag missing");
    });

    await ctx.step("re-writing the same path → 200 (replace, not duplicate)", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).put(FS_ROUTES.file, `${content}v2\n`, {
        params: { projectId: p.id, name, path },
        raw: true,
        headers: { "content-type": "text/markdown" },
      });
      r.status(200);
      const read = await ctx.client
        .as(ctx.P.OWNER)
        .get(FS_ROUTES.file, { params: { projectId: p.id, name, path } });
      if (read.text() !== `${content}v2\n`) throw new Error("replace did not take effect");
    });

    await ctx.step("a path that was never written → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get(FS_ROUTES.file, { params: { projectId: p.id, name, path: "nope/missing.txt" } });
      r.status(404);
    });

    await ctx.step("ANON cannot read it → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get(FS_ROUTES.file, { params: { projectId: p.id, name, path } });
      r.status(401);
    });
  },
);

flow(
  "FS-3",
  {
    domain: "filesystems",
    routes: [
      "GET /v1/projects/:projectId/filesystems/:name/files",
      "DELETE /v1/projects/:projectId/filesystems/:name/files/:path",
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    const name = uniqueName("listing");
    await ctx.client.as(ctx.P.OWNER).post(FS_ROUTES.create, { name }, { params: { projectId: p.id } });

    const write = (path: string, body: string) =>
      ctx.client.as(ctx.P.OWNER).put(FS_ROUTES.file, body, {
        params: { projectId: p.id, name, path },
        raw: true,
        headers: { "content-type": "text/plain" },
      });

    await ctx.step("seed three paths, two under one prefix", async () => {
      await write("notes/a.txt", "a");
      await write("notes/b.txt", "b");
      await write("other.txt", "o");
    });

    await ctx.step("listing without a prefix returns all three", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get(FS_ROUTES.files, { params: { projectId: p.id, name } });
      r.status(200);
      const paths = (r.json<{ files: Array<{ path: string }> }>()?.files ?? []).map((f) => f.path);
      for (const expected of ["notes/a.txt", "notes/b.txt", "other.txt"]) {
        if (!paths.includes(expected)) throw new Error(`listing missed ${expected}`);
      }
    });

    await ctx.step("prefix narrows to that directory only", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get(FS_ROUTES.files, { params: { projectId: p.id, name }, query: { prefix: "notes" } });
      r.status(200);
      const paths = (r.json<{ files: Array<{ path: string }> }>()?.files ?? []).map((f) => f.path);
      if (paths.includes("other.txt")) throw new Error("prefix leaked a sibling path");
      if (!paths.includes("notes/a.txt")) throw new Error("prefix dropped a real match");
    });

    await ctx.step("DELETE removes exactly that path → 204, then 404", async () => {
      const del = await ctx.client
        .as(ctx.P.OWNER)
        .request("DELETE", FS_ROUTES.file, { params: { projectId: p.id, name, path: "notes/a.txt" } });
      del.status(204);
      const gone = await ctx.client
        .as(ctx.P.OWNER)
        .get(FS_ROUTES.file, { params: { projectId: p.id, name, path: "notes/a.txt" } });
      gone.status(404);
      // Content addressing shares blobs, so a delete must not take a sibling
      // with it.
      const sibling = await ctx.client
        .as(ctx.P.OWNER)
        .get(FS_ROUTES.file, { params: { projectId: p.id, name, path: "notes/b.txt" } });
      sibling.status(200);
    });
  },
);

flow(
  "FS-4",
  {
    domain: "filesystems",
    routes: ["PUT /v1/projects/:projectId/filesystems/:name/files/:path"],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    const name = uniqueName("guard");
    await ctx.client.as(ctx.P.OWNER).post(FS_ROUTES.create, { name }, { params: { projectId: p.id } });

    // Refused, never rewritten: an agent that asked for ../x must be told no,
    // not silently handed x — a different file than the one it named.
    for (const bad of ["../escape.txt", "a/../../escape.txt", "%2e%2e/escape.txt"]) {
      await ctx.step(`traversal ${bad} → 400`, async () => {
        const r = await ctx.client.as(ctx.P.OWNER).put(FS_ROUTES.file, "x", {
          params: { projectId: p.id, name, path: bad },
          raw: true,
          headers: { "content-type": "text/plain" },
        });
        r.status([400, 404]);
      });
    }

    await ctx.step("NONMEMBER cannot write → 403/404", async () => {
      const r = await ctx.client.as(ctx.P.NONMEMBER).put(FS_ROUTES.file, "x", {
        params: { projectId: p.id, name, path: "intruder.txt" },
        raw: true,
        headers: { "content-type": "text/plain" },
      });
      r.status([403, 404]);
    });

    await ctx.step("ANON cannot write → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).put(FS_ROUTES.file, "x", {
        params: { projectId: p.id, name, path: "intruder.txt" },
        raw: true,
        headers: { "content-type": "text/plain" },
      });
      r.status(401);
    });
  },
);
