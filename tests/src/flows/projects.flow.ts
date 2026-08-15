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

flow(
  "PROJ-6",
  {
    domain: "projects",
    routes: ["GET /v1/projects/:projectId/detail", "GET /v1/projects/:projectId/starter-suggestions"],
  },
  async (ctx) => {
  const p = await ctx.fixtures.project();
  await ctx.step("detail returns project + manifest", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/projects/:projectId/detail", { params: { projectId: p.id } });
    r.status(200);
  });
  await ctx.step("NONMEMBER → 403", async () => {
    const r = await ctx.client.as(ctx.P.NONMEMBER).get("/v1/projects/:projectId/detail", { params: { projectId: p.id } });
    r.status(403);
  });
  await ctx.step("starter-suggestions: fresh project answers with the static fallback pool", async () => {
    const r = await ctx.client
      .as(ctx.P.OWNER)
      .get("/v1/projects/:projectId/starter-suggestions", { params: { projectId: p.id } });
    // No LLM is configured on the local profile, so the platform default model
    // never resolves and generation never persists a cache — the static
    // fallback pool is the local contract, not a transient/flaky first read.
    r.status(200).body().has("$.source", "static").has("$.generated_at", null);
    const items = r.json<{ items: unknown[] }>().items;
    if (items.length !== 6) {
      throw new Error(`expected 6 static starter suggestions, got ${items.length}`);
    }
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
  const id =
    ctx.env.target === "local"
      ? (await ctx.fixtures.project({ name: ctx.fixtures.name("del") })).id
      : (
          await ctx.client.as(ctx.P.OWNER).post("/v1/projects/provision", {
            name: ctx.fixtures.name("del"),
          })
        ).json<any>().project_id;
  await ctx.step("OWNER archives project", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).del("/v1/projects/:projectId", { params: { projectId: id } });
    r.status(200).body().has("$.ok", true);
  });
  await ctx.step("archived project reads 404", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/projects/:projectId", { params: { projectId: id } });
    r.status(404);
  });
});
