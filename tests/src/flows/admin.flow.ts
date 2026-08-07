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
 * list accounts, read a ledger/users, grant + debit credits, and the
 * trial/entitlement-override writes (ADM-14..ADM-18). ADM-19 is the one
 * exception to the auth model: the trial-expiry cron is internal-cron-authed,
 * not requireAdmin. Maps to ADM-*.
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

flow(
  "ADM-13",
  {
    domain: "admin",
    serial: true,
    routes: ["POST /v1/admin/api/accounts/:id/enterprise-entitlement"],
  },
  async (ctx) => {
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post(
          "/v1/admin/api/accounts/:id/enterprise-entitlement",
          { enabled: true },
          { params: { id: NOPE } },
        );
      r.status(401);
    });
    await ctx.step("non-admin OWNER → 403", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/admin/api/accounts/:id/enterprise-entitlement",
          { enabled: true },
          { params: { id: NOPE } },
        );
      r.status(403);
    });
    if (ctx.env.capabilities.admin) {
      await ctx.step("admin: non-boolean entitlement → 400", async () => {
        const r = await ctx.client
          .withBearer(ctx.env.adminToken!, "ADMIN_TOKEN")
          .post(
            "/v1/admin/api/accounts/:id/enterprise-entitlement",
            { enabled: "yes" },
            { params: { id: ctx.P.OWNER.accountId! } },
          );
        r.status(400);
      });
    }
  },
);

// ─── Admin-issued trials + entitlement overrides ─────────────────────────────
// Every write below is scoped to a FRESH run-owned team account (torn down at
// the end of the run), never the seeded OWNER account and never a real
// customer. A trial makes the account BEHAVE as `tier_key` without touching
// credit_accounts.tier, so nothing here can leak into a real subscription.

// ADM-14 — grant/replace a trial. `credit_grant: 0` keeps the wallet untouched
// (the parameter is exercised at its boundary, not by minting real credits).
flow(
  "ADM-14",
  {
    domain: "admin",
    routes: ["POST /v1/admin/api/accounts/:id/trial", "GET /v1/admin/api/accounts"],
  },
  async (ctx) => {
    const grant = { tier_key: "team", seats: 1, duration_days: 30, credit_grant: 0 };
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/admin/api/accounts/:id/trial", grant, { params: { id: NOPE } });
      r.status(401);
    });
    await ctx.step("non-admin OWNER → 403", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post("/v1/admin/api/accounts/:id/trial", grant, { params: { id: NOPE } });
      r.status(403);
    });
    if (ctx.env.capabilities.admin) {
      const admin = ctx.client.withBearer(ctx.env.adminToken!, "ADMIN_TOKEN");
      const name = ctx.fixtures.name("adm14-trial");
      const team = await ctx.fixtures.team({ name });

      await ctx.step("admin: tier_key that is not a PAID tier → 400", async () => {
        const r = await admin.post(
          "/v1/admin/api/accounts/:id/trial",
          { ...grant, tier_key: "free" },
          { params: { id: team.id } },
        );
        r.status(400);
      });
      await ctx.step("admin: duration_days beyond the 365-day cap → 400", async () => {
        const r = await admin.post(
          "/v1/admin/api/accounts/:id/trial",
          { ...grant, duration_days: 400 },
          { params: { id: team.id } },
        );
        r.status(400);
      });
      await ctx.step("admin: seats below 1 → 400", async () => {
        const r = await admin.post(
          "/v1/admin/api/accounts/:id/trial",
          { ...grant, seats: 0 },
          { params: { id: team.id } },
        );
        r.status(400);
      });
      await ctx.step("admin grants a 30-day 'team' trial → 200 {ok:true, trial:{status:'active'}}", async () => {
        const r = await admin.post(
          "/v1/admin/api/accounts/:id/trial",
          { ...grant, note: "ke2e ADM-14" },
          { params: { id: team.id } },
        );
        r.status(200)
          .body()
          .has("$.ok", true)
          .has("$.trial.status", "active")
          .has("$.trial.tier", "team")
          .has("$.trial.seats", 1)
          .has("$.trial.note", "ke2e ADM-14")
          .has("$.credit_granted", 0)
          .exists("$.trial.startedAt")
          .exists("$.trial.endsAt");
      });
      await ctx.step("the accounts-list row reports the active trial", async () => {
        const r = await admin.get("/v1/admin/api/accounts", { query: { search: name, limit: "5" } });
        r.status(200)
          .body()
          .has("$.total", 1)
          .has("$.accounts[0].accountId", team.id)
          .has("$.accounts[0].trial.status", "active")
          .has("$.accounts[0].trial.tier", "team")
          .has("$.accounts[0].trial.seats", 1)
          .exists("$.accounts[0].billingModel")
          .exists("$.accounts[0].seatCount");
      });
    }
  },
);

// ADM-15 — revoke a trial. Status-only change: tier/seats/window stay on the
// row as the audit trail, and a second revoke is a 400, not a silent no-op.
flow(
  "ADM-15",
  {
    domain: "admin",
    routes: ["DELETE /v1/admin/api/accounts/:id/trial", "POST /v1/admin/api/accounts/:id/trial"],
  },
  async (ctx) => {
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).del("/v1/admin/api/accounts/:id/trial", { params: { id: NOPE } });
      r.status(401);
    });
    await ctx.step("non-admin OWNER → 403", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).del("/v1/admin/api/accounts/:id/trial", { params: { id: NOPE } });
      r.status(403);
    });
    if (ctx.env.capabilities.admin) {
      const admin = ctx.client.withBearer(ctx.env.adminToken!, "ADMIN_TOKEN");
      const team = await ctx.fixtures.team({ name: ctx.fixtures.name("adm15-trial") });

      await ctx.step("admin revokes on an account that never had a trial → 400", async () => {
        const r = await admin.del("/v1/admin/api/accounts/:id/trial", { params: { id: team.id } });
        r.status(400);
      });
      await ctx.step("admin grants a trial to revoke → 200 active", async () => {
        const r = await admin.post(
          "/v1/admin/api/accounts/:id/trial",
          { tier_key: "team", seats: 1, duration_days: 30, credit_grant: 0 },
          { params: { id: team.id } },
        );
        r.status(200).body().has("$.trial.status", "active");
      });
      await ctx.step("admin revokes it → 200 {ok:true, trial:{status:'revoked'}} (tier/seats kept)", async () => {
        const r = await admin.del("/v1/admin/api/accounts/:id/trial", { params: { id: team.id } });
        r.status(200)
          .body()
          .has("$.ok", true)
          .has("$.trial.status", "revoked")
          .has("$.trial.tier", "team")
          .has("$.trial.seats", 1);
      });
      await ctx.step("revoking again → 400 (no active trial)", async () => {
        const r = await admin.del("/v1/admin/api/accounts/:id/trial", { params: { id: team.id } });
        r.status(400);
      });
    }
  },
);

// ADM-16 — tri-state managed-models override: true grants Kortix-credential
// models regardless of tier, false forces BYOK-only, null restores "the
// effective tier decides".
flow(
  "ADM-16",
  { domain: "admin", routes: ["POST /v1/admin/api/accounts/:id/managed-models"] },
  async (ctx) => {
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/admin/api/accounts/:id/managed-models", { override: true }, { params: { id: NOPE } });
      r.status(401);
    });
    await ctx.step("non-admin OWNER → 403", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/admin/api/accounts/:id/managed-models", { override: true }, { params: { id: NOPE } });
      r.status(403);
    });
    if (ctx.env.capabilities.admin) {
      const admin = ctx.client.withBearer(ctx.env.adminToken!, "ADMIN_TOKEN");
      const team = await ctx.fixtures.team({ name: ctx.fixtures.name("adm16-mm") });

      await ctx.step("admin: neither boolean nor null → 400", async () => {
        const r = await admin.post(
          "/v1/admin/api/accounts/:id/managed-models",
          { override: "yes" },
          { params: { id: team.id } },
        );
        r.status(400);
      });
      await ctx.step("admin grants managed models → 200 {ok:true, override:true}", async () => {
        const r = await admin.post(
          "/v1/admin/api/accounts/:id/managed-models",
          { override: true },
          { params: { id: team.id } },
        );
        r.status(200).body().has("$.ok", true).has("$.override", true);
      });
      await ctx.step("admin forces BYOK-only → 200 {ok:true, override:false}", async () => {
        const r = await admin.post(
          "/v1/admin/api/accounts/:id/managed-models",
          { override: false },
          { params: { id: team.id } },
        );
        r.status(200).body().has("$.ok", true).has("$.override", false);
      });
      await ctx.step("admin clears the override → 200 {ok:true, override:null}", async () => {
        const r = await admin.post(
          "/v1/admin/api/accounts/:id/managed-models",
          { override: null },
          { params: { id: team.id } },
        );
        r.status(200).body().has("$.ok", true).has("$.override", null);
      });
    }
  },
);

// ADM-17 — the admin counterpart of the retired self-serve enterprise-demo
// toggle (IAM-32's PUT is platform-admin-only now). Same storage, so the
// account-scoped IAM GET must reflect what the console wrote.
flow(
  "ADM-17",
  {
    domain: "admin",
    routes: [
      "POST /v1/admin/api/accounts/:id/enterprise-demo",
      "GET /v1/accounts/:accountId/iam/enterprise-demo",
    ],
  },
  async (ctx) => {
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/admin/api/accounts/:id/enterprise-demo", { enabled: true }, { params: { id: NOPE } });
      r.status(401);
    });
    await ctx.step("non-admin OWNER → 403", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/admin/api/accounts/:id/enterprise-demo", { enabled: true }, { params: { id: NOPE } });
      r.status(403);
    });
    if (ctx.env.capabilities.admin) {
      const admin = ctx.client.withBearer(ctx.env.adminToken!, "ADMIN_TOKEN");
      const team = await ctx.fixtures.team({ name: ctx.fixtures.name("adm17-demo") });

      await ctx.step("admin: non-boolean enabled → 400", async () => {
        const r = await admin.post(
          "/v1/admin/api/accounts/:id/enterprise-demo",
          { enabled: "yes" },
          { params: { id: team.id } },
        );
        r.status(400);
      });
      await ctx.step("admin enables the demo → 200 {ok:true, enabled:true}", async () => {
        const r = await admin.post(
          "/v1/admin/api/accounts/:id/enterprise-demo",
          { enabled: true },
          { params: { id: team.id } },
        );
        r.status(200).body().has("$.ok", true).has("$.enabled", true);
      });
      await ctx.step("the account-scoped IAM read reflects it → 200 true", async () => {
        const r = await ctx.client
          .as(ctx.P.OWNER)
          .get("/v1/accounts/:accountId/iam/enterprise-demo", { params: { accountId: team.id } });
        r.status(200).body().has("$.enabled", true);
      });
      await ctx.step("admin disables it again → 200 {ok:true, enabled:false}", async () => {
        const r = await admin.post(
          "/v1/admin/api/accounts/:id/enterprise-demo",
          { enabled: false },
          { params: { id: team.id } },
        );
        r.status(200).body().has("$.ok", true).has("$.enabled", false);
      });
    }
  },
);

// ADM-18 — the accounts-list row shape the admin console renders. Asserted
// against a FRESH run-owned account, so the never-granted defaults are exact
// rather than whatever the first page happens to hold.
flow("ADM-18", { domain: "admin", routes: ["GET /v1/admin/api/accounts"] }, async (ctx) => {
  await ctx.step("ANON → 401", async () => {
    const r = await ctx.client.as(ctx.P.ANON).get("/v1/admin/api/accounts", { query: { limit: "1" } });
    r.status(401);
  });
  await ctx.step("non-admin OWNER → 403", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/admin/api/accounts", { query: { limit: "1" } });
    r.status(403);
  });
  if (ctx.env.capabilities.admin) {
    const admin = ctx.client.withBearer(ctx.env.adminToken!, "ADMIN_TOKEN");
    const name = ctx.fixtures.name("adm18-fields");
    const team = await ctx.fixtures.team({ name });

    await ctx.step("a never-granted account carries the entitlement columns at their defaults", async () => {
      const r = await admin.get("/v1/admin/api/accounts", { query: { search: name, limit: "5" } });
      r.status(200)
        .body()
        .has("$.total", 1)
        .has("$.accounts[0].accountId", team.id)
        .has("$.accounts[0].trial", {
          status: "none",
          tier: null,
          seats: null,
          startedAt: null,
          endsAt: null,
          note: null,
        })
        .has("$.accounts[0].managedModelsOverride", null)
        .has("$.accounts[0].demoEnterprise", false)
        .has("$.accounts[0].enterpriseEntitled", false);
    });
  }
});

// ADM-19 — the trial-expiry sweep cron. Same `requireInternalCronAuth` gate as
// BILL-13/BILL-16 (Bearer or X-Kortix-Internal-Key must timing-safe-equal
// INTERNAL_SERVICE_KEY). Unlike the credit rotations the sweep grants nothing —
// it only flips trials whose window ALREADY passed to 'expired' — so the real
// call is safe to make when the internal key is available. `serial+global`
// because it writes across every account on the deployment. The {expired:n}
// assertion assumes the target runs billing internals (same assumption BILL-13
// already makes); a KORTIX_BILLING_INTERNAL_ENABLED=false deployment answers
// 200 {skipped:true} instead.
flow(
  "ADM-19",
  { domain: "admin", serial: true, global: true, routes: ["POST /v1/billing/cron/trial-expiry"] },
  async (ctx) => {
    await ctx.step("no credentials → 401 (route mounted + gated)", async () => {
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/billing/cron/trial-expiry", {});
      r.status(401);
    });
    await ctx.step("wrong bearer → 401 (never the real internal key)", async () => {
      const r = await ctx.client
        .withBearer("ke2e-not-the-internal-key", "WRONG_TOKEN")
        .post("/v1/billing/cron/trial-expiry", {});
      r.status(401);
    });
    if (ctx.env.capabilities.internalCron) {
      await ctx.step("internal cron key → 200 {expired:n}", async () => {
        const r = await ctx.client
          .withBearer(ctx.env.internalServiceKey!, "INTERNAL_CRON")
          .post("/v1/billing/cron/trial-expiry", {});
        r.status(200).body().exists("$.expired");
      });
    }
  },
);
