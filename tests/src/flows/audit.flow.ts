/**
 * Account-scoped audit surface (apps/api/src/accounts/audit.ts, mounted under
 * /v1/accounts). Reads gated on audit.read; webhook CRUD gated on account.write.
 * Uses ctx.fixtures.team() — OWNER is authorized, NONMEMBER → 403. Maps to AUD-*.
 */
import { flow } from "../core/flow";

// ── AUD-1: list audit events ─────────────────────────────────────────────────
flow(
  "AUD-1",
  { domain: "audit", serial: true, routes: ["GET /v1/accounts/:accountId/audit"] },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    await ctx.step("OWNER lists audit events → 200 with events array", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/accounts/:accountId/audit", { params: { accountId: team.id } });
      r.status(200).body().exists("$.events");
    });
    await ctx.step("limit/action filter honored → 200", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/accounts/:accountId/audit", {
        params: { accountId: team.id },
        query: { limit: "5", action: "iam." },
      });
      r.status(200).body().exists("$.events");
    });
    await ctx.step("NONMEMBER → 403", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/accounts/:accountId/audit", { params: { accountId: team.id } });
      r.status(403);
    });
  },
);

// ── AUD-2: export ────────────────────────────────────────────────────────────
flow(
  "AUD-2",
  { domain: "audit", serial: true, routes: ["GET /v1/accounts/:accountId/audit/export"] },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    await ctx.step("export defaults to CSV → 200 text/csv", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/accounts/:accountId/audit/export", { params: { accountId: team.id } });
      r.status(200).headerEquals("content-type", /csv/);
    });
    await ctx.step("export format=jsonl → 200 ndjson", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/accounts/:accountId/audit/export", {
        params: { accountId: team.id },
        query: { format: "jsonl" },
      });
      r.status(200).headerEquals("content-type", /ndjson/);
    });
    await ctx.step("invalid format → 400", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/accounts/:accountId/audit/export", {
        params: { accountId: team.id },
        query: { format: "xlsx" },
      });
      r.status(400);
    });
    await ctx.step("NONMEMBER → 403", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/accounts/:accountId/audit/export", { params: { accountId: team.id } });
      r.status(403);
    });
  },
);

// ── AUD-3: list webhooks + authz boundary ────────────────────────────────────
flow(
  "AUD-3",
  { domain: "audit", serial: true, routes: ["GET /v1/accounts/:accountId/audit/webhooks"] },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    await ctx.step("OWNER lists webhooks → 200 with webhooks array", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/accounts/:accountId/audit/webhooks", { params: { accountId: team.id } });
      r.status(200).body().exists("$.webhooks");
    });
    await ctx.step("NONMEMBER → 403", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/accounts/:accountId/audit/webhooks", { params: { accountId: team.id } });
      r.status(403);
    });
  },
);

// ── AUD-4: webhook create → patch → delete lifecycle ─────────────────────────
flow(
  "AUD-4",
  {
    domain: "audit",
    serial: true,
    routes: [
      "POST /v1/accounts/:accountId/audit/webhooks",
      "PATCH /v1/accounts/:accountId/audit/webhooks/:webhookId",
      "DELETE /v1/accounts/:accountId/audit/webhooks/:webhookId",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    let webhookId = "";

    await ctx.step("create webhook → 201, secret revealed once", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        "/v1/accounts/:accountId/audit/webhooks",
        { name: ctx.fixtures.name("hook"), url: "https://example.com/ke2e-audit" },
        { params: { accountId: team.id } },
      );
      r.status(201).body().exists("$.webhook_id").exists("$.secret");
      webhookId = r.json<any>().webhook_id;
    });

    await ctx.step("create with missing url → 400", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        "/v1/accounts/:accountId/audit/webhooks",
        { name: ctx.fixtures.name("hook") },
        { params: { accountId: team.id } },
      );
      r.status(400);
    });

    await ctx.step("create with bad url scheme → 400", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        "/v1/accounts/:accountId/audit/webhooks",
        { name: ctx.fixtures.name("hook"), url: "ftp://example.com/x" },
        { params: { accountId: team.id } },
      );
      r.status(400);
    });

    await ctx.step("NONMEMBER cannot create → 403", async () => {
      const r = await ctx.client.as(ctx.P.NONMEMBER).post(
        "/v1/accounts/:accountId/audit/webhooks",
        { name: "nope", url: "https://example.com/x" },
        { params: { accountId: team.id } },
      );
      r.status(403);
    });

    await ctx.step("patch: disable webhook → 200", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).patch(
        "/v1/accounts/:accountId/audit/webhooks/:webhookId",
        { enabled: false },
        { params: { accountId: team.id, webhookId } },
      );
      r.status(200).body().has("$.enabled", false);
    });

    await ctx.step("patch unknown webhook id → 404", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).patch(
        "/v1/accounts/:accountId/audit/webhooks/:webhookId",
        { enabled: true },
        { params: { accountId: team.id, webhookId: "00000000-0000-0000-0000-000000000000" } },
      );
      r.status(404);
    });

    await ctx.step("delete webhook → 200 deleted", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/accounts/:accountId/audit/webhooks/:webhookId", {
          params: { accountId: team.id, webhookId },
        });
      r.status(200).body().has("$.deleted", true);
    });

    await ctx.step("delete already-deleted webhook → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/accounts/:accountId/audit/webhooks/:webhookId", {
          params: { accountId: team.id, webhookId },
        });
      r.status(404);
    });
  },
);
