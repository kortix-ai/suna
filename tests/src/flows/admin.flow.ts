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
import type { Principal } from "../core/types";
import { withDb } from "../fixtures/chat";
import { adminDeleteUser, ssoFixtureToken } from "../fixtures/supabase";

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
      await ctx.step("admin: Enterprise through the tier route → 400, it is set by a contract", async () => {
        const team = await ctx.fixtures.team({ name: ctx.fixtures.name("adm12-enterprise") });
        const r = await admin.post(
          "/v1/admin/api/accounts/:id/tier",
          { tier: "enterprise" },
          { params: { id: team.id } },
        );
        r.status(400).body().matches("$.error", /enterprise-contract/);
      });
      await ctx.step("admin: a negative monthly_usd → 400", async () => {
        const team = await ctx.fixtures.team({ name: ctx.fixtures.name("adm12-bad-amount") });
        const r = await admin.post(
          "/v1/admin/api/accounts/:id/tier",
          { tier: "credits", monthly_usd: -5 },
          { params: { id: team.id } },
        );
        r.status(400);
      });
    }
  },
);

// ADM-13 — an Enterprise LICENSE recorded manually (paid outside Stripe): it
// turns the Enterprise features on (Licensed) and never touches the billing
// plan or the wallet. Scoped to a FRESH run-owned team. `manual` needs no
// Stripe, so the local profile drives the whole lifecycle.
flow(
  "ADM-13",
  {
    domain: "admin",
    serial: true,
    routes: [
      "POST /v1/admin/api/accounts/:id/enterprise-contract",
      "GET /v1/admin/api/accounts/:id/enterprise-contracts",
      "POST /v1/admin/api/accounts/:id/enterprise-contract/end",
      "GET /v1/billing/account-state",
    ],
  },
  async (ctx) => {
    const body = { license_usd: 25000, term_months: 12, collection: "manual" };
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/admin/api/accounts/:id/enterprise-contract", body, { params: { id: NOPE } });
      r.status(401);
    });
    await ctx.step("non-admin OWNER → 403", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/admin/api/accounts/:id/enterprise-contract", body, { params: { id: NOPE } });
      r.status(403);
    });
    if (ctx.env.capabilities.admin) {
      const admin = ctx.client.withBearer(ctx.env.adminToken!, "ADMIN_TOKEN");
      const team = await ctx.fixtures.team({ name: ctx.fixtures.name("adm13-contract") });

      await ctx.step("admin: a Stripe-collected term over 12 months → 400", async () => {
        const r = await admin.post(
          "/v1/admin/api/accounts/:id/enterprise-contract",
          { ...body, collection: "invoice", term_months: 24 },
          { params: { id: team.id } },
        );
        r.status(400);
      });
      await ctx.step("admin records a manual $25,000 license → 200, active for 12 months, no credits", async () => {
        const r = await admin.post("/v1/admin/api/accounts/:id/enterprise-contract", body, { params: { id: team.id } });
        r.status(200)
          .body()
          .has("$.contract.status", "active")
          .has("$.contract.licenseUsd", 25000)
          .has("$.contract.creditsUsd", 0)
          .has("$.contract.collection", "manual")
          .exists("$.contract.endsAt");
      });
      await ctx.step("account-state: Licensed with every Enterprise feature; the billing plan and wallet unchanged", async () => {
        const r = await ctx.client.as(ctx.P.OWNER).get("/v1/billing/account-state", { query: { account_id: team.id } });
        r.status(200)
          .body()
          .has("$.enterprise.state", "licensed")
          .has("$.plan.family", "free")
          .has("$.contract.license_usd", 25000)
          .has("$.contract.renews", false)
          .has("$.tier.entitlements.sso", true)
          .has("$.trial", null);
        const credits = r.json<any>()?.credits?.total;
        if (typeof credits === "number" && credits >= 1000) {
          throw new Error(`a license grants no credits, but the balance is ${String(credits)}`);
        }
      });
      await ctx.step("a second active contract → 409", async () => {
        const r = await admin.post("/v1/admin/api/accounts/:id/enterprise-contract", body, { params: { id: team.id } });
        r.status(409);
      });
      await ctx.step("the contract list shows it", async () => {
        const r = await admin.get("/v1/admin/api/accounts/:id/enterprise-contracts", { params: { id: team.id } });
        r.status(200).body().has("$.contracts[0].status", "active");
      });
      await ctx.step("admin ends the license → 200; Enterprise off, SSO kept for the grace", async () => {
        const r = await admin.post("/v1/admin/api/accounts/:id/enterprise-contract/end", {}, { params: { id: team.id } });
        r.status(200).body().has("$.contract.status", "ended");
        const state = await ctx.client.as(ctx.P.OWNER).get("/v1/billing/account-state", { query: { account_id: team.id } });
        state.status(200)
          .body()
          .has("$.enterprise.state", "off")
          .has("$.plan.family", "free")
          .has("$.contract", null)
          .has("$.grace.reason", "contract_ended")
          .has("$.tier.entitlements.sso", true)
          .has("$.tier.entitlements.rbac", false);
      });
      await ctx.step("ending again → 404, there is no active contract", async () => {
        const r = await admin.post("/v1/admin/api/accounts/:id/enterprise-contract/end", {}, { params: { id: team.id } });
        r.status(404);
      });
    }
  },
);

// ─── Enterprise demo (the self-serve feature switch) ──────────────────────────
// Every write below is scoped to a FRESH run-owned team account (torn down at
// the end of the run), never the seeded OWNER account and never a real
// customer. Trials are removed (2026-10-15): the Enterprise demo replaces them.

// ADM-14 — a platform admin switches the Enterprise demo for any account
// (support, or withdrawing a demo), and the admin accounts list shows it.
flow(
  "ADM-14",
  {
    domain: "admin",
    routes: ["PUT /v1/accounts/:accountId/iam/enterprise-demo", "GET /v1/admin/api/accounts"],
  },
  async (ctx) => {
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .put("/v1/accounts/:accountId/iam/enterprise-demo", { enabled: true }, { params: { accountId: NOPE } });
      r.status(401);
    });
    if (ctx.env.capabilities.admin) {
      const admin = ctx.client.withBearer(ctx.env.adminToken!, "ADMIN_TOKEN");
      const name = ctx.fixtures.name("adm14-demo");
      const team = await ctx.fixtures.team({ name });
      await ctx.step("admin turns the demo on for an account it is not a member of → 200 state demo", async () => {
        const r = await admin.put("/v1/accounts/:accountId/iam/enterprise-demo", { enabled: true }, { params: { accountId: team.id } });
        r.status(200).body().has("$.enabled", true).has("$.state", "demo");
      });
      await ctx.step("the accounts-list row reports enterprise 'demo'", async () => {
        const r = await admin.get("/v1/admin/api/accounts", { query: { search: name } });
        r.status(200);
        const row = (r.json<any>()?.accounts ?? []).find((a: any) => a.accountId === team.id);
        if (row?.enterprise !== "demo") throw new Error(`expected enterprise 'demo', got ${JSON.stringify(row?.enterprise)}`);
      });
      await ctx.step("admin turns it off → 200 state off", async () => {
        const r = await admin.put("/v1/accounts/:accountId/iam/enterprise-demo", { enabled: false }, { params: { accountId: team.id } });
        r.status(200).body().has("$.enabled", false).has("$.state", "off");
      });
    }
  },
);

// ADM-15 — the admin trial routes are retired: trials are removed.
flow(
  "ADM-15",
  {
    domain: "admin",
    routes: ["POST /v1/admin/api/accounts/:id/trial", "DELETE /v1/admin/api/accounts/:id/trial"],
  },
  async (ctx) => {
    await ctx.step("POST and DELETE …/trial → 410 ENDPOINT_RETIRED", async () => {
      const grant = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/admin/api/accounts/:id/trial", { tier_key: "enterprise", duration_days: 30 }, { params: { id: NOPE } });
      grant.status(410).body().has("$.code", "ENDPOINT_RETIRED");
      const revoke = await ctx.client.as(ctx.P.OWNER).del("/v1/admin/api/accounts/:id/trial", { params: { id: NOPE } });
      revoke.status(410).body().has("$.code", "ENDPOINT_RETIRED");
    });
  },
);

// ADM-16 — the account sees its Enterprise state: off, then demo once its owner
// turns it on. The billing plan does not change; the gates (`tier.*`) do.
flow(
  "ADM-16",
  {
    domain: "admin",
    serial: true,
    routes: ["PUT /v1/accounts/:accountId/iam/enterprise-demo", "GET /v1/billing/account-state"],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team({ name: ctx.fixtures.name("adm16-demo") });
    const state = () => ctx.client.as(ctx.P.OWNER).get("/v1/billing/account-state", { query: { account_id: team.id } });

    await ctx.step("a fresh account: enterprise off, no trial", async () => {
      (await state()).status(200).body().has("$.enterprise.state", "off").has("$.trial", null).has("$.plan.family", "free");
    });
    await ctx.step("the OWNER turns the demo on → enterprise demo, plan still Free, SSO on", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put("/v1/accounts/:accountId/iam/enterprise-demo", { enabled: true }, { params: { accountId: team.id } });
      r.status(200);
      (await state())
        .status(200)
        .body()
        .has("$.enterprise.state", "demo")
        .has("$.plan.family", "free")
        .has("$.tier.entitlements.sso", true)
        .has("$.trial", null);
    });
  },
);

// ADM-17 — an Enterprise offer a billing manager accepts in the app. Creating
// a `checkout` offer stores it without calling Stripe; the Stripe Checkout
// session is created per click (sessions expire within 24 h), so the steps
// below stop short of it in the local profile and assert the gates around it.
flow(
  "ADM-17",
  {
    domain: "admin",
    serial: true,
    routes: [
      "POST /v1/admin/api/accounts/:id/enterprise-contract",
      "DELETE /v1/admin/api/accounts/:id/enterprise-offer",
      "POST /v1/admin/api/accounts/:id/enterprise-contract/checkout-link",
      "POST /v1/billing/enterprise-offer/checkout",
      "GET /v1/billing/account-state",
    ],
  },
  async (ctx) => {
    await ctx.step("non-admin OWNER cannot withdraw an offer or get its link → 403", async () => {
      const w = await ctx.client.as(ctx.P.OWNER).del("/v1/admin/api/accounts/:id/enterprise-offer", { params: { id: NOPE } });
      w.status(403);
      const l = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/admin/api/accounts/:id/enterprise-contract/checkout-link", {}, { params: { id: NOPE } });
      l.status(403);
    });
    if (!ctx.env.capabilities.admin) return;
    const admin = ctx.client.withBearer(ctx.env.adminToken!, "ADMIN_TOKEN");
    const team = await ctx.fixtures.team({ name: ctx.fixtures.name("adm17-offer") });
    const member = await team.addMember("member");

    await ctx.step("admin offers a $25,000 annual license by card → 200 offered, account-state shows the offer", async () => {
      const r = await admin.post(
        "/v1/admin/api/accounts/:id/enterprise-contract",
        { license_usd: 25000, collection: "checkout" },
        { params: { id: team.id } },
      );
      r.status(200).body().has("$.contract.status", "offered");
      const state = await ctx.client.as(ctx.P.OWNER).get("/v1/billing/account-state", { query: { account_id: team.id } });
      state.status(200)
        .body()
        .has("$.enterprise_offer.license_usd", 25000)
        .has("$.enterprise_offer.collection", "checkout")
        .has("$.plan.family", "free");
    });
    await ctx.step("a second offer while one is open → 409", async () => {
      const r = await admin.post(
        "/v1/admin/api/accounts/:id/enterprise-contract",
        { license_usd: 1, collection: "checkout" },
        { params: { id: team.id } },
      );
      r.status(409);
    });
    await ctx.step("a plain member cannot accept it (no billing.write) → 403", async () => {
      const r = await ctx.client
        .as(member)
        .post(
          "/v1/billing/enterprise-offer/checkout",
          { account_id: team.id, success_url: "https://example.test/ok", cancel_url: "https://example.test/no" },
        );
      r.status(403);
    });
    await ctx.step("admin withdraws the offer → 200; account-state no longer shows it", async () => {
      const r = await admin.del("/v1/admin/api/accounts/:id/enterprise-offer", { params: { id: team.id } });
      r.status(200).body().has("$.contract.status", "withdrawn");
      const state = await ctx.client.as(ctx.P.OWNER).get("/v1/billing/account-state", { query: { account_id: team.id } });
      state.status(200).body().has("$.enterprise_offer", null);
    });
    await ctx.step("with no open offer: accept, payment link and withdraw → 404", async () => {
      const accept = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/billing/enterprise-offer/checkout",
          { account_id: team.id, success_url: "https://example.test/ok", cancel_url: "https://example.test/no" },
        );
      accept.status(404);
      const link = await admin.post("/v1/admin/api/accounts/:id/enterprise-contract/checkout-link", {}, { params: { id: team.id } });
      link.status(404);
      const withdraw = await admin.del("/v1/admin/api/accounts/:id/enterprise-offer", { params: { id: team.id } });
      withdraw.status(404);
    });
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
      // Exact-id filter, not `search` — same duplicate-account hazard as ADM-14.
      const r = await admin.get("/v1/admin/api/accounts", {
        query: { accountId: team.id, limit: "5" },
      });
      r.status(200)
        .body()
        .has("$.total", 1)
        .has("$.accounts[0].accountId", team.id)
        .has("$.accounts[0].trial", {
          status: "none",
          tier: null,
          startedAt: null,
          endsAt: null,
          note: null,
        })
        .has("$.accounts[0].contract", null)
        .has("$.accounts[0].graceEndsAt", null)
        .has("$.accounts[0].demoEnterprise", undefined)
        .has("$.accounts[0].enterpriseEntitled", undefined);
    });
  }
});

// ADM-23 — the entitlement-override map. One route for every override an
// account can carry, each with an OPTIONAL EXPIRY, which the single-purpose
// column routes above cannot express at all. Scoped to a FRESH run-owned team
// account, like every other write in this file.
flow(
  "ADM-23",
  { domain: "admin", routes: ["PUT /v1/admin/api/accounts/:id/overrides"] },
  async (ctx) => {
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .put("/v1/admin/api/accounts/:id/overrides", { sso: { value: true } }, { params: { id: NOPE } });
      r.status(401);
    });
    await ctx.step("non-admin OWNER → 403", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put("/v1/admin/api/accounts/:id/overrides", { sso: { value: true } }, { params: { id: NOPE } });
      r.status(403);
    });
    if (ctx.env.capabilities.admin) {
      const admin = ctx.client.withBearer(ctx.env.adminToken!, "ADMIN_TOKEN");
      const team = await ctx.fixtures.team({ name: ctx.fixtures.name("adm23-ovr") });
      const expires = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

      await ctx.step("admin: an unknown key → 400 (typos are not silently dropped)", async () => {
        const r = await admin.put(
          "/v1/admin/api/accounts/:id/overrides",
          { superAdmin: { value: true } },
          { params: { id: team.id } },
        );
        r.status(400);
      });
      await ctx.step("admin: a wrong-typed value → 400", async () => {
        const r = await admin.put(
          "/v1/admin/api/accounts/:id/overrides",
          { sso: { value: 1 } },
          { params: { id: team.id } },
        );
        r.status(400);
      });
      await ctx.step("admin: a removed key (computeRateMultiplier, enterpriseEntitled) → 400", async () => {
        for (const key of ["computeRateMultiplier", "enterpriseEntitled", "demoEnterprise"]) {
          const r = await admin.put(
            "/v1/admin/api/accounts/:id/overrides",
            { [key]: { value: true } },
            { params: { id: team.id } },
          );
          r.status(400);
        }
      });
      await ctx.step("admin: a non-ISO expires_at → 400", async () => {
        const r = await admin.put(
          "/v1/admin/api/accounts/:id/overrides",
          { sso: { value: true, expires_at: "next tuesday" } },
          { params: { id: team.id } },
        );
        r.status(400);
      });

      await ctx.step("admin sets a timed sso override → 200, stored with its expiry", async () => {
        const r = await admin.put(
          "/v1/admin/api/accounts/:id/overrides",
          { sso: { value: true, expires_at: expires } },
          { params: { id: team.id } },
        );
        r.status(200)
          .body()
          .has("$.ok", true)
          .has("$.overrides.sso.value", true)
          .has("$.overrides.sso.expires_at", expires);
      });
      await ctx.step("a second patch MERGES — the untouched key survives", async () => {
        const r = await admin.put(
          "/v1/admin/api/accounts/:id/overrides",
          { managedModels: { value: false } },
          { params: { id: team.id } },
        );
        r.status(200)
          .body()
          .has("$.overrides.sso.value", true)
          .has("$.overrides.managedModels.value", false);
      });
      await ctx.step("null deletes exactly that key", async () => {
        const r = await admin.put(
          "/v1/admin/api/accounts/:id/overrides",
          { sso: null },
          { params: { id: team.id } },
        );
        r.status(200)
          .body()
          .has("$.overrides.sso", undefined)
          .has("$.overrides.managedModels.value", false);
      });
      await ctx.step("an sso override switches the feature on for a Free account, in account-state", async () => {
        const set = await admin.put(
          "/v1/admin/api/accounts/:id/overrides",
          { sso: { value: true, expires_at: expires } },
          { params: { id: team.id } },
        );
        set.status(200);
        const state = await ctx.client.as(ctx.P.OWNER).get("/v1/billing/account-state", { query: { account_id: team.id } });
        state.status(200).body().has("$.plan.family", "free").has("$.tier.entitlements.sso", true);
      });
    }
  },
);

// ADM-20 — the fleet projects list. Asserted against a FRESH run-owned project
// so the never-run defaults (sessionCount 0, lastSessionAt null) are exact
// rather than whatever the first page happens to hold. The two sanitizer steps
// matter more than they look: both inputs reach Postgres as typed literals, so
// an unsanitized value is a 500, and an unsanitized accountId that were merely
// DROPPED would silently widen "one account" to the whole fleet.
flow("ADM-20", { domain: "admin", routes: ["GET /v1/admin/api/projects"] }, async (ctx) => {
  await ctx.step("ANON → 401", async () => {
    const r = await ctx.client.as(ctx.P.ANON).get("/v1/admin/api/projects", { query: { limit: "1" } });
    r.status(401);
  });
  await ctx.step("non-admin OWNER → 403", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/admin/api/projects", { query: { limit: "1" } });
    r.status(403);
  });
  if (ctx.env.capabilities.admin) {
    const admin = ctx.client.withBearer(ctx.env.adminToken!, "ADMIN_TOKEN");
    const name = ctx.fixtures.name("adm20-fleet");
    const project = await ctx.fixtures.project({ name });

    // `search` is a substring match over the PLATFORM-WIDE projects list and
    // `ctx.fixtures.name()` is deterministic per run, so an exact `$.total`
    // count is not a safe assertion: a client-retried `POST /v1/projects`
    // (core/client.ts retries POSTs with no idempotency guard) or a workflow
    // re-run that reuses `github.run_id` leaves two identically-named projects.
    // Unlike the accounts list this route has NO `projectId` filter
    // (apps/api/src/admin/index.ts:551-562 — only search/accountId/status), so
    // assert on THIS flow's own row instead of on how many rows came back.
    const ownRow = (r: { json: <T>() => T }): Record<string, unknown> => {
      const projects = (r.json<{ projects?: Record<string, unknown>[] }>().projects ?? []) as Record<
        string,
        unknown
      >[];
      const row = projects.find((p) => p.projectId === project.id);
      if (!row) {
        throw new Error(
          `the fleet list did not return project ${project.id}; got ${JSON.stringify(
            projects.map((p) => p.projectId),
          )}`,
        );
      }
      return row;
    };

    await ctx.step("a never-run project carries the account join and zeroed session counts", async () => {
      const r = await admin.get("/v1/admin/api/projects", {
        query: { search: name, limit: "100" },
      });
      r.status(200).body().has("$.page", 1).has("$.limit", 100);
      const row = ownRow(r);
      const expected = {
        name,
        status: "active",
        accountId: ctx.P.OWNER.accountId!,
        ownerEmail: ctx.P.OWNER.email!,
        sessionCount: 0,
        activeSessionCount: 0,
        lastSessionAt: null,
      };
      for (const [field, want] of Object.entries(expected)) {
        if (row[field] !== want) {
          throw new Error(
            `fleet row ${field}: expected ${JSON.stringify(want)}, got ${JSON.stringify(row[field])}`,
          );
        }
      }
      if (!row.createdAt) throw new Error("fleet row is missing createdAt");
    });

    await ctx.step("search also matches the owning account's member email", async () => {
      const r = await admin.get("/v1/admin/api/projects", {
        query: { search: ctx.P.OWNER.email!, accountId: ctx.P.OWNER.accountId!, limit: "100" },
      });
      r.status(200).body().exists("$.projects[0].projectId");
    });

    await ctx.step("every sortBy is accepted, in both directions", async () => {
      for (const sortBy of ["activity", "created", "sessions"]) {
        for (const sortDir of ["asc", "desc"]) {
          const r = await admin.get("/v1/admin/api/projects", {
            query: { search: name, sortBy, sortDir, limit: "100" },
          });
          r.status(200);
          ownRow(r);
        }
      }
    });

    await ctx.step("status filter selects and excludes; an unknown value degrades to no filter", async () => {
      const active = await admin.get("/v1/admin/api/projects", {
        query: { search: name, status: "active", limit: "100" },
      });
      active.status(200);
      ownRow(active);

      // 0 stays an exact count: a duplicate of this project would also be
      // `active`, so nothing this run creates can land in the archived page.
      const archived = await admin.get("/v1/admin/api/projects", {
        query: { search: name, status: "archived", limit: "100" },
      });
      archived.status(200).body().has("$.total", 0);

      const bogus = await admin.get("/v1/admin/api/projects", {
        query: { search: name, status: "not-a-status", limit: "100" },
      });
      bogus.status(200);
      ownRow(bogus);
    });

    await ctx.step("a non-uuid accountId narrows to an empty page, never to the fleet", async () => {
      const r = await admin.get("/v1/admin/api/projects", {
        query: { accountId: "not-a-uuid", limit: "5" },
      });
      r.status(200).body().has("$.total", 0).has("$.projects", []);
    });

    await ctx.step("limit is capped at 100", async () => {
      const r = await admin.get("/v1/admin/api/projects", { query: { limit: "1000" } });
      r.status(200).body().has("$.limit", 100);
    });
  }
});

// ADM-19 — the access sweep cron (the path keeps its old trial-expiry name: the
// scheduler calls it). Same `requireInternalCronAuth` gate as BILL-13/BILL-16
// (Bearer or X-Kortix-Internal-Key must timing-safe-equal INTERNAL_SERVICE_KEY).
// It grants nothing: it ends manual licenses whose term is over and sends the
// due license warnings, so the real call is safe when the internal key is
// available. `serial+global` because it reads across every account. A
// KORTIX_BILLING_INTERNAL_ENABLED=false deployment answers 200 {skipped:true}.
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
      await ctx.step("internal cron key → 200 {contracts_ended:n, warnings_sent:n}", async () => {
        const r = await ctx.client
          .withBearer(ctx.env.internalServiceKey!, "INTERNAL_CRON")
          .post("/v1/billing/cron/trial-expiry", {});
        r.status(200).body().exists("$.contracts_ended").exists("$.warnings_sent");
      });
    }
  },
);

// ADM-21 / ADM-22 — activity analytics (apps/api/src/admin/analytics.ts).
//
// These two routes carry NO middleware of their own: `analyticsApp` is mounted
// inside `adminApp` BELOW its global `supabaseAuth` + `requireAdmin` gate and
// relies entirely on inheriting it. The ANON/OWNER steps are therefore the real
// point of these flows, not boilerplate — they are what proves the inherited
// gate fires on a sub-router path.
//
// Note the path shape: `/v1/admin/analytics/*`, with no `api` segment, unlike
// every `/v1/admin/api/*` console route above.
//
// Read-only. Nothing is created, so there is nothing to track or clean up.

interface ActivityDay {
  date: string;
  sessionsCreated: number;
  activeAccounts: number;
  activeUsers: number;
  newAccounts: number;
  activeProjects: number;
}

flow("ADM-21", { domain: "admin", routes: ["GET /v1/admin/analytics/activity"] }, async (ctx) => {
  await ctx.step("ANON → 401 (inherited gate)", async () => {
    const r = await ctx.client.as(ctx.P.ANON).get("/v1/admin/analytics/activity");
    r.status(401);
  });
  await ctx.step("non-admin OWNER → 403 (inherited gate)", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/admin/analytics/activity");
    r.status(403);
  });
  if (ctx.env.capabilities.admin) {
    const admin = ctx.client.withBearer(ctx.env.adminToken!, "ADMIN_TOKEN");

    await ctx.step("platform admin reads the activity series → 200", async () => {
      const r = await admin.get("/v1/admin/analytics/activity", { query: { days: "7" } });
      r.status(200)
        .body()
        .exists("$.days")
        .exists("$.summary.sessionsLast7d")
        .exists("$.summary.sessionsPrev7d")
        .exists("$.summary.dau")
        .exists("$.summary.wau")
        .exists("$.summary.mau")
        .exists("$.summary.totalAccounts")
        .exists("$.summary.totalProjects");

      const days = r.json<{ days: ActivityDay[] }>().days;
      // Dense series: one entry per requested UTC day, zero-filled. A sparse
      // GROUP BY result would draw a flat line across a dead day and read as
      // "steady" when the truth is "nothing happened".
      if (days.length !== 7) {
        throw new Error(`days=7 should return 7 dense entries, got ${days.length}`);
      }
      for (const key of [
        "date",
        "sessionsCreated",
        "activeAccounts",
        "activeUsers",
        "newAccounts",
        "activeProjects",
      ] as const) {
        if (!(key in days[0]!)) throw new Error(`day entry is missing "${key}"`);
      }
      // Ascending, oldest first — the charts render in array order.
      const dates = days.map((d) => d.date);
      if ([...dates].sort().join() !== dates.join()) {
        throw new Error(`day entries are not ascending: ${dates.join(",")}`);
      }
    });

    await ctx.step("days is clamped to [1,90], never rejected", async () => {
      const count = async (days: string) => {
        const r = await admin.get("/v1/admin/analytics/activity", { query: { days } });
        r.status(200);
        return r.json<{ days: ActivityDay[] }>().days.length;
      };
      const zero = await count("0");
      if (zero !== 1) throw new Error(`days=0 should clamp to 1 entry, got ${zero}`);
      const huge = await count("9999");
      if (huge !== 90) throw new Error(`days=9999 should clamp to 90 entries, got ${huge}`);
      const junk = await count("abc");
      if (junk !== 30) throw new Error(`days=abc should fall back to 30 entries, got ${junk}`);
    });
  }
});

interface UsageDay {
  date: string;
  computeUsd: number;
  llmUsd: number;
  otherUsd: number;
  totalUsd: number;
  payingAccounts: number;
}

flow("ADM-22", { domain: "admin", routes: ["GET /v1/admin/analytics/usage"] }, async (ctx) => {
  await ctx.step("ANON → 401 (inherited gate)", async () => {
    const r = await ctx.client.as(ctx.P.ANON).get("/v1/admin/analytics/usage");
    r.status(401);
  });
  await ctx.step("non-admin OWNER → 403 (inherited gate)", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/admin/analytics/usage");
    r.status(403);
  });
  if (ctx.env.capabilities.admin) {
    const admin = ctx.client.withBearer(ctx.env.adminToken!, "ADMIN_TOKEN");

    await ctx.step("platform admin reads the credit-burn series → 200", async () => {
      const r = await admin.get("/v1/admin/analytics/usage", { query: { days: "7" } });
      r.status(200)
        .body()
        .exists("$.days")
        .exists("$.summary.totalUsd")
        .exists("$.summary.computeUsd")
        .exists("$.summary.llmUsd")
        .exists("$.summary.otherUsd")
        .exists("$.summary.spendLast7d")
        .exists("$.summary.spendPrev7d")
        .exists("$.summary.payingAccountsLast7d");

      const days = r.json<{ days: UsageDay[] }>().days;
      if (days.length !== 7) {
        throw new Error(`days=7 should return 7 dense entries, got ${days.length}`);
      }
      for (const day of days) {
        // The invariant that makes the stacked chart honest: the total is the
        // sum of the segments actually drawn, never an independent SUM that can
        // disagree with its own breakdown.
        const parts = day.computeUsd + day.llmUsd + day.otherUsd;
        if (Math.abs(parts - day.totalUsd) > 1e-9) {
          throw new Error(`${day.date}: totalUsd ${day.totalUsd} != compute+llm+other ${parts}`);
        }
        // Debits are reported as positive magnitudes, never signed ledger values.
        if (day.totalUsd < 0 || day.payingAccounts < 0) {
          throw new Error(`${day.date}: negative value in ${JSON.stringify(day)}`);
        }
      }
    });
  }
});

// IMP-1 — act-as impersonation, end to end. The one flow where a platform
// admin's requests land on ANOTHER account, so it asserts both directions:
// the grant works exactly as far as it should, and not one route further.
flow(
  "IMP-1",
  {
    domain: "admin",
    routes: [
      "POST /v1/admin/api/impersonate",
      "DELETE /v1/admin/api/impersonate/:grantId",
      "GET /v1/admin/api/impersonate/active",
      "POST /v1/accounts/:accountId/members",
      "POST /v1/account/request-deletion",
      "POST /v1/account/cancel-deletion",
      "DELETE /v1/account/delete-immediately",
      "GET /v1/account/deletion-status",
    ],
  },
  async (ctx) => {
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/admin/api/impersonate", { account_id: NOPE });
      r.status(401);
    });
    await ctx.step("non-admin OWNER → 403", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/admin/api/impersonate", { account_id: NOPE });
      r.status(403);
    });
    await ctx.step("ANON cannot revoke either", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .del("/v1/admin/api/impersonate/:grantId", { params: { grantId: NOPE } });
      r.status(401);
    });

    if (!ctx.env.capabilities.admin) return;

    const admin = ctx.client.withBearer(ctx.env.adminToken!, "ADMIN_TOKEN");
    const victim = await ctx.fixtures.team({ name: ctx.fixtures.name("imp1-victim") });
    let grantId = "";

    await ctx.step("a grant on a nonexistent account → 404, not a dangling row", async () => {
      // A FRESH random uuid, not the shared NOPE constant: the all-zeros uuid
      // is a real `accounts` row on a local database (a bootstrap leftover),
      // and this is the one step in the file whose route actually resolves the
      // account id rather than failing auth before it looks.
      const r = await admin.post("/v1/admin/api/impersonate", {
        account_id: crypto.randomUUID(),
      });
      r.status(404);
    });
    await ctx.step("a malformed account id → 400", async () => {
      const r = await admin.post("/v1/admin/api/impersonate", { account_id: "not-a-uuid" });
      r.status(400);
    });

    await ctx.step("admin mints a grant → 200 with a server-chosen expiry ≤ 1h", async () => {
      const r = await admin.post("/v1/admin/api/impersonate", {
        account_id: victim.id,
        reason: "ke2e IMP-1",
      });
      r.status(200).body().exists("$.grant_id").has("$.account_id", victim.id);
      const body = r.json<{ grant_id: string; expires_at: string }>();
      grantId = body.grant_id;
      const ttlMs = Date.parse(body.expires_at) - Date.now();
      if (!(ttlMs > 0 && ttlMs <= 60 * 60 * 1000 + 60_000)) {
        throw new Error(`expires_at is not within the one-hour cap: ${body.expires_at}`);
      }
    });

    const acting = (headers: Record<string, string> = {}) => ({
      headers: { "x-kortix-impersonate": grantId, ...headers },
    });

    await ctx.step("acting-as, /v1/accounts is the TARGET account only", async () => {
      const r = await admin.get("/v1/accounts", acting());
      r.status(200);
      const accounts = r.json<Array<{ account_id: string }>>();
      if (accounts.length !== 1 || accounts[0]?.account_id !== victim.id) {
        throw new Error(
          `acting-as should see exactly the target account, got ${JSON.stringify(accounts.map((a) => a.account_id))}`,
        );
      }
    });

    const renamed = ctx.fixtures.name("imp1-renamed");
    await ctx.step("acting-as, a customer-visible WRITE lands on the target", async () => {
      const r = await admin.patch(
        "/v1/accounts/:accountId",
        { name: renamed },
        { params: { accountId: victim.id }, ...acting() },
      );
      r.status(200);
    });
    await ctx.step("the write is visible on the target account, read back as ADMIN", async () => {
      const r = await admin.get("/v1/admin/api/accounts", {
        query: { accountId: victim.id, limit: "1" },
      });
      r.status(200).body().has("$.accounts[0].name", renamed);
    });

    await ctx.step("acting-as CANNOT reach the admin console (no nesting)", async () => {
      const list = await admin.get("/v1/admin/api/accounts", acting());
      list.status(403).body().has("$.code", "impersonation_invalid");
      const nested = await admin.post(
        "/v1/admin/api/impersonate",
        { account_id: victim.id },
        acting(),
      );
      nested.status(403).body().has("$.code", "impersonation_invalid");
    });

    await ctx.step("acting-as CANNOT mint a credential that outlives the grant", async () => {
      const r = await admin.post("/v1/accounts/tokens", { name: "imp1-should-fail" }, acting());
      r.status(403).body().has("$.code", "impersonation_invalid");
    });

    // The cheapest way to turn one hour of act-as into permanent, unmarked
    // access: add yourself to the customer's account. Blocked with the same
    // 403 as a credential mint, for the same reason.
    await ctx.step("acting-as CANNOT grant itself durable membership", async () => {
      const r = await admin.post(
        "/v1/accounts/:accountId/members",
        { email: "imp1-should-fail@ke2e.kortix.test", role: "admin" },
        { params: { accountId: victim.id }, ...acting() },
      );
      r.status(403).body().has("$.code", "impersonation_invalid");
    });

    // Account deletion runs as the REAL caller. Inside the customer's account
    // the operator became the requester: the request named the operator, and
    // the deletion would sweep the operator's own accounts and delete the
    // operator's login.
    await ctx.step("acting-as CANNOT request, cancel or run account deletion", async () => {
      const request = await admin.post("/v1/account/request-deletion", { reason: "imp1-should-fail" }, acting());
      request.status(403).body().has("$.code", "impersonation_invalid");
      const run = await admin.del("/v1/account/delete-immediately", acting());
      run.status(403).body().has("$.code", "impersonation_invalid");
      const cancel = await admin.post("/v1/account/cancel-deletion", {}, acting());
      cancel.status(403).body().has("$.code", "impersonation_invalid");
    });
    await ctx.step("acting-as, the deletion status read stays open and shows nothing scheduled", async () => {
      const r = await admin.get("/v1/account/deletion-status", acting());
      r.status(200).body().has("$.has_pending_deletion", false);
    });

    await ctx.step("a grant id nobody holds → 403, never a fall-back to own account", async () => {
      const r = await admin.get("/v1/accounts", {
        headers: { "x-kortix-impersonate": NOPE },
      });
      r.status(403).body().has("$.code", "impersonation_invalid");
    });
    await ctx.step("a garbage grant id → 403, not a 500", async () => {
      const r = await admin.get("/v1/accounts", {
        headers: { "x-kortix-impersonate": "'; drop table --" },
      });
      r.status(403);
    });
    await ctx.step("the OWNER presenting the ADMIN's real grant → 403", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/accounts", acting());
      r.status(403).body().has("$.code", "impersonation_invalid");
    });

    await ctx.step("the grant is listed as active while it lives", async () => {
      const r = await admin.get("/v1/admin/api/impersonate/active");
      r.status(200);
      const grants = r.json<{ grants: Array<{ grant_id: string; account_id: string }> }>().grants;
      if (!grants.some((g) => g.grant_id === grantId && g.account_id === victim.id)) {
        throw new Error(`active grants did not include ${grantId}`);
      }
    });

    await ctx.step("admin revokes → 200", async () => {
      const r = await admin.del("/v1/admin/api/impersonate/:grantId", {
        params: { grantId },
      });
      r.status(200).body().has("$.ok", true).has("$.grant_id", grantId);
    });
    await ctx.step("the revoked grant stops working on the very next request", async () => {
      const r = await admin.get("/v1/accounts", acting());
      r.status(403).body().has("$.code", "impersonation_invalid");
    });
    await ctx.step("and it is gone from the active list", async () => {
      const r = await admin.get("/v1/admin/api/impersonate/active");
      r.status(200);
      const grants = r.json<{ grants: Array<{ grant_id: string }> }>().grants;
      if (grants.some((g) => g.grant_id === grantId)) {
        throw new Error(`revoked grant ${grantId} is still listed as active`);
      }
    });
    await ctx.step("revoking a grant the caller does not hold → 404", async () => {
      const r = await admin.del("/v1/admin/api/impersonate/:grantId", {
        params: { grantId: NOPE },
      });
      r.status(404);
    });
  },
);

// ADM-24 — the live-Stripe-subscription read the detail sheet renders next to
// the resolved plan badge. An account with no stripe_subscription_id answers
// {subscription:null} WITHOUT any Stripe call, which is the whole locally
// assertable contract (the local profile excludes Stripe).
flow("ADM-24", { domain: "admin", routes: ["GET /v1/admin/api/accounts/:id/subscription"] }, async (ctx) => {
  await ctx.step("ANON → 401", async () => {
    const r = await ctx.client.as(ctx.P.ANON).get("/v1/admin/api/accounts/:id/subscription", { params: { id: NOPE } });
    r.status(401);
  });
  await ctx.step("non-admin OWNER → 403", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/admin/api/accounts/:id/subscription", { params: { id: NOPE } });
    r.status(403);
  });
  if (ctx.env.capabilities.admin) {
    await ctx.step("platform admin on an account with no subscription on file → 200 {subscription:null}", async () => {
      const account = await ctx.fixtures.team({ name: ctx.fixtures.name("admin-no-subscription") });
      const r = await ctx.client
        .withBearer(ctx.env.adminToken!, "ADMIN_TOKEN")
        .get("/v1/admin/api/accounts/:id/subscription", { params: { id: account.id } });
      r.status(200).body().has("$.subscription", null);
    });
    await ctx.step("malformed account id → 200 {subscription:null} (shape-checked, no 22P02 500)", async () => {
      const r = await ctx.client
        .withBearer(ctx.env.adminToken!, "ADMIN_TOKEN")
        .get("/v1/admin/api/accounts/:id/subscription", { params: { id: "not-a-uuid" } });
      r.status(200).body().has("$.subscription", null);
    });
  }
});

// ADM-25 — KRTX-1715 path B. The self-host operator allowlist
// (KORTIX_PLATFORM_ADMIN_EMAILS) makes a password identity platform admin and
// the self-host operator, never an SSO one: any account admin can register an
// IdP that asserts the allowlisted address. The local profile boots the API
// with one synthetic allowlisted address (`env.platformAdminEmail`); a cloud
// target has no allowlist and runs the boundary steps only. The password
// identity's 200 is the control: without it, a missing allowlist would make
// the SSO identity's 403 vacuous.
flow(
  "ADM-25",
  {
    domain: "admin",
    routes: ["GET /v1/admin/api/impersonate/active", "GET /v1/projects/git/backend/repositories"],
  },
  async (ctx) => {
    await ctx.step("ANON → 401", async () => {
      (await ctx.client.as(ctx.P.ANON).get("/v1/admin/api/impersonate/active")).status(401);
    });
    await ctx.step("non-admin OWNER → 403", async () => {
      (await ctx.client.as(ctx.P.OWNER).get("/v1/admin/api/impersonate/active")).status(403);
    });

    const allowlisted = ctx.env.platformAdminEmail;
    if (!allowlisted || !ctx.env.capabilities.database) return;

    await ctx.step("an identity a previous attempt left on the allowlisted address is deleted first", async () => {
      // A non-SSO email is unique in Auth, so a leftover would block the create below.
      const left = await withDb(ctx, (db) =>
        db.query("SELECT id::text AS id FROM auth.users WHERE lower(email) = $1", [allowlisted]),
      );
      for (const row of left.rows as Array<{ id: string }>) await adminDeleteUser(ctx.env, row.id);
    });

    let operator!: Principal;
    await ctx.step("a password identity with the allowlisted email is platform admin and the operator", async () => {
      operator = await ctx.fixtures.userWithEmail(allowlisted, { label: "ALLOWLISTED" });
      const admin = await ctx.client.as(operator).get("/v1/admin/api/impersonate/active");
      admin.status(200).body().exists("$.grants");
      // Past the operator gate: no git backend (409) or the backend's own answer, never 403.
      const backend = await ctx.client.as(operator).get("/v1/projects/git/backend/repositories");
      if (backend.statusCode === 403) {
        throw new Error(`the allowlisted password identity is not the operator: ${backend.text()}`);
      }
    });

    await ctx.step("the same address as an SSO identity → 403 on the admin console and the operator gate", async () => {
      const sso = ctx.client.withBearer(
        await ssoFixtureToken(ctx.env, operator, crypto.randomUUID(), []),
        "SSO-ALLOWLISTED",
      );
      (await sso.get("/v1/admin/api/impersonate/active")).status(403);
      (await sso.get("/v1/projects/git/backend/repositories"))
        .status(403)
        .body()
        .has("$.error", "The instance git backend is only browsable by a self-host operator");
    });
  },
);
