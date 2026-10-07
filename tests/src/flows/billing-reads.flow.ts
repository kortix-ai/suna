/**
 * Billing — reads, credits, transactions, and auto-topup. Maps to spec §20:
 *   BILL-5  → transactions, purchase-credits
 *   BILL-6  → auto-topup settings/setup-status/configure
 *
 * NOTE on status SETS: every protected billing route sits behind `supabaseAuth`
 * (ANON → 401) AND a billing-enabled gate (when billing is disabled the gate
 * short-circuits with 404 / `{skipped:true}`). The reads otherwise return 200
 * for the OWNER against their own/team account. So OWNER reads assert the
 * permissive [200, 404] set (404 only when the deployment runs with billing
 * off); ANON asserts 401. No mocking — codes are pinned from the handlers in
 * apps/api/src/billing/routes/.
 */
import { flow } from "../core/flow";

// OWNER reads succeed (200) on a billing-enabled deployment; 404 when the
// billing internal gate is disabled (self-hosted / local).
const OWNER_READ = [200, 404];

flow(
  "BILL-5",
  {
    domain: "billing",
    tags: ["smoke"],
    routes: [
      "GET /v1/billing/transactions",
      "POST /v1/billing/purchase-credits",
    ],
  },
  async (ctx) => {
    await ctx.step("OWNER reads transactions", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/billing/transactions", { query: { limit: "5" } });
      r.status(OWNER_READ);
    });
    await ctx.step("ANON cannot read transactions → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/billing/transactions");
      r.status(401);
    });

    await ctx.step("purchase-credits with no amount → 400 (or gate 404)", async () => {
      // Missing/invalid amount → BillingError(400). A valid amount would build a
      // real Stripe checkout; we deliberately exercise the validation boundary.
      const r = await ctx.client.as(ctx.P.OWNER).post("/v1/billing/purchase-credits", {});
      r.status([400, 404]);
    });
  },
);

flow(
  "BILL-6",
  {
    domain: "billing",
    serial: true,
    routes: [
      "GET /v1/billing/auto-topup/settings",
      "GET /v1/billing/auto-topup/setup-status",
      "POST /v1/billing/auto-topup/configure",
    ],
  },
  async (ctx) => {
    await ctx.step("OWNER reads auto-topup settings", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/billing/auto-topup/settings");
      r.status(OWNER_READ);
    });
    await ctx.step("ANON cannot read auto-topup settings → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/billing/auto-topup/settings");
      r.status(401);
    });

    await ctx.step("OWNER reads auto-topup setup status", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/billing/auto-topup/setup-status");
      r.status(OWNER_READ);
    });

    await ctx.step("OWNER configures auto-topup (disable)", async () => {
      // Disabling needs no Stripe payment method; the service coerces inputs and
      // returns a result (200). Validation failures would surface as 400; the
      // billing gate as 404.
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/billing/auto-topup/configure", { enabled: false, threshold: 5, amount: 10 });
      r.status([200, 400, 404]);
    });
  },
);

// BILL-14 — five more account-scoped reads (credits.ts + payments.ts). All
// sit behind the same supabaseAuth + billing-enabled gate as BILL-5/BILL-6:
// OWNER_READ ([200,404]) on their own account, ANON → 401. tier-configurations
// is NOT public — billingApp's auth middleware only skips /account-state,
// /webhooks, and /cron/, so it's supabaseAuth-gated like every other route here.
flow(
  "BILL-14",
  {
    domain: "billing",
    routes: [
      "GET /v1/billing/credit-breakdown",
      "GET /v1/billing/credit-usage",
      "GET /v1/billing/tier-configurations",
      "GET /v1/billing/transactions/summary",
      "GET /v1/billing/usage-history",
    ],
  },
  async (ctx) => {
    await ctx.step("OWNER reads the credit balance breakdown", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/billing/credit-breakdown");
      r.status(OWNER_READ);
    });
    await ctx.step("a team member with no credit row of their own reads an all-zero breakdown, not an error", async () => {
      const team = await ctx.fixtures.team();
      const member = await team.addMember("member");
      const r = await ctx.client.as(member).get("/v1/billing/credit-breakdown");
      r.status(OWNER_READ);
      if (r.statusCode !== 200) return;
      r.body().has("$.total", 0).has("$.expiring", 0).has("$.non_expiring", 0).has("$.daily", 0);
    });
    await ctx.step("ANON cannot read the credit breakdown → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/billing/credit-breakdown");
      r.status(401);
    });

    await ctx.step("OWNER reads a page of credit-usage records", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/billing/credit-usage", { query: { limit: "5" } });
      r.status(OWNER_READ);
    });
    await ctx.step("ANON cannot read credit-usage → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/billing/credit-usage");
      r.status(401);
    });

    await ctx.step("OWNER reads the visible tiers: free and pro listed, the internal none tier hidden", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/billing/tier-configurations");
      r.status(OWNER_READ);
      if (r.statusCode !== 200) return;
      const tiers = r.json<{ tiers: Array<{ name: string; display_name: string; monthly_price: number }> }>().tiers;
      const names = tiers.map((t) => t.name);
      if (!names.includes("free") || !names.includes("pro")) throw new Error(`expected free and pro, got ${JSON.stringify(names)}`);
      if (names.includes("none")) throw new Error("the internal `none` tier is listed");
      const pro = tiers.find((t) => t.name === "pro")!;
      if (pro.display_name !== "Pro" || pro.monthly_price !== 20) throw new Error(`unexpected pro tier: ${JSON.stringify(pro)}`);
    });
    await ctx.step("ANON cannot read tier-configurations → 401 (auth-gated, not public)", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/billing/tier-configurations");
      r.status(401);
    });

    await ctx.step("OWNER reads the transaction summary window", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/billing/transactions/summary", { query: { days: "30" } });
      r.status(OWNER_READ);
    });
    await ctx.step("ANON cannot read the transaction summary → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/billing/transactions/summary");
      r.status(401);
    });

    await ctx.step("OWNER reads the credit usage history summary", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/billing/usage-history", { query: { days: "30" } });
      r.status(OWNER_READ);
    });
    await ctx.step("ANON cannot read usage-history → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/billing/usage-history");
      r.status(401);
    });
  },
);

// BILL-7 — /deduct and /deduct-usage (credits.ts). These are NOT internal-
// cron-only: they sit behind the SAME plain supabaseAuth gate as every other
// billing route here (billingApp's wildcard auth middleware only special-cases
// /webhook and /cron/ paths) and resolve accountId directly from the caller's
// own userId — i.e. any authenticated user can call these on themselves. Both
// handlers short-circuit to a real, genuine 200 with NO ledger write whenever
// the computed cost/amount is <= 0 (see credits.ts: `if (cost <= 0) return
// {success:true, cost:0, ...}` / `if (!amount || amount <= 0) return
// {success:true, cost:0, ...}`), so a zero-cost call exercises the real route
// and real response shape without touching the account's actual credit
// balance.
flow(
  "BILL-7",
  {
    domain: "billing",
    routes: ["POST /v1/billing/deduct", "POST /v1/billing/deduct-usage"],
  },
  async (ctx) => {
    await ctx.step("ANON cannot deduct → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/billing/deduct", {
          prompt_tokens: 0,
          completion_tokens: 0,
          model: "glm-5.3-flash",
        });
      r.status(401);
    });
    await ctx.step("OWNER: zero-token deduct is a real no-op 200 (no balance change)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/billing/deduct", {
          prompt_tokens: 0,
          completion_tokens: 0,
          model: "glm-5.3-flash",
        });
      r.status([200, 404]);
      if (r.statusCode === 200) {
        r.body().has("$.success", true).has("$.cost", 0);
      }
    });

    await ctx.step("ANON cannot deduct-usage → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/billing/deduct-usage", { amount: 0 });
      r.status(401);
    });
    await ctx.step("OWNER: zero-amount deduct-usage is a real no-op 200 (no balance change)", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post("/v1/billing/deduct-usage", { amount: 0 });
      r.status([200, 404]);
      if (r.statusCode === 200) {
        r.body().has("$.success", true).has("$.cost", 0);
      }
    });
    await ctx.step("OWNER: negative-amount deduct-usage is a no-op 200 with cost 0 (never a credit)", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post("/v1/billing/deduct-usage", { amount: -5 });
      r.status([200, 404]);
      if (r.statusCode === 200) r.body().has("$.success", true).has("$.cost", 0);
    });
  },
);

// BILL-7b — the debit path BILL-7 cannot reach without credit. The platform
// admin grants a fresh account $5 non-expiring; the account then debits
// through /deduct-usage and /deduct and reads every movement back. A debit
// beyond the balance → 402 and moves nothing.
flow(
  "BILL-7b",
  {
    domain: "billing",
    requires: ["admin"],
    routes: [
      "POST /v1/admin/api/accounts/:id/credits",
      "GET /v1/billing/credit-breakdown",
      "GET /v1/billing/usage-history",
      "POST /v1/billing/deduct-usage",
      "POST /v1/billing/deduct",
    ],
  },
  async (ctx) => {
    const user = await ctx.fixtures.user({ label: "BILL-7b" });
    const asUser = ctx.client.as(user);
    const admin = ctx.client.withBearer(ctx.env.adminToken!, "ADMIN_TOKEN");
    const close = (a: number, b: number) => Math.abs(a - b) < 1e-4;
    type Breakdown = { total: number; expiring: number; non_expiring: number; daily: number };
    type Usage = { totalCredits: number; totalDebits: number; count: number };
    const breakdown = async () => {
      const r = await asUser.get("/v1/billing/credit-breakdown");
      r.status(200);
      return r.json<Breakdown>();
    };
    const usage = async () => {
      const r = await asUser.get("/v1/billing/usage-history", { query: { days: "7" } });
      r.status(200);
      return r.json<Usage>();
    };

    let base!: Breakdown;
    let baseUsage!: Usage;
    await ctx.step("baseline: the breakdown and the 7-day usage summary read as numbers", async () => {
      base = await breakdown();
      baseUsage = await usage();
      for (const [k, v] of Object.entries({ ...base, ...baseUsage })) {
        if (typeof v !== "number" || Number.isNaN(v)) throw new Error(`${k}: expected a number, got ${JSON.stringify(v)}`);
      }
    });
    await ctx.step("admin grants $5 non-expiring → total and non_expiring each rise by exactly 5", async () => {
      (await admin.post(
        "/v1/admin/api/accounts/:id/credits",
        { amount: 5, description: "ke2e BILL-7b grant", isExpiring: false },
        { params: { id: user.accountId! } },
      )).status(200).body().has("$.ok", true);
      const after = await breakdown();
      if (!close(after.total, base.total + 5) || !close(after.non_expiring, base.non_expiring + 5)) {
        throw new Error(`expected +5 on total and non_expiring: before=${JSON.stringify(base)} after=${JSON.stringify(after)}`);
      }
    });
    const usageAmount = 0.25;
    await ctx.step("deduct-usage $0.25 → 200 with that cost, the new balance, and a transaction id", async () => {
      const r = await asUser.post("/v1/billing/deduct-usage", { amount: usageAmount, description: "ke2e BILL-7b usage" });
      r.status(200).body().has("$.success", true).exists("$.transaction_id");
      const body = r.json<{ cost: number; new_balance: number }>();
      if (!close(body.cost, usageAmount)) throw new Error(`cost ${body.cost}, expected ${usageAmount}`);
      if (!close(body.new_balance, base.total + 5 - usageAmount)) {
        throw new Error(`new_balance ${body.new_balance}, expected ${base.total + 5 - usageAmount}`);
      }
    });
    let tokenCost = 0;
    await ctx.step("deduct 1M+1M tokens of a priced model → 200, cost > 0, the balance falls by exactly that cost", async () => {
      const r = await asUser.post("/v1/billing/deduct", {
        prompt_tokens: 1_000_000,
        completion_tokens: 1_000_000,
        model: "glm-5.3-flash",
      });
      r.status(200).body().has("$.success", true).exists("$.transaction_id");
      const body = r.json<{ cost: number; new_balance: number }>();
      if (!(body.cost > 0)) throw new Error(`expected a positive cost, got ${body.cost}`);
      tokenCost = body.cost;
      const expected = base.total + 5 - usageAmount - tokenCost;
      if (!close(body.new_balance, expected)) throw new Error(`new_balance ${body.new_balance}, expected ${expected}`);
      const after = await breakdown();
      if (!close(after.total, expected)) throw new Error(`breakdown total ${after.total}, expected ${expected}`);
    });
    await ctx.step("deduct-usage beyond the balance → 402 insufficient credits, balance unchanged", async () => {
      const before = await breakdown();
      const r = await asUser.post("/v1/billing/deduct-usage", { amount: 1_000_000 });
      r.status(402).body().matches("$.error", /^Insufficient credits/);
      const after = await breakdown();
      if (!close(after.total, before.total)) throw new Error(`a refused debit moved the balance: ${before.total} → ${after.total}`);
    });
    await ctx.step("usage-history counts the grant and both debits: +5 credits, +(0.25 + token cost) debits, +3 rows", async () => {
      const after = await usage();
      if (!close(after.totalCredits - baseUsage.totalCredits, 5)) throw new Error(`credits delta ${after.totalCredits - baseUsage.totalCredits}`);
      if (!close(after.totalDebits - baseUsage.totalDebits, usageAmount + tokenCost)) {
        throw new Error(`debits delta ${after.totalDebits - baseUsage.totalDebits}, expected ${usageAmount + tokenCost}`);
      }
      if (after.count - baseUsage.count !== 3) throw new Error(`ledger rows delta ${after.count - baseUsage.count}, expected 3`);
    });
  },
);
