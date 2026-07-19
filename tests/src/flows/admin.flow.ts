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

flow("ADM-2b", { domain: "admin", routes: ["GET /v1/admin/api/accounts/:id/projects"] }, async (ctx) => {
  await ctx.step("ANON → 401", async () => {
    const r = await ctx.client.as(ctx.P.ANON).get("/v1/admin/api/accounts/:id/projects", { params: { id: NOPE } });
    r.status(401);
  });
  await ctx.step("non-admin OWNER → 403", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/admin/api/accounts/:id/projects", { params: { id: NOPE } });
    r.status(403);
  });
  if (ctx.env.capabilities.admin) {
    await ctx.step("platform admin reads an account's projects → 200 {projects:[]}", async () => {
      const r = await ctx.client
        .withBearer(ctx.env.adminToken!, "ADMIN_TOKEN")
        .get("/v1/admin/api/accounts/:id/projects", { params: { id: ctx.P.OWNER.accountId! } });
      r.status(200).body().exists("$.projects");
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

flow("ADM-7", { domain: "admin", routes: ["GET /v1/admin/api/provider-analytics"] }, async (ctx) => {
  await ctx.step("ANON → 401", async () => {
    const r = await ctx.client.as(ctx.P.ANON).get("/v1/admin/api/provider-analytics");
    r.status(401);
  });
  await ctx.step("non-admin OWNER → 403", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/admin/api/provider-analytics");
    r.status(403);
  });
  if (ctx.env.capabilities.admin) {
    await ctx.step("platform admin reads provider analytics → 200 aggregate", async () => {
      const r = await ctx.client
        .withBearer(ctx.env.adminToken!, "ADMIN_TOKEN")
        .get("/v1/admin/api/provider-analytics", { query: { days: "7" } });
      r.status(200).body().exists("$.totals").exists("$.providers");
    });
  }
});

// ADM-8 — provider split weights (provider-balancer). The PUT is a genuine
// admin write to shared staging routing config (platform_settings), so this
// does a real read-modify-write NO-OP: read the current weights, then PUT the
// exact same object straight back. Never invents a different distribution.
flow(
  "ADM-8",
  { domain: "admin", serial: true, routes: ["GET /v1/admin/api/provider-distribution", "PUT /v1/admin/api/provider-distribution"] },
  async (ctx) => {
    await ctx.step("ANON → 401 (GET)", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/admin/api/provider-distribution");
      r.status(401);
    });
    await ctx.step("non-admin OWNER → 403 (GET)", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/admin/api/provider-distribution");
      r.status(403);
    });
    await ctx.step("ANON → 401 (PUT)", async () => {
      const r = await ctx.client.as(ctx.P.ANON).put("/v1/admin/api/provider-distribution", {});
      r.status(401);
    });
    await ctx.step("non-admin OWNER → 403 (PUT)", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).put("/v1/admin/api/provider-distribution", {});
      r.status(403);
    });
    if (ctx.env.capabilities.admin) {
      const admin = ctx.client.withBearer(ctx.env.adminToken!, "ADMIN_TOKEN");
      await ctx.step("admin reads current split weights → 200", async () => {
        const r = await admin.get("/v1/admin/api/provider-distribution");
        r.status(200).body().exists("$.allowed").exists("$.weights");
      });
      await ctx.step("admin writes back the SAME weights (no-op) → 200", async () => {
        const before = await admin.get("/v1/admin/api/provider-distribution");
        before.status(200);
        const weights = before.json().weights ?? {};
        const r = await admin.put("/v1/admin/api/provider-distribution", weights);
        r.status(200).body().has("$.ok", true);
      });
    }
  },
);

// ADM-9 — provider failover toggle (runtime-settings). Same real
// read-modify-write NO-OP pattern as ADM-8: never flips staging's actual
// failover setting, only re-applies the value already in effect.
flow(
  "ADM-9",
  { domain: "admin", serial: true, routes: ["GET /v1/admin/api/provider-fallback", "PUT /v1/admin/api/provider-fallback"] },
  async (ctx) => {
    await ctx.step("ANON → 401 (GET)", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/admin/api/provider-fallback");
      r.status(401);
    });
    await ctx.step("non-admin OWNER → 403 (GET)", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/admin/api/provider-fallback");
      r.status(403);
    });
    await ctx.step("ANON → 401 (PUT)", async () => {
      const r = await ctx.client.as(ctx.P.ANON).put("/v1/admin/api/provider-fallback", { enabled: false });
      r.status(401);
    });
    await ctx.step("non-admin OWNER → 403 (PUT)", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).put("/v1/admin/api/provider-fallback", { enabled: false });
      r.status(403);
    });
    if (ctx.env.capabilities.admin) {
      const admin = ctx.client.withBearer(ctx.env.adminToken!, "ADMIN_TOKEN");
      await ctx.step("admin reads current failover config → 200", async () => {
        const r = await admin.get("/v1/admin/api/provider-fallback");
        r.status(200).body().exists("$.enabled");
      });
      await ctx.step("admin writes back the SAME enabled flag (no-op) → 200", async () => {
        const before = await admin.get("/v1/admin/api/provider-fallback");
        before.status(200);
        const enabled = before.json().enabled === true;
        const r = await admin.put("/v1/admin/api/provider-fallback", { enabled });
        r.status(200).body().has("$.ok", true).has("$.enabled", enabled);
      });
    }
  },
);

flow("ADM-10", { domain: "admin", routes: ["GET /v1/admin/api/sandboxes"] }, async (ctx) => {
  await ctx.step("ANON → 401", async () => {
    const r = await ctx.client.as(ctx.P.ANON).get("/v1/admin/api/sandboxes");
    r.status(401);
  });
  await ctx.step("non-admin OWNER → 403", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/admin/api/sandboxes");
    r.status(403);
  });
  if (ctx.env.capabilities.admin) {
    await ctx.step("platform admin lists sandboxes → 200 page", async () => {
      const r = await ctx.client
        .withBearer(ctx.env.adminToken!, "ADMIN_TOKEN")
        .get("/v1/admin/api/sandboxes", { query: { limit: "5" } });
      r.status(200).body().exists("$.sandboxes").exists("$.byProvider");
    });
  }
});

// ADM-11 — DESTRUCTIVE route (migrates a real session's sandbox to another
// provider). We NEVER run a real migration here. Boundaries only, plus — once
// authed as admin — an unknown sessionId with a genuinely-allowed target
// provider, which the handler 404s on ("sandbox not found") BEFORE any
// migration side-effect (it looks the sandbox row up first).
flow(
  "ADM-11",
  { domain: "admin", routes: ["POST /v1/admin/api/sandboxes/:sessionId/migrate"] },
  async (ctx) => {
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/admin/api/sandboxes/:sessionId/migrate", { targetProvider: "daytona" }, { params: { sessionId: NOPE } });
      r.status(401);
    });
    await ctx.step("non-admin OWNER → 403", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/admin/api/sandboxes/:sessionId/migrate", { targetProvider: "daytona" }, { params: { sessionId: NOPE } });
      r.status(403);
    });
    if (ctx.env.capabilities.admin) {
      const admin = ctx.client.withBearer(ctx.env.adminToken!, "ADMIN_TOKEN");
      await ctx.step("admin: invalid targetProvider → 400 (validated before any lookup)", async () => {
        const r = await admin.post(
          "/v1/admin/api/sandboxes/:sessionId/migrate",
          { targetProvider: "ke2e-not-a-real-provider" },
          { params: { sessionId: NOPE } },
        );
        r.status(400);
      });
      await ctx.step("admin: unknown session id with a valid provider → 404, no real sandbox ever touched", async () => {
        const dist = await admin.get("/v1/admin/api/provider-distribution");
        dist.status(200);
        const allowed: string[] = dist.json().allowed ?? ["daytona"];
        const r = await admin.post(
          "/v1/admin/api/sandboxes/:sessionId/migrate",
          { targetProvider: allowed[0] },
          { params: { sessionId: NOPE } },
        );
        r.status(404);
      });
    }
  },
);

// ADM-12 — sets an account's plan tier. Real write, but scoped to the
// ephemeral OWNER account this run provisions for itself (torn down at the
// end of the run) — never a real customer account. Reads the current
// tier first and re-applies the SAME value, so it's a safe no-op even
// against the run's own account.
flow(
  "ADM-12",
  { domain: "admin", serial: true, routes: ["POST /v1/admin/api/accounts/:id/tier"] },
  async (ctx) => {
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/admin/api/accounts/:id/tier", { tier: "free" }, { params: { id: NOPE } });
      r.status(401);
    });
    await ctx.step("non-admin OWNER → 403", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/admin/api/accounts/:id/tier", { tier: "free" }, { params: { id: NOPE } });
      r.status(403);
    });
    if (ctx.env.capabilities.admin) {
      const admin = ctx.client.withBearer(ctx.env.adminToken!, "ADMIN_TOKEN");
      await ctx.step("admin: unknown tier name → 400", async () => {
        const r = await admin.post(
          "/v1/admin/api/accounts/:id/tier",
          { tier: "ke2e-not-a-real-tier" },
          { params: { id: ctx.P.OWNER.accountId! } },
        );
        r.status(400);
      });
      await ctx.step("admin re-applies the OWNER account's current tier (no-op) → 200", async () => {
        const before = await ctx.client.as(ctx.P.OWNER).get("/v1/billing/account-state");
        before.status([200, 404]);
        const currentTier: string = before.json()?.subscription?.tier_key || "free";
        const r = await admin.post(
          "/v1/admin/api/accounts/:id/tier",
          { tier: currentTier },
          { params: { id: ctx.P.OWNER.accountId! } },
        );
        r.status(200).body().has("$.ok", true).has("$.tier", currentTier);
      });
    }
  },
);
