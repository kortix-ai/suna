/**
 * Change requests — git-backed CR lifecycle on a project. Maps to spec §… (CR-1..12).
 *
 * Scope: a fresh project has only `main` and no session branch, so we cannot
 * drive a real merge (that needs a session branch + a funded sandbox). We assert
 * the create-validation surface, the read endpoints, and the access boundaries —
 * all against real handlers. A bogus `head_ref` fails branch-tip resolution
 * (resolveBranchTip throws → 400). Unknown :crId → 404.
 */
import { ChangeRequestListSchema } from "@kortix/api-contract";
import { assert } from "../core/expect";
import { flow } from "../core/flow";

const RANDOM_UUID = "00000000-0000-4000-a000-0000000000c1";

flow(
  "CR-1",
  { domain: "change-requests", tags: ["smoke"], routes: ["GET /v1/projects/:projectId/change-requests"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("OWNER lists change requests → 200 with the contract ChangeRequestList envelope", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/change-requests", { params: { projectId: p.id } });
      r.status(200).body().exists("$.change_requests").schema(ChangeRequestListSchema);
    });
    await ctx.step("invalid status filter → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/change-requests", { params: { projectId: p.id }, query: { status: "wizard" } });
      r.status(400);
    });
  },
);

flow(
  "CR-2",
  { domain: "change-requests", routes: ["POST /v1/projects/:projectId/change-requests"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("missing title → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/change-requests", { head_ref: "feature" }, { params: { projectId: p.id } });
      r.status(400);
    });
    await ctx.step("missing head_ref → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/change-requests", { title: ctx.fixtures.name("cr") }, { params: { projectId: p.id } });
      r.status(400);
    });
    await ctx.step("base_ref == head_ref → 400", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        "/v1/projects/:projectId/change-requests",
        { title: ctx.fixtures.name("cr"), head_ref: "main", base_ref: "main" },
        { params: { projectId: p.id } },
      );
      r.status(400);
    });
    await ctx.step("nonexistent head_ref → branch-tip resolution fails → 400/404/409", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        "/v1/projects/:projectId/change-requests",
        { title: ctx.fixtures.name("cr"), head_ref: "ke2e/does-not-exist" },
        { params: { projectId: p.id } },
      );
      r.status([400, 404, 409]);
    });
  },
);

flow(
  "CR-3",
  { domain: "change-requests", routes: ["GET /v1/projects/:projectId/change-requests/:crId"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("unknown crId → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/change-requests/:crId", { params: { projectId: p.id, crId: RANDOM_UUID } });
      r.status(404);
    });
  },
);

flow(
  "CR-4",
  { domain: "change-requests", routes: ["PATCH /v1/projects/:projectId/change-requests/:crId"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("patch unknown crId → 404", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).patch(
        "/v1/projects/:projectId/change-requests/:crId",
        { title: "renamed" },
        { params: { projectId: p.id, crId: RANDOM_UUID } },
      );
      r.status(404);
    });
  },
);

flow(
  "CR-5",
  { domain: "change-requests", routes: ["GET /v1/projects/:projectId/change-requests/:crId/diff"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("diff for unknown crId → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/change-requests/:crId/diff", { params: { projectId: p.id, crId: RANDOM_UUID } });
      r.status(404);
    });
  },
);

flow(
  "CR-6",
  { domain: "change-requests", routes: ["GET /v1/projects/:projectId/change-requests/:crId/merge-preview"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("merge-preview for unknown crId → 404", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/projects/:projectId/change-requests/:crId/merge-preview", {
        params: { projectId: p.id, crId: RANDOM_UUID },
      });
      r.status(404);
    });
  },
);

flow(
  "CR-7",
  { domain: "change-requests", routes: ["POST /v1/projects/:projectId/change-requests/:crId/merge"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("merge unknown crId → 404", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        "/v1/projects/:projectId/change-requests/:crId/merge",
        {},
        { params: { projectId: p.id, crId: RANDOM_UUID } },
      );
      r.status(404);
    });
  },
);

flow(
  "CR-8",
  {
    domain: "change-requests",
    routes: [
      "POST /v1/projects/:projectId/change-requests/:crId/close",
      "POST /v1/projects/:projectId/change-requests/:crId/reopen",
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("close unknown crId → 404", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        "/v1/projects/:projectId/change-requests/:crId/close",
        {},
        { params: { projectId: p.id, crId: RANDOM_UUID } },
      );
      r.status(404);
    });
    await ctx.step("reopen unknown crId → 404", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        "/v1/projects/:projectId/change-requests/:crId/reopen",
        {},
        { params: { projectId: p.id, crId: RANDOM_UUID } },
      );
      r.status(404);
    });
  },
);

flow(
  "CR-11",
  { domain: "change-requests", routes: ["GET /v1/projects/:projectId/change-requests"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("NONMEMBER cannot list → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/projects/:projectId/change-requests", { params: { projectId: p.id } });
      r.status([403, 404]);
    });
    await ctx.step("NONMEMBER cannot create → 403/404", async () => {
      const r = await ctx.client.as(ctx.P.NONMEMBER).post(
        "/v1/projects/:projectId/change-requests",
        { title: "nope", head_ref: "feature" },
        { params: { projectId: p.id } },
      );
      r.status([403, 404]);
    });
  },
);

// KRTX-2316: the list is one page plus a cursor; the 500 ceiling refuses, it
// no longer clamps. Cursor completeness over real rows is the DB suite
// `integration-change-requests-list-filters` (a CR needs a session branch).
flow(
  "CR-13",
  { domain: "change-requests", routes: ["GET /v1/projects/:projectId/change-requests"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    const get = (query: Record<string, string>) =>
      ctx.client.as(ctx.P.OWNER).get("/v1/projects/:projectId/change-requests", { params: { projectId: p.id }, query });
    await ctx.step("no limit → 200 one page; the contract requires next_cursor (null on the last page)", async () => {
      const r = await get({});
      r.status(200).body().schema(ChangeRequestListSchema);
      const body = r.json<{ change_requests: unknown[]; next_cursor?: string | null }>();
      assert({
        kind: "body.has",
        description: "next_cursor is present, at most 50 rows",
        expected: "next_cursor key, ≤ 50 rows",
        actual: { keys: Object.keys(body), rows: body.change_requests.length },
        pass: "next_cursor" in body && body.change_requests.length <= 50,
      });
    });
    await ctx.step("limit=500 → 200; limit=501 → 400 (the ceiling refuses, it does not clamp)", async () => {
      (await get({ status: "all", limit: "500" })).status(200).body().schema(ChangeRequestListSchema);
      (await get({ status: "all", limit: "501" })).status(400);
    });
    await ctx.step("limit=0 and a word → 400; a cursor that is not a CR number → 400; a number cursor → 200", async () => {
      (await get({ limit: "0" })).status(400);
      (await get({ limit: "many" })).status(400);
      (await get({ cursor: "abc" })).status(400);
      (await get({ cursor: "1" })).status(200).body().has("$.next_cursor", null);
    });
  },
);

flow(
  "CR-12",
  { domain: "change-requests", routes: ["GET /v1/projects/:projectId/change-requests"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("ANON cannot list → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/projects/:projectId/change-requests", { params: { projectId: p.id } });
      r.status(401);
    });
  },
);

// CR-8b — request-changes (Review Center "request changes" on an open CR,
// change-requests.ts). `feedback` is validated BEFORE the CR lookup (so a missing feedback
// is 400 even against an unknown crId); an unknown crId is 404. A real CR
// needs a session branch + a funded sandbox this suite can't cheaply drive
// (see the file header), so — like CR-3..CR-8 — we assert the real validation
// + not-found boundaries against a fresh project with no CRs.
flow(
  "CR-8b",
  {
    domain: "change-requests",
    routes: ["POST /v1/projects/:projectId/change-requests/:crId/request-changes"],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("missing feedback → 400", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        "/v1/projects/:projectId/change-requests/:crId/request-changes",
        {},
        { params: { projectId: p.id, crId: RANDOM_UUID } },
      );
      r.status(400);
    });
    await ctx.step("unknown crId (feedback present) → 404", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        "/v1/projects/:projectId/change-requests/:crId/request-changes",
        { feedback: "please fix the thing" },
        { params: { projectId: p.id, crId: RANDOM_UUID } },
      );
      r.status(404);
    });
    await ctx.step("NONMEMBER → 403/404", async () => {
      const r = await ctx.client.as(ctx.P.NONMEMBER).post(
        "/v1/projects/:projectId/change-requests/:crId/request-changes",
        { feedback: "please fix the thing" },
        { params: { projectId: p.id, crId: RANDOM_UUID } },
      );
      r.status([403, 404]);
    });
  },
);
