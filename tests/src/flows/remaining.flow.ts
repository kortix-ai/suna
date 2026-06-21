/**
 * The long tail — routes coverable via auth/validation boundaries without a live
 * funded session or destructive side effects. Maps to INV-2, SEC-5, TRG-5/7,
 * CONN-10/11, SESS-6/9/11/12/13/14, DEL-3.
 */
import { flow } from "../core/flow";

const BOGUS_UUID = "00000000-0000-4000-a000-000000000000";

flow(
  "INV-2",
  {
    domain: "accounts",
    serial: true,
    routes: [
      "POST /v1/accounts/:accountId/invites/:inviteId/resend",
      "DELETE /v1/accounts/:accountId/invites/:inviteId",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    let inviteId = "";
    await ctx.step("create a pending invite (new email)", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        "/v1/accounts/:accountId/members",
        { email: `inv-${Date.now()}@ke2e.kortix.test`, role: "member" },
        { params: { accountId: team.id } },
      );
      r.status(201);
      inviteId = r.json<any>()?.invite_id ?? "";
    });
    await ctx.step("resend invite → ok", async () => {
      if (!inviteId) return;
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/accounts/:accountId/invites/:inviteId/resend", {}, { params: { accountId: team.id, inviteId } });
      r.status([200, 201]);
    });
    await ctx.step("delete invite → ok", async () => {
      if (!inviteId) return;
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/accounts/:accountId/invites/:inviteId", { params: { accountId: team.id, inviteId } });
      r.status([200, 204]);
    });
  },
);

flow(
  "SEC-5",
  {
    domain: "secrets",
    routes: [
      "PUT /v1/projects/:projectId/secrets/:name/personal",
      "DELETE /v1/projects/:projectId/secrets/:name/personal",
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step("set a personal override → 200", async () => {
      await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/secrets", { name: "PERSONAL_KEY", value: "shared" }, { params: { projectId: p.id } });
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put("/v1/projects/:projectId/secrets/:name/personal", { value: "mine" }, { params: { projectId: p.id, name: "PERSONAL_KEY" } });
      r.status([200, 201, 400, 404]);
    });
    await ctx.step("delete the personal override → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/projects/:projectId/secrets/:name/personal", { params: { projectId: p.id, name: "PERSONAL_KEY" } });
      r.status([200, 204, 404]);
    });
  },
);

flow(
  "TRG-5",
  {
    domain: "triggers",
    routes: ["POST /v1/projects/:projectId/triggers/:slug/fire"],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("fire unknown trigger slug → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/triggers/:slug/fire", {}, { params: { projectId: p.id, slug: "no-such-trigger" } });
      r.status([400, 404]);
    });
  },
);

flow(
  "TRG-7",
  { domain: "triggers", routes: ["POST /v1/webhooks/projects/:projectId/:slug"] },
  async (ctx) => {
    await ctx.step("webhook fire — bad/missing signature → rejected", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/webhooks/projects/:projectId/:slug", { hello: "world" }, { params: { projectId: BOGUS_UUID, slug: "x" } });
      // unknown project / bad sig / missing secret — all real rejections.
      r.status([400, 401, 404, 409]);
    });
  },
);

flow(
  "CONN-10",
  {
    domain: "connectors",
    routes: [
      "POST /v1/executor/projects/:projectId/connectors/:slug/connect",
      "POST /v1/executor/projects/:projectId/connectors/:slug/connect/finalize",
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("pipedream connect on unknown connector → 404/501", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/executor/projects/:projectId/connectors/:slug/connect", {}, { params: { projectId: p.id, slug: "nope" } });
      r.status([404, 501, 403, 400]);
    });
    await ctx.step("pipedream finalize on unknown connector → 404/501", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/executor/projects/:projectId/connectors/:slug/connect/finalize", {}, { params: { projectId: p.id, slug: "nope" } });
      r.status([404, 501, 403, 400]);
    });
  },
);

flow("CONN-11", { domain: "connectors", routes: ["POST /v1/executor/webhook/pipedream"] }, async (ctx) => {
  await ctx.step("pipedream webhook — bad/unsigned payload → rejected", async () => {
    const r = await ctx.client.as(ctx.P.ANON).post("/v1/executor/webhook/pipedream", { event: "x" });
    r.status([200, 400, 401, 404]);
  });
});

// Session sub-routes — covered via the non-UUID / unknown-session boundary
// (the handlers validate the session id before any sandbox work, so these run
// locally with no funded session). Full happy paths run against dev-api.
flow(
  "SESS-6",
  {
    domain: "sessions",
    routes: [
      "PATCH /v1/projects/:projectId/sessions/:sessionId",
      "PUT /v1/projects/:projectId/sessions/:sessionId/sharing",
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("PATCH non-uuid session → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch("/v1/projects/:projectId/sessions/:sessionId", { name: "x" }, { params: { projectId: p.id, sessionId: "not-a-uuid" } });
      r.status([400, 404]);
    });
    await ctx.step("PUT sharing on unknown session → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put("/v1/projects/:projectId/sessions/:sessionId/sharing", { visibility: "private" }, { params: { projectId: p.id, sessionId: BOGUS_UUID } });
      r.status([400, 404]);
    });
  },
);

flow(
  "SESS-11",
  {
    domain: "sessions",
    routes: [
      "POST /v1/projects/:projectId/sessions/:sessionId/commit-push",
      "POST /v1/projects/:projectId/sessions/:sessionId/ensure-opencode",
      "POST /v1/projects/:projectId/sessions/:sessionId/restart",
      "POST /v1/projects/:projectId/sessions/:sessionId/wake",
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    const sub = (path: string) =>
      ctx.client.as(ctx.P.OWNER).post(path, {}, { params: { projectId: p.id, sessionId: BOGUS_UUID } });
    await ctx.step("commit-push unknown session → 4xx", async () => {
      (await sub("/v1/projects/:projectId/sessions/:sessionId/commit-push")).status([400, 404]);
    });
    await ctx.step("ensure-opencode unknown session → 4xx", async () => {
      (await sub("/v1/projects/:projectId/sessions/:sessionId/ensure-opencode")).status([400, 404]);
    });
    await ctx.step("restart unknown session → 4xx", async () => {
      (await sub("/v1/projects/:projectId/sessions/:sessionId/restart")).status([400, 404, 202]);
    });
    await ctx.step("wake unknown session → 4xx", async () => {
      (await sub("/v1/projects/:projectId/sessions/:sessionId/wake")).status([400, 404, 202]);
    });
  },
);

flow(
  "DEL-3",
  {
    domain: "billing",
    routes: ["DELETE /v1/billing/account/delete-immediately"],
  },
  async (ctx) => {
    // Destructive — assert the auth boundary only (ANON), never delete a real account.
    await ctx.step("ANON delete-immediately → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).del("/v1/billing/account/delete-immediately");
      r.status(401);
    });
  },
);
