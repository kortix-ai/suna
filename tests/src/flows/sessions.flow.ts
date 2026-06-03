/**
 * Sessions — create/list/get/delete + sandbox status. Maps to spec §16 (SESS-*).
 * Session creation provisions a REAL Daytona sandbox (fire-and-forget), so these
 * assert the contract (201 provisioning, status transitions) without blocking on
 * a full boot. Gated on the `daytona` capability.
 */
import { flow } from "../core/flow";

flow(
  "SESS-1",
  { domain: "sessions", requires: ["daytona", "funded"], timeoutMs: 120_000, routes: ["POST /v1/projects/:projectId/sessions"] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step("create session → 201 provisioning", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/sessions", { initial_prompt: "noop" }, { params: { projectId: p.id } });
      r.status(201);
      const id = r.json<any>()?.session_id ?? r.json<any>()?.id;
      if (id) ctx.track("session", id, { projectId: p.id });
    });
  },
);

flow(
  "SESS-4",
  { domain: "sessions", requires: ["daytona", "funded"], timeoutMs: 120_000, routes: ["GET /v1/projects/:projectId/sessions"] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step("list sessions", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/projects/:projectId/sessions", { params: { projectId: p.id } });
      r.status(200);
    });
  },
);

flow(
  "SESS-5",
  { domain: "sessions", requires: ["daytona", "funded"], timeoutMs: 120_000, routes: ["GET /v1/projects/:projectId/sessions/:sessionId"] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    const s = await ctx.fixtures.session(p);
    await ctx.step("get session → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/sessions/:sessionId", { params: { projectId: p.id, sessionId: s.id } });
      r.status(200);
    });
    await ctx.step("non-uuid session id → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/sessions/:sessionId", { params: { projectId: p.id, sessionId: "not-a-uuid" } });
      r.status(400);
    });
  },
);

flow(
  "SESS-8",
  { domain: "sessions", requires: ["daytona", "funded"], timeoutMs: 120_000, routes: ["GET /v1/projects/:projectId/sessions/:sessionId/sandbox"] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    const s = await ctx.fixtures.session(p);
    await ctx.step("sandbox status row (404 until inserted, else provisioning/active)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/sessions/:sessionId/sandbox", { params: { projectId: p.id, sessionId: s.id } });
      r.status([200, 404]);
    });
  },
);

flow(
  "SESS-7",
  { domain: "sessions", requires: ["daytona", "funded"], timeoutMs: 120_000, routes: ["DELETE /v1/projects/:projectId/sessions/:sessionId"] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    const s = await ctx.fixtures.session(p);
    await ctx.step("delete session → 200 stopped", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/projects/:projectId/sessions/:sessionId", { params: { projectId: p.id, sessionId: s.id } });
      r.status(200);
    });
  },
);
