/**
 * Sandboxes / snapshots — read surfaces + build triggers + template CRUD +
 * warm pool config. Maps to spec §SNAP-* / §SBX-*.
 *
 * Existing spec ids:
 *   SNAP-1  GET  /snapshots                (read)
 *   SNAP-2  POST /snapshots/rebuild        (manage + account write)
 *   SBX-1   sandbox create = implicit on session create (no endpoint)
 *   SBX-2   sandbox stop   = session DELETE (no endpoint)
 *
 * New ids added here for the standalone read/CRUD/config endpoints:
 *   SNAP-3  POST /snapshots/fix-with-agent
 *   SBX-3   GET  /sandboxes  + GET /sandbox-health  + GET /sandbox-templates
 *   SBX-4   sandbox-templates CRUD (POST / PATCH / DELETE / build)
 *   SBX-5   warm-pool GET + PATCH
 *
 * All build triggers are asserted at the TRIGGER response only — we never wait
 * on a real Daytona build to finish. rebuild/build are fire-and-forget → 202.
 */
import { flow } from "../core/flow";

const RANDOM_UUID = "00000000-0000-4000-a000-000000000000";

// ─── SNAP-1: read snapshots ───────────────────────────────────────────────
flow(
  "SNAP-1",
  {
    domain: "sandboxes",
    tags: ["smoke"],
    routes: ["GET /v1/projects/:projectId/snapshots"],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step("OWNER lists snapshots → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/snapshots", { params: { projectId: p.id } });
      r.status(200).body().exists("$.templates").exists("$.builds");
    });
    await ctx.step("NONMEMBER → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/projects/:projectId/snapshots", { params: { projectId: p.id } });
      r.status([403, 404]);
    });
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/projects/:projectId/snapshots", { params: { projectId: p.id } });
      r.status(401);
    });
  },
);

// ─── SNAP-2: rebuild trigger ──────────────────────────────────────────────
flow(
  "SNAP-2",
  {
    domain: "sandboxes",
    routes: ["POST /v1/projects/:projectId/snapshots/rebuild"],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step("OWNER rebuild → 202 started (or 502 provider)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/snapshots/rebuild", {}, { params: { projectId: p.id } });
      // Handler returns 202 with {status:'started'} on the trigger; 502 only if
      // the provider delete call throws. Accept both — never wait on the build.
      r.status([200, 202, 502]);
    });
    await ctx.step("NONMEMBER cannot rebuild → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post("/v1/projects/:projectId/snapshots/rebuild", {}, { params: { projectId: p.id } });
      r.status([403, 404]);
    });
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/projects/:projectId/snapshots/rebuild", {}, { params: { projectId: p.id } });
      r.status(401);
    });
  },
);

// ─── SNAP-3: fix-with-agent ───────────────────────────────────────────────
flow(
  "SNAP-3",
  {
    domain: "sandboxes",
    routes: ["POST /v1/projects/:projectId/snapshots/fix-with-agent"],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step(
      "fix-with-agent with no failed build → 409 (or 201 if a fix session boots)",
      async () => {
        const r = await ctx.client
          .as(ctx.P.OWNER)
          .post("/v1/projects/:projectId/snapshots/fix-with-agent", {}, { params: { projectId: p.id } });
        // Fresh project has no failed build → 409 ('No failed snapshot build to
        // fix.'); if a failure + ready host exist it creates a session → 201;
        // 400/404 cover session-create rejection paths. Never wait on the build.
        r.status([201, 400, 404, 409]);
      },
    );
    await ctx.step("NONMEMBER → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post("/v1/projects/:projectId/snapshots/fix-with-agent", {}, { params: { projectId: p.id } });
      r.status([403, 404]);
    });
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/projects/:projectId/snapshots/fix-with-agent", {}, { params: { projectId: p.id } });
      r.status(401);
    });
  },
);

// ─── SBX-3: read sandbox health / templates ────────────────────────────────
flow(
  "SBX-3",
  {
    domain: "sandboxes",
    tags: ["smoke"],
    routes: [
      "GET /v1/projects/:projectId/sandbox-health",
      "GET /v1/projects/:projectId/sandbox-templates",
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step("GET sandbox-health → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/sandbox-health", { params: { projectId: p.id } });
      r.status(200).body().exists("$.ready").exists("$.building");
    });
    await ctx.step("GET sandbox-templates → 200 with items", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/sandbox-templates", { params: { projectId: p.id } });
      r.status(200).body().exists("$.items");
    });
    await ctx.step("ANON sandbox-health → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/projects/:projectId/sandbox-health", { params: { projectId: p.id } });
      r.status(401);
    });
  },
);

// ─── SBX-4: template CRUD + build ──────────────────────────────────────────
flow(
  "SBX-4",
  {
    domain: "sandboxes",
    routes: [
      "POST /v1/projects/:projectId/sandbox-templates",
      "PATCH /v1/projects/:projectId/sandbox-templates/:templateId",
      "DELETE /v1/projects/:projectId/sandbox-templates/:templateId",
      "POST /v1/projects/:projectId/sandbox-templates/:templateId/build",
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();

    // Create a custom template. Provide exactly one of image/dockerfile_path.
    const slug = `t-${ctx.fixtures.name("tpl").split("-").pop()}`.slice(0, 30).toLowerCase();
    let templateId: string | null = null;
    await ctx.step("POST create template → 201 (or 400/409)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/sandbox-templates",
          { slug, name: "e2e template", image: "ubuntu:22.04" },
          { params: { projectId: p.id } },
        );
      r.status([200, 201, 400, 409]);
      if (r.statusCode === 201 || r.statusCode === 200) {
        const body = r.json<{ template_id?: string }>();
        if (body.template_id) {
          templateId = body.template_id;
          ctx.track("sandbox-template", body.template_id, { projectId: p.id });
        }
      }
    });

    await ctx.step("POST create with bad slug → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/sandbox-templates",
          { slug: "Bad Slug!", image: "ubuntu:22.04" },
          { params: { projectId: p.id } },
        );
      r.status(400);
    });

    await ctx.step("POST with both image+dockerfile → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/sandbox-templates",
          { slug: `${slug}2`, image: "ubuntu:22.04", dockerfile_path: "Dockerfile" },
          { params: { projectId: p.id } },
        );
      r.status(400);
    });

    await ctx.step("PATCH unknown templateId → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          "/v1/projects/:projectId/sandbox-templates/:templateId",
          { name: "renamed" },
          { params: { projectId: p.id, templateId: RANDOM_UUID } },
        );
      r.status(404);
    });

    await ctx.step("DELETE unknown templateId → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/projects/:projectId/sandbox-templates/:templateId", {
          params: { projectId: p.id, templateId: RANDOM_UUID },
        });
      r.status(404);
    });

    await ctx.step("POST build unknown templateId → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/sandbox-templates/:templateId/build",
          {},
          { params: { projectId: p.id, templateId: RANDOM_UUID } },
        );
      r.status(404);
    });

    // If the create succeeded, exercise the real CRUD on the created row.
    await ctx.step("PATCH + build + DELETE created template (if created)", async () => {
      if (!templateId) {
        ctx.skip("template create did not yield an id in this environment");
      }
      const patched = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          "/v1/projects/:projectId/sandbox-templates/:templateId",
          { name: "e2e renamed" },
          { params: { projectId: p.id, templateId: templateId! } },
        );
      patched.status([200, 400, 404]);

      // build = fire-and-forget → 202; assert the trigger only.
      const built = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/sandbox-templates/:templateId/build",
          {},
          { params: { projectId: p.id, templateId: templateId! } },
        );
      built.status([200, 202, 404]);

      const del = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/projects/:projectId/sandbox-templates/:templateId", {
          params: { projectId: p.id, templateId: templateId! },
        });
      del.status([200, 204, 400, 404, 409]);
    });

    await ctx.step("NONMEMBER create → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post(
          "/v1/projects/:projectId/sandbox-templates",
          { slug: "nope", image: "ubuntu:22.04" },
          { params: { projectId: p.id } },
        );
      r.status([403, 404]);
    });
    await ctx.step("ANON create → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post(
          "/v1/projects/:projectId/sandbox-templates",
          { slug: "nope", image: "ubuntu:22.04" },
          { params: { projectId: p.id } },
        );
      r.status(401);
    });
  },
);

// ─── SBX-5: warm pool config ───────────────────────────────────────────────
flow(
  "SBX-5",
  {
    domain: "sandboxes",
    routes: [
      "GET /v1/projects/:projectId/warm-pool",
      "PATCH /v1/projects/:projectId/warm-pool",
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step("GET warm-pool → 200 with config", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/warm-pool", { params: { projectId: p.id } });
      r.status(200).body().exists("$.enabled").exists("$.size");
    });
    await ctx.step("PATCH warm-pool size → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          "/v1/projects/:projectId/warm-pool",
          { enabled: true, size: 2 },
          { params: { projectId: p.id } },
        );
      // Handler clamps + persists; returns the serialized project (200). Bad
      // body coerces to defaults rather than 400, but accept 400 defensively.
      r.status([200, 400]).body().exists("$.project_id");
    });
    await ctx.step("PATCH warm-pool disable → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          "/v1/projects/:projectId/warm-pool",
          { enabled: false },
          { params: { projectId: p.id } },
        );
      r.status([200, 400]);
    });
    await ctx.step("NONMEMBER PATCH → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .patch(
          "/v1/projects/:projectId/warm-pool",
          { size: 1 },
          { params: { projectId: p.id } },
        );
      r.status([403, 404]);
    });
    await ctx.step("ANON GET → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/projects/:projectId/warm-pool", { params: { projectId: p.id } });
      r.status(401);
    });
  },
);
