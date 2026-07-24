/**
 * Projects — authenticated CRUD + access. Maps to spec §13 (PROJ-1..8).
 */
import { flow } from "../core/flow";

flow("PROJ-1", { domain: "projects", tags: ["smoke"], routes: ["GET /v1/projects"] }, async (ctx) => {
  await ctx.step("OWNER lists projects", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/projects");
    r.status(200);
  });
  await ctx.step("ANON → 401", async () => {
    const r = await ctx.client.as(ctx.P.ANON).get("/v1/projects");
    r.status(401);
  });
});

flow("PROJ-3", { domain: "projects", requires: ["managedGit"], routes: ["POST /v1/projects/provision"] }, async (ctx) => {
  await ctx.step("managed provision → 201 with repo", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).post("/v1/projects/provision", { name: ctx.fixtures.name("prov") });
    r.status(201).body().exists("$.project_id").exists("$.repo_url");
    ctx.track("project", r.json<any>().project_id);
  });
  await ctx.step("name over 120 chars → 400, nothing provisioned upstream", async () => {
    const r = await ctx.client
      .as(ctx.P.OWNER)
      .post("/v1/projects/provision", { name: `pasted prompt as name ${"word ".repeat(30)}end` });
    r.status(400);
  });
});

flow("PROJ-5", { domain: "projects", routes: ["GET /v1/projects/:projectId"] }, async (ctx) => {
  const p = await ctx.fixtures.project();
  await ctx.step("OWNER reads project", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/projects/:projectId", { params: { projectId: p.id } });
    r.status(200).body().has("$.project_id", p.id);
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
  await ctx.step("OWNER renames project", async () => {
    const r = await ctx.client
      .as(ctx.P.OWNER)
      .patch("/v1/projects/:projectId", { name: ctx.fixtures.name("renamed") }, { params: { projectId: p.id } });
    r.status(200);
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
    // `stripe` ⇒ the target enforces billing, so a free account is capped at 3
    // project; `managedGit` ⇒ managed provisioning is available to reach the cap.
    requires: ["managedGit", "stripe"],
    serial: true,
    routes: ["GET /v1/projects", "POST /v1/projects/provision"],
  },
  async (ctx) => {
    // NONMEMBER is a fresh, UNFUNDED (free) account → its project cap is 3.
    const list = await ctx.client.as(ctx.P.NONMEMBER).get("/v1/projects");
    list.status(200);
    const existing = list.json<any[]>()?.length ?? 0;
    if (existing !== 0) {
      throw new Error(`PROJ-18 requires a fresh free account; found ${existing} existing projects`);
    }

    const createdProjectIds: string[] = [];
    let repositorySourceProjectId: string | null = null;
    try {
      for (let index = 0; index < 3; index += 1) {
        await ctx.step(`free account: project ${index + 1} of 3 allowed (201)`, async () => {
          const r = await ctx.client
            .as(ctx.P.NONMEMBER)
            .post("/v1/projects/provision", {
              name: ctx.fixtures.name(`free-${index + 1}`),
              ...(repositorySourceProjectId
                ? {
                    repository_source_project_id: repositorySourceProjectId,
                    default_branch: ctx.fixtures.name(`free-branch-${index + 1}`),
                  }
                : { seed_starter: true }),
            });
          r.status(201).body().exists("$.project_id");
          const projectId = r.json<any>().project_id;
          createdProjectIds.push(projectId);
          repositorySourceProjectId ??= projectId;
        });
      }

      await ctx.step("free account: 4th project rejected (403 project_limit_reached)", async () => {
        const r = await ctx.client
          .as(ctx.P.NONMEMBER)
          .post("/v1/projects/provision", {
            name: ctx.fixtures.name("free-4"),
            repository_source_project_id: repositorySourceProjectId,
            default_branch: ctx.fixtures.name("free-branch-4"),
          });
        // The quota gate runs before any repository branch is created.
        r.status(403)
          .body()
          .has("$.code", "project_limit_reached")
          .has("$.limit", 3)
          .has("$.count", 3);
      });
    } finally {
      // These projects belong to NONMEMBER's personal account. The global
      // OWNER teardown client cannot delete them. Delete derived projects
      // first, then delete the one upstream-owning source project.
      const cleanupFailures: string[] = [];
      for (const projectId of createdProjectIds.reverse()) {
        const response = await ctx.client.as(ctx.P.NONMEMBER).del("/v1/projects/:id", {
          params: { id: projectId },
          query: { purge: "true" },
        });
        if (![200, 404].includes(response.statusCode)) {
          cleanupFailures.push(
            `${projectId}: HTTP ${response.statusCode}: ${response.text().slice(0, 500)}`,
          );
        }
      }
      if (cleanupFailures.length > 0) {
        throw new Error(`PROJ-18 cleanup failed: ${cleanupFailures.join("; ")}`);
      }
    }
  },
);

flow("PROJ-8", { domain: "projects", routes: ["DELETE /v1/projects/:projectId"] }, async (ctx) => {
  const project = await ctx.fixtures.project({ name: ctx.fixtures.name("del") });
  const id = project.id;
  await ctx.step("OWNER archives project", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).del("/v1/projects/:projectId", { params: { projectId: id } });
    r.status(200).body().has("$.ok", true);
  });
  await ctx.step("archived project reads 404", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/projects/:projectId", { params: { projectId: id } });
    r.status(404);
  });
});
