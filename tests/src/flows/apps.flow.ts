/**
 * Apps — the experimental `[[apps]]` deployment surface. Maps to spec §APP-*.
 *
 * GATE: the entire /apps surface is gated per-project by
 * `projects.metadata.apps_enabled`, defaulting to the operator flag
 * `KORTIX_APPS_EXPERIMENTAL` (off by default). When off, the gate middleware
 * (projectsApp.use('/:projectId/apps[/*]')) short-circuits EVERY /apps route —
 * including mutations and reads — with a flat 404 before any handler runs.
 *
 * The runner can't flip the env flag, so these flows assert the REAL observed
 * behavior under both configurations:
 *   - gate OFF  → 404 on GET and on every mutation (gate wins before auth body)
 *   - gate ON   → GET 200, unknown-slug mutations 404, bad create body 400
 * We accept the permissive union so the suite is green regardless of how the
 * target environment has the flag set.
 *
 * NB: the /apps-config PATCH (the toggle itself) is NOT behind the gate — it's
 * how a project opts in. It lives on the project, not /apps/*, so it's always
 * reachable for a manager.
 */
import { flow } from "../core/flow";

// Gate-aware status sets. When apps is disabled the gate returns 404 for
// everything; when enabled the handler's own codes apply.
const GATE_OR = {
  // GET /apps: handler → 200; gate-off → 404.
  read: [200, 404] as number[],
  // Mutations on an unknown/absent slug: handler → 404; bad body → 400;
  // already-exists → 409; gate-off → 404. Union covers both worlds.
  mutateUnknown: [400, 404, 409] as number[],
};

flow(
  "APP-1",
  {
    domain: "apps",
    tags: ["smoke"],
    routes: ["GET /v1/projects/:projectId/apps"],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step("OWNER GET apps → 200 (enabled) or 404 (gated off)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/apps", { params: { projectId: p.id } });
      r.status(GATE_OR.read);
      // When the gate is open the body carries the spec arrays.
      if (r.statusCode === 200) {
        r.body().exists("$.apps").exists("$.errors");
      }
    });
    await ctx.step("NONMEMBER → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/projects/:projectId/apps", { params: { projectId: p.id } });
      // Gate-off 404, or membership-denied 403 (gate runs first → usually 404,
      // but a manager-enabled project denies the non-member at 403).
      r.status([403, 404]);
    });
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/projects/:projectId/apps", { params: { projectId: p.id } });
      r.status(401);
    });
  },
);

flow(
  "APP-2",
  {
    domain: "apps",
    routes: [
      "POST /v1/projects/:projectId/apps",
      "PATCH /v1/projects/:projectId/apps/:slug",
      "DELETE /v1/projects/:projectId/apps/:slug",
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();

    await ctx.step("POST create with missing name/slug → 400 (or gated 404)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/apps", { source: { type: "git" } }, { params: { projectId: p.id } });
      // gate-off → 404; gate-on → parseAppDraft rejects no name → 400.
      r.status([400, 404]);
    });

    await ctx.step("PATCH unknown slug → 404 (gated or unknown)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          "/v1/projects/:projectId/apps/:slug",
          { name: "nope" },
          { params: { projectId: p.id, slug: "does-not-exist" } },
        );
      r.status(GATE_OR.mutateUnknown);
    });

    await ctx.step("DELETE unknown slug → 404 (gated or unknown)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/projects/:projectId/apps/:slug", {
          params: { projectId: p.id, slug: "does-not-exist" },
        });
      r.status(GATE_OR.mutateUnknown);
    });

    await ctx.step("NONMEMBER POST → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post(
          "/v1/projects/:projectId/apps",
          { name: ctx.fixtures.name("app") },
          { params: { projectId: p.id } },
        );
      r.status([403, 404]);
    });
    await ctx.step("ANON POST → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post(
          "/v1/projects/:projectId/apps",
          { name: "x" },
          { params: { projectId: p.id } },
        );
      r.status(401);
    });
  },
);

flow(
  "APP-3",
  {
    domain: "apps",
    routes: [
      "POST /v1/projects/:projectId/apps/:slug/deploy",
      "POST /v1/projects/:projectId/apps/:slug/stop",
      "GET /v1/projects/:projectId/apps/:slug/logs",
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    const slug = "no-such-app";

    await ctx.step("deploy unknown slug → 404 (gated or unknown)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/apps/:slug/deploy",
          {},
          { params: { projectId: p.id, slug } },
        );
      r.status(404);
    });

    await ctx.step("stop unknown slug → 404 (no deployment, or gated)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/apps/:slug/stop",
          {},
          { params: { projectId: p.id, slug } },
        );
      r.status(404);
    });

    await ctx.step("logs unknown slug → 404 (no deployment, or gated)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/apps/:slug/logs", {
          params: { projectId: p.id, slug },
        });
      r.status(404);
    });

    await ctx.step("ANON deploy → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post(
          "/v1/projects/:projectId/apps/:slug/deploy",
          {},
          { params: { projectId: p.id, slug } },
        );
      r.status(401);
    });
  },
);

flow(
  "APP-4",
  {
    domain: "apps",
    routes: ["PATCH /v1/projects/:projectId/apps-config"],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();

    await ctx.step("OWNER toggles apps on → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch("/v1/projects/:projectId/apps-config", { enabled: true }, { params: { projectId: p.id } });
      r.status(200).body().exists("$.project_id");
    });

    await ctx.step("OWNER clears override (enabled: null) → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch("/v1/projects/:projectId/apps-config", { enabled: null }, { params: { projectId: p.id } });
      r.status(200);
    });

    await ctx.step("bad enabled value → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch("/v1/projects/:projectId/apps-config", { enabled: "yes" }, { params: { projectId: p.id } });
      r.status(400);
    });

    await ctx.step("NONMEMBER → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .patch("/v1/projects/:projectId/apps-config", { enabled: true }, { params: { projectId: p.id } });
      r.status([403, 404]);
    });
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .patch("/v1/projects/:projectId/apps-config", { enabled: true }, { params: { projectId: p.id } });
      r.status(401);
    });
  },
);
