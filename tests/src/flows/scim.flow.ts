/**
 * SCIM 2.0 provisioning surface — mounted at /scim/v2/accounts/:accountId/*
 * (apps/api/src/index.ts → app.route('/scim/v2', scimRouter)). Maps to spec
 * §scim (SCIM-*).
 *
 * Auth model (apps/api/src/middleware/scim-auth.ts):
 *   - EVERY /scim/v2/accounts/:accountId/* route (incl. ServiceProviderConfig)
 *     is behind `scimAuth`, which requires a per-account SCIM *bearer token*
 *     minted via POST /v1/accounts/:accountId/iam/scim/tokens. The user JWT is
 *     NOT a SCIM token, so OWNER's JWT → 401. Missing/empty bearer → 401.
 *   - A SCIM token whose account != the :accountId in the URL → 403.
 *
 * SCIM errors use the RFC 7644 envelope: { schemas:[...], status, detail }.
 * Resources/lists use the SCIM schemas (ListResponse, core User/Group).
 *
 * We mint a real SCIM token for the OWNER-owned team account to exercise the
 * 200/201 happy paths, then drive Users + Groups CRUD over that bearer.
 */
import { flow } from "../core/flow";
import type { Client } from "../core/client";
import type { FlowContext } from "../core/types";

/** Mint a per-account SCIM bearer token for an account the OWNER controls. */
async function mintScimToken(ctx: FlowContext, accountId: string): Promise<string> {
  const r = await ctx.client
    .as(ctx.P.OWNER)
    .post("/v1/accounts/:accountId/iam/scim/tokens", { name: ctx.fixtures.name("scim") }, { params: { accountId } });
  r.status(201).body().exists("$.secret");
  return r.json<any>().secret as string;
}

flow(
  "SCIM-1",
  {
    domain: "scim",
    tags: ["smoke"],
    routes: ["GET /scim/v2/accounts/:accountId/ServiceProviderConfig"],
    serial: true,
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    let scim: Client;

    await ctx.step("OWNER mints a SCIM token for the team account", async () => {
      const token = await mintScimToken(ctx, team.id);
      scim = ctx.client.withBearer(token, "SCIM");
    });

    await ctx.step("ServiceProviderConfig with SCIM token → 200 capabilities", async () => {
      const r = await scim.get("/scim/v2/accounts/:accountId/ServiceProviderConfig", { params: { accountId: team.id } });
      r.status(200).body().exists("$.schemas").exists("$.patch.supported").exists("$.authenticationSchemes");
    });

    await ctx.step("OWNER JWT (not a SCIM token) → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/scim/v2/accounts/:accountId/ServiceProviderConfig", { params: { accountId: team.id } });
      r.status(401);
    });

    await ctx.step("no bearer at all → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/scim/v2/accounts/:accountId/ServiceProviderConfig", { params: { accountId: team.id } });
      r.status(401);
    });
  },
);

flow(
  "SCIM-2",
  {
    domain: "scim",
    routes: [
      "GET /scim/v2/accounts/:accountId/Users",
      "POST /scim/v2/accounts/:accountId/Users",
      "GET /scim/v2/accounts/:accountId/Users/:userId",
      "PATCH /scim/v2/accounts/:accountId/Users/:userId",
      "DELETE /scim/v2/accounts/:accountId/Users/:userId",
    ],
    serial: true,
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    let scim: Client;

    await ctx.step("mint SCIM token", async () => {
      scim = ctx.client.withBearer(await mintScimToken(ctx, team.id), "SCIM");
    });

    await ctx.step("list Users → SCIM ListResponse", async () => {
      const r = await scim.get("/scim/v2/accounts/:accountId/Users", { params: { accountId: team.id } });
      r.status(200).body().exists("$.schemas").exists("$.Resources").exists("$.totalResults");
    });

    await ctx.step("list Users with userName filter → ListResponse", async () => {
      const r = await scim.get("/scim/v2/accounts/:accountId/Users", {
        params: { accountId: team.id },
        query: { filter: 'userName eq "nobody@ke2e.kortix.test"' },
      });
      r.status(200).body().has("$.totalResults", 0);
    });

    await ctx.step("POST Users with no userName → 400", async () => {
      const r = await scim.post("/scim/v2/accounts/:accountId/Users", {}, { params: { accountId: team.id } });
      r.status(400).body().exists("$.detail");
    });

    await ctx.step("POST Users for an unknown email → 201 placeholder invite (active:false)", async () => {
      const userName = `${ctx.fixtures.name("scim-user")}@ke2e.kortix.test`;
      const r = await scim.post(
        "/scim/v2/accounts/:accountId/Users",
        { userName, externalId: "ext-ke2e-1" },
        { params: { accountId: team.id } },
      );
      r.status(201).body().has("$.active", false).has("$.userName", userName).exists("$.id");
    });

    await ctx.step("GET unknown user → 404 SCIM error", async () => {
      const r = await scim.get("/scim/v2/accounts/:accountId/Users/:userId", {
        params: { accountId: team.id, userId: "00000000-0000-4000-8000-000000000000" },
      });
      r.status(404).body().exists("$.detail");
    });

    await ctx.step("PATCH active:false on unknown user → idempotent 204", async () => {
      const r = await scim.patch(
        "/scim/v2/accounts/:accountId/Users/:userId",
        { Operations: [{ op: "replace", path: "active", value: false }] },
        { params: { accountId: team.id, userId: "00000000-0000-4000-8000-000000000000" } },
      );
      r.status(204);
    });

    await ctx.step("PATCH (reactivate/update) unknown user → 404", async () => {
      const r = await scim.patch(
        "/scim/v2/accounts/:accountId/Users/:userId",
        { Operations: [{ op: "replace", path: "externalId", value: "x" }] },
        { params: { accountId: team.id, userId: "00000000-0000-4000-8000-000000000000" } },
      );
      r.status(404);
    });

    await ctx.step("DELETE unknown user → idempotent 204", async () => {
      const r = await scim.del("/scim/v2/accounts/:accountId/Users/:userId", {
        params: { accountId: team.id, userId: "00000000-0000-4000-8000-000000000000" },
      });
      r.status(204);
    });

    await ctx.step("OWNER JWT on Users → 401 (SCIM token required)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/scim/v2/accounts/:accountId/Users", { params: { accountId: team.id } });
      r.status(401);
    });
  },
);

flow(
  "SCIM-3",
  {
    domain: "scim",
    routes: [
      "GET /scim/v2/accounts/:accountId/Groups",
      "POST /scim/v2/accounts/:accountId/Groups",
      "GET /scim/v2/accounts/:accountId/Groups/:groupId",
      "PATCH /scim/v2/accounts/:accountId/Groups/:groupId",
      "DELETE /scim/v2/accounts/:accountId/Groups/:groupId",
    ],
    serial: true,
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    let scim: Client;
    let groupId = "";

    await ctx.step("mint SCIM token", async () => {
      scim = ctx.client.withBearer(await mintScimToken(ctx, team.id), "SCIM");
    });

    await ctx.step("list Groups → SCIM ListResponse", async () => {
      const r = await scim.get("/scim/v2/accounts/:accountId/Groups", { params: { accountId: team.id } });
      r.status(200).body().exists("$.Resources").exists("$.totalResults");
    });

    await ctx.step("POST Group with no displayName → 400", async () => {
      const r = await scim.post("/scim/v2/accounts/:accountId/Groups", {}, { params: { accountId: team.id } });
      r.status(400).body().exists("$.detail");
    });

    await ctx.step("POST Group → 201 with id + displayName", async () => {
      const displayName = ctx.fixtures.name("scim-group");
      const r = await scim.post(
        "/scim/v2/accounts/:accountId/Groups",
        { displayName, externalId: "grp-ke2e-1" },
        { params: { accountId: team.id } },
      );
      r.status(201).body().has("$.displayName", displayName).exists("$.id");
      groupId = r.json<any>().id;
    });

    await ctx.step("GET the created Group → 200", async () => {
      const r = await scim.get("/scim/v2/accounts/:accountId/Groups/:groupId", {
        params: { accountId: team.id, groupId },
      });
      r.status(200).body().has("$.id", groupId);
    });

    await ctx.step("PATCH replace displayName → 200", async () => {
      const next = ctx.fixtures.name("scim-group-renamed");
      const r = await scim.patch(
        "/scim/v2/accounts/:accountId/Groups/:groupId",
        { Operations: [{ op: "replace", path: "displayName", value: next }] },
        { params: { accountId: team.id, groupId } },
      );
      r.status(200).body().has("$.displayName", next);
    });

    await ctx.step("GET unknown Group → 404 SCIM error", async () => {
      const r = await scim.get("/scim/v2/accounts/:accountId/Groups/:groupId", {
        params: { accountId: team.id, groupId: "00000000-0000-4000-8000-000000000000" },
      });
      r.status(404).body().exists("$.detail");
    });

    await ctx.step("PATCH unknown Group → 404", async () => {
      const r = await scim.patch(
        "/scim/v2/accounts/:accountId/Groups/:groupId",
        { Operations: [{ op: "replace", path: "displayName", value: "x" }] },
        { params: { accountId: team.id, groupId: "00000000-0000-4000-8000-000000000000" } },
      );
      r.status(404);
    });

    await ctx.step("DELETE the Group → 204", async () => {
      const r = await scim.del("/scim/v2/accounts/:accountId/Groups/:groupId", {
        params: { accountId: team.id, groupId },
      });
      r.status(204);
    });

    await ctx.step("DELETE unknown Group → idempotent 204", async () => {
      const r = await scim.del("/scim/v2/accounts/:accountId/Groups/:groupId", {
        params: { accountId: team.id, groupId: "00000000-0000-4000-8000-000000000000" },
      });
      r.status(204);
    });
  },
);

flow(
  "SCIM-4",
  {
    domain: "scim",
    routes: ["GET /scim/v2/accounts/:accountId/ServiceProviderConfig"],
    serial: true,
  },
  async (ctx) => {
    // Cross-tenant: a SCIM token minted for team A must not work against team B's
    // URL — scimAuth returns 403 when the token's account != the URL accountId.
    const teamA = await ctx.fixtures.team();
    const teamB = await ctx.fixtures.team();
    let scimA: Client;

    await ctx.step("mint SCIM token for team A", async () => {
      scimA = ctx.client.withBearer(await mintScimToken(ctx, teamA.id), "SCIM-A");
    });

    await ctx.step("team A token against team B URL → 403", async () => {
      const r = await scimA.get("/scim/v2/accounts/:accountId/ServiceProviderConfig", {
        params: { accountId: teamB.id },
      });
      r.status(403).body().exists("$.detail");
    });

    await ctx.step("garbage bearer → 401", async () => {
      const r = await ctx.client
        .withBearer("kortix_scim_totally-bogus-token", "BOGUS")
        .get("/scim/v2/accounts/:accountId/ServiceProviderConfig", { params: { accountId: teamA.id } });
      r.status(401);
    });
  },
);
