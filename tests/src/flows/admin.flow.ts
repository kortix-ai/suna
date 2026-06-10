/**
 * Platform admin console API (apps/api/src/admin/index.ts, mounted at
 * /v1/admin) + the admin-only maintenance write. Every route is guarded by
 * supabaseAuth + a platform-role check (admin/super_admin):
 *   ANON → 401, authed non-admin (the e2e OWNER) → 403.
 * Those boundaries are asserted ALWAYS (real calls against the live API).
 *
 * The 200 happy paths need a real platform-admin principal, which the suite
 * only has when KE2E_ADMIN_TOKEN is provided (capability `admin`). When present
 * (e.g. dev-api), the flows additionally exercise the real success path:
 * list accounts, read a ledger/users, grant + debit credits. Maps to ADM-*.
 */
import { flow } from "../core/flow";

// A syntactically-valid but non-existent account id for boundary probes (auth
// fails before the id is ever resolved, so any uuid works).
const NOPE = "00000000-0000-0000-0000-000000000000";

flow("ADM-1", { domain: "admin", routes: ["GET /v1/admin/api/accounts"] }, async (ctx) => {
  await ctx.step("ANON → 401", async () => {
    const r = await ctx.client.as(ctx.P.ANON).get("/v1/admin/api/accounts");
    r.status(401);
  });
  await ctx.step("non-admin OWNER → 403", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/admin/api/accounts");
    r.status(403);
  });
  if (ctx.env.capabilities.admin) {
    await ctx.step("platform admin lists accounts → 200 page", async () => {
      const r = await ctx.client.withBearer(ctx.env.adminToken!, "ADMIN_TOKEN").get("/v1/admin/api/accounts", { query: { limit: "5" } });
      r.status(200);
    });
  }
});

flow("ADM-2", { domain: "admin", routes: ["GET /v1/admin/api/accounts/:id/users"] }, async (ctx) => {
  await ctx.step("ANON → 401", async () => {
    const r = await ctx.client.as(ctx.P.ANON).get("/v1/admin/api/accounts/:id/users", { params: { id: NOPE } });
    r.status(401);
  });
  await ctx.step("non-admin OWNER → 403", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/admin/api/accounts/:id/users", { params: { id: NOPE } });
    r.status(403);
  });
  if (ctx.env.capabilities.admin) {
    await ctx.step("platform admin reads an account's users → 200", async () => {
      const r = await ctx.client
        .withBearer(ctx.env.adminToken!, "ADMIN_TOKEN")
        .get("/v1/admin/api/accounts/:id/users", { params: { id: ctx.P.OWNER.accountId! } });
      r.status(200);
    });
  }
});

flow("ADM-3", { domain: "admin", routes: ["GET /v1/admin/api/accounts/:id/ledger"] }, async (ctx) => {
  await ctx.step("ANON → 401", async () => {
    const r = await ctx.client.as(ctx.P.ANON).get("/v1/admin/api/accounts/:id/ledger", { params: { id: NOPE } });
    r.status(401);
  });
  await ctx.step("non-admin OWNER → 403", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/admin/api/accounts/:id/ledger", { params: { id: NOPE } });
    r.status(403);
  });
  if (ctx.env.capabilities.admin) {
    await ctx.step("platform admin reads a credit ledger → 200", async () => {
      const r = await ctx.client
        .withBearer(ctx.env.adminToken!, "ADMIN_TOKEN")
        .get("/v1/admin/api/accounts/:id/ledger", { params: { id: ctx.P.OWNER.accountId! } });
      r.status(200);
    });
  }
});

flow("ADM-4", { domain: "admin", serial: true, routes: ["POST /v1/admin/api/accounts/:id/credits"] }, async (ctx) => {
  await ctx.step("ANON → 401", async () => {
    const r = await ctx.client.as(ctx.P.ANON).post("/v1/admin/api/accounts/:id/credits", { amount: 1 }, { params: { id: NOPE } });
    r.status(401);
  });
  await ctx.step("non-admin OWNER → 403", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).post("/v1/admin/api/accounts/:id/credits", { amount: 1 }, { params: { id: NOPE } });
    r.status(403);
  });
  if (ctx.env.capabilities.admin) {
    const admin = ctx.client.withBearer(ctx.env.adminToken!, "ADMIN_TOKEN");
    await ctx.step("admin: non-positive amount → 400", async () => {
      const r = await admin.post("/v1/admin/api/accounts/:id/credits", { amount: 0 }, { params: { id: ctx.P.OWNER.accountId! } });
      r.status(400);
    });
    await ctx.step("admin grants credits → 200 {ok:true, balance}", async () => {
      const r = await admin.post(
        "/v1/admin/api/accounts/:id/credits",
        { amount: 1, description: "ke2e admin grant" },
        { params: { id: ctx.P.OWNER.accountId! } },
      );
      r.status(200).body().has("$.ok", true).exists("$.balance");
    });
  }
});

flow("ADM-5", { domain: "admin", serial: true, routes: ["POST /v1/admin/api/accounts/:id/credits/debit"] }, async (ctx) => {
  await ctx.step("ANON → 401", async () => {
    const r = await ctx.client.as(ctx.P.ANON).post("/v1/admin/api/accounts/:id/credits/debit", { amount: 1 }, { params: { id: NOPE } });
    r.status(401);
  });
  await ctx.step("non-admin OWNER → 403", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).post("/v1/admin/api/accounts/:id/credits/debit", { amount: 1 }, { params: { id: NOPE } });
    r.status(403);
  });
  if (ctx.env.capabilities.admin) {
    const admin = ctx.client.withBearer(ctx.env.adminToken!, "ADMIN_TOKEN");
    await ctx.step("admin: non-positive amount → 400", async () => {
      const r = await admin.post("/v1/admin/api/accounts/:id/credits/debit", { amount: -1 }, { params: { id: ctx.P.OWNER.accountId! } });
      r.status(400);
    });
    await ctx.step("admin debits credits → 200 {ok:true, balance}", async () => {
      const r = await admin.post(
        "/v1/admin/api/accounts/:id/credits/debit",
        { amount: 1, description: "ke2e admin debit" },
        { params: { id: ctx.P.OWNER.accountId! } },
      );
      r.status(200).body().has("$.ok", true).exists("$.balance");
    });
  }
});

flow("ADM-6", { domain: "admin", serial: true, routes: ["PUT /v1/system/maintenance"] }, async (ctx) => {
  // Mounted with supabaseAuth; the handler does the platform-role check (403 for
  // non-admin). ANON → 401 (supabaseAuth), non-admin OWNER → 403.
  await ctx.step("ANON → 401", async () => {
    const r = await ctx.client.as(ctx.P.ANON).put("/v1/system/maintenance", { level: "none" });
    r.status(401);
  });
  await ctx.step("non-admin OWNER → 403", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).put("/v1/system/maintenance", { level: "none" });
    r.status(403);
  });
  if (ctx.env.capabilities.admin) {
    const admin = ctx.client.withBearer(ctx.env.adminToken!, "ADMIN_TOKEN");
    await ctx.step("admin updates maintenance config → 200 (then restores none)", async () => {
      const r = await admin.put("/v1/system/maintenance", { level: "none", title: "", message: "" });
      r.status(200).body().exists("$.updatedAt");
    });
  }
});
