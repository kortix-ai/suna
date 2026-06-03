/**
 * Server entries CRUD — black-box HTTP. Maps to spec §servers (SRV-*).
 *
 * Mounted at /v1/servers/* behind `combinedAuth` (OWNER JWT accepted, ANON → 401).
 * Entries are persisted per-account (DB serverEntries), scoped via resolveAccountId.
 * Body requires { id, label, url }; entries detected as managed/proxy
 * (id "default"/"cloud-sandbox"/"sandbox-*", any provider/sandboxId, or a
 * /v1/p/<sandbox>/<port> proxy url) are rejected with 400 / filtered from lists.
 *   - GET    /servers       → 200 [rows]
 *   - POST   /servers       → 201 row | 400 (missing fields / managed)
 *   - DELETE /servers/:id   → 200 { ok } | 404
 *   - PUT    /servers/sync  → 200 [rows]
 */
import { flow } from "../core/flow";

const uuid = () => crypto.randomUUID();

// ─── SRV-1: list + ANON guard ─────────────────────────────────────────────────

flow("SRV-1", { domain: "servers", tags: ["smoke"], routes: ["GET /v1/servers"] }, async (ctx) => {
  await ctx.step("OWNER lists server entries → 200 array", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/servers");
    r.status(200);
  });
  await ctx.step("ANON → 401", async () => {
    const r = await ctx.client.as(ctx.P.ANON).get("/v1/servers");
    r.status(401);
  });
});

// ─── SRV-2: create/delete lifecycle ──────────────────────────────────────────

flow(
  "SRV-2",
  {
    domain: "servers",
    serial: true,
    routes: [
      "POST /v1/servers",
      "DELETE /v1/servers/:id",
    ],
  },
  async (ctx) => {
    const id = `ke2e-${uuid()}`;
    await ctx.step("create entry → 201 row", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post("/v1/servers", {
        id,
        label: ctx.fixtures.name("srv"),
        url: "https://server.ke2e.kortix.test",
      });
      r.status(201).body().has("$.id", id);
    });
    await ctx.step("delete it → 200 ok", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).del("/v1/servers/:id", { params: { id } });
      r.status(200).body().has("$.ok", true);
    });
  },
);

// ─── SRV-3: validation + unknown-id 404s ──────────────────────────────────────

flow(
  "SRV-3",
  {
    domain: "servers",
    routes: ["POST /v1/servers", "DELETE /v1/servers/:id"],
  },
  async (ctx) => {
    await ctx.step("create missing required fields → 400", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post("/v1/servers", { label: "no id or url" });
      r.status(400);
    });
    await ctx.step("create managed/proxy entry → 400", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post("/v1/servers", {
        id: "default",
        label: "managed",
        url: "https://managed.ke2e.kortix.test",
      });
      r.status(400);
    });
    await ctx.step("delete unknown id → 404", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).del("/v1/servers/:id", { params: { id: `ke2e-${uuid()}` } });
      r.status(404);
    });
  },
);

// ─── SRV-4: bulk sync ─────────────────────────────────────────────────────────

flow("SRV-4", { domain: "servers", serial: true, routes: ["PUT /v1/servers/sync", "DELETE /v1/servers/:id"] }, async (ctx) => {
  const id = `ke2e-${uuid()}`;
  await ctx.step("sync upserts entries → 200 rows", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).put("/v1/servers/sync", {
      servers: [{ id, label: ctx.fixtures.name("synced"), url: "https://synced.ke2e.kortix.test" }],
    });
    r.status(200);
  });
  await ctx.step("sync with non-array → 400", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).put("/v1/servers/sync", { servers: "not-an-array" });
    r.status(400);
  });
  await ctx.step("ANON sync → 401", async () => {
    const r = await ctx.client.as(ctx.P.ANON).put("/v1/servers/sync", { servers: [] });
    r.status(401);
  });
  await ctx.step("cleanup synced entry → 200 ok", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).del("/v1/servers/:id", { params: { id } });
    r.status([200, 404]);
  });
});
