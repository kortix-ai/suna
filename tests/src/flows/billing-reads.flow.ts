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

    await ctx.step("OWNER reads the visible tier configurations", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/billing/tier-configurations");
      r.status(OWNER_READ);
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

// BILL-15 — /deduct and /deduct-usage (credits.ts). These are NOT internal-
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
  "BILL-15",
  {
    domain: "billing",
    routes: ["POST /v1/billing/deduct", "POST /v1/billing/deduct-usage"],
  },
  async (ctx) => {
    await ctx.step("ANON cannot deduct → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/billing/deduct", { prompt_tokens: 0, completion_tokens: 0, model: "gpt-4o" });
      r.status(401);
    });
    await ctx.step("OWNER: zero-token deduct is a real no-op 200 (no balance change)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/billing/deduct", { prompt_tokens: 0, completion_tokens: 0, model: "gpt-4o" });
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
  },
);
