/**
 * TRG-40: `type: app` triggers. An App emits named events with its own token,
 * and every enabled app trigger that names it fires. Maps to spec section 12.
 */
import { flow } from "../core/flow";
import { withDb } from "../fixtures/chat";

type Listed = { triggers: Array<{ slug: string; type: string; app?: string | null }> };

flow(
  "TRG-40",
  {
    domain: "triggers",
    routes: [
      "POST /v1/projects/:projectId/apps",
      "DELETE /v1/projects/:projectId/apps/:appId",
      "POST /v1/projects/:projectId/triggers",
      "GET /v1/projects/:projectId/triggers",
      "PATCH /v1/projects/:projectId/triggers/:slug",
      "DELETE /v1/projects/:projectId/triggers/:slug",
      "GET /v1/projects/:projectId/apps/:appId/events/credentials",
      "POST /v1/projects/:projectId/apps/:appId/events",
      "POST /v1/projects/:projectId/apps/:appId/runs",
      "DELETE /v1/projects/:projectId/apps/:appId/runs/:runId",
    ],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project({ managedGit: true });
    const owner = ctx.client.as(ctx.P.OWNER);
    const anon = ctx.client.as(ctx.P.ANON);
    const params = { projectId: project.id };
    const appSlug = ctx.fixtures.name("watcher").toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40).replace(/-+$/, "");
    const slug = "bank-reply";
    const eventsPath = "/v1/projects/:projectId/apps/:appId/events";
    let appId = "";
    let token = "";
    const emit = (body: unknown, bearer: string | null = token, id = appId) =>
      anon.post(eventsPath, body, { params: { ...params, appId: id }, headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });

    await ctx.step("an app trigger is validated against the project's Apps and the other types' wiring", async () => {
      const base = { name: "Bank reply", type: "app", prompt_template: "A bank replied: {{ event.data.subject }}" };
      (await owner.post("/v1/projects/:projectId/triggers", { ...base, app: appSlug }, { params })).status(400).body().has("$.error", `No App "${appSlug}" in this project. Create or deploy it first: kortix apps deploy ${appSlug}`);
      const created = await owner.post("/v1/projects/:projectId/apps", { slug: appSlug, name: "watcher" }, { params });
      created.status(201);
      appId = created.json<{ app_id: string }>().app_id;
      (await owner.post("/v1/projects/:projectId/triggers", base, { params })).status(400);
      (await owner.post("/v1/projects/:projectId/triggers", { ...base, app: appSlug, cron: "0 0 9 * * *" }, { params })).status(400);
      (await owner.post("/v1/projects/:projectId/triggers", { name: "c", type: "cron", cron: "0 0 9 * * *", prompt_template: "go", app: appSlug }, { params })).status(400);
    });

    await ctx.step("POST type app → 201; the listing has type app and the App slug", async () => {
      (await owner.post("/v1/projects/:projectId/triggers", { name: "Bank reply", slug, type: "app", app: appSlug, prompt_template: "A bank replied: {{ event.data.subject }}" }, { params })).status(201);
      const listed = (await owner.get("/v1/projects/:projectId/triggers", { params })).status(200).json<Listed>();
      const trigger = listed.triggers.find((t) => t.slug === slug);
      if (trigger?.type !== "app" || trigger.app !== appSlug) throw new Error(`listing: ${JSON.stringify(trigger)}`);
    });

    await ctx.step("the owner reads the App's event credentials; ANON gets 401", async () => {
      const read = (await owner.get("/v1/projects/:projectId/apps/:appId/events/credentials", { params: { ...params, appId } })).status(200);
      const body = read.json<{ url: string; token: string }>();
      if (!body.url.endsWith(`/v1/projects/${project.id}/apps/${appId}/events`) || !/^[a-f0-9]{64}$/.test(body.token)) {
        throw new Error(`credentials: ${read.text()}`);
      }
      token = body.token;
      (await anon.get("/v1/projects/:projectId/apps/:appId/events/credentials", { params: { ...params, appId } })).status(401);
    });

    await ctx.step("the events route refuses a missing or wrong token, an unknown App and a bad body", async () => {
      (await emit({ name: "reply.received" }, null)).status(401).body().has("$.code", "app_token_invalid");
      (await emit({ name: "reply.received" }, "0".repeat(64))).status(401).body().has("$.code", "app_token_invalid");
      // A token is per App: this App's token does not open another id.
      (await emit({ name: "reply.received" }, token, "00000000-0000-4000-a000-000000000000")).status(401);
      (await emit({ name: "bad name!" })).status(400);
      (await emit({ events: Array.from({ length: 51 }, () => ({ name: "x" })) })).status(400);
    });

    await ctx.step("a valid event → 202 triggers 1 accepted 1; the same id again is deduped", async () => {
      const event = { name: "reply.received", id: "msg-1", data: { subject: "Term sheet" } };
      (await emit(event)).status(202).body().has("$.triggers", 1).has("$.accepted", 1);
      (await emit({ events: [event] })).status(202).body().has("$.deduped", 1).has("$.accepted", 0);
    });

    await ctx.step("the event waits in the trigger's event log for the drain: one pending row per trigger", async () => {
      // The local profile runs no scheduler (KORTIX_TRIGGER_SCHEDULER_ENABLED=false), so the
      // drain that fires it is covered by apps/api/src/projects/lib/app-events.integration.test.ts.
      if (!ctx.env.capabilities.database) return;
      const rows = await withDb(ctx, (db) =>
        db.query(
          "SELECT slug, status, kind, line FROM kortix.project_monitor_events WHERE project_id = $1 AND box_epoch = $2",
          [project.id, `app:${appId}`],
        ),
      );
      const row = rows.rows[0] as { slug: string; status: string; kind: string; line: { name: string; id: string; data: { subject: string } } } | undefined;
      if (rows.rowCount !== 1 || row?.slug !== slug || row.status !== "pending" || row.kind !== "event" || row.line.name !== "reply.received" || row.line.data.subject !== "Term sheet") {
        throw new Error(`event log: ${JSON.stringify(rows.rows)}`);
      }
    });

    await ctx.step("the App schedules a one-off run and cancels it; a wrong token, a bad body and a second cancel are refused", async () => {
      const runs = "/v1/projects/:projectId/apps/:appId/runs";
      const as = (bearer: string) => ({ params: { ...params, appId }, headers: { authorization: `Bearer ${bearer}` } });
      (await anon.post(runs, { run_after: "10m" }, as("0".repeat(64)))).status(401).body().has("$.code", "app_token_invalid");
      (await anon.post(runs, { run_after: "10m", run_at: "2030-01-01T00:00:00Z" }, as(token))).status(400);
      (await anon.post(runs, { run_after: "soon" }, as(token))).status(400);
      (await anon.post(runs, { run_after: "400d" }, as(token))).status(400);
      const created = (await anon.post(runs, { run_after: "10m", path: "/tick", payload: { n: 1 } }, as(token))).status(201);
      const runId = created.json<{ run_id: string; run_at: string }>().run_id;
      if (!/^apprun\.[a-f0-9]{16}$/.test(runId)) throw new Error(`run: ${created.text()}`);
      const cancel = () => anon.del("/v1/projects/:projectId/apps/:appId/runs/:runId", { params: { ...params, appId, runId }, headers: { authorization: `Bearer ${token}` } });
      (await cancel()).status(200).body().has("$.cancelled", true);
      (await cancel()).status(404);
    });

    await ctx.step("a disabled app trigger matches no event: triggers 0", async () => {
      (await owner.patch("/v1/projects/:projectId/triggers/:slug", { enabled: false }, { params: { ...params, slug } })).status(200);
      (await emit({ name: "reply.received", id: "msg-2" })).status(202).body().has("$.triggers", 0);
    });

    await ctx.step("cleanup: delete the trigger and the App", async () => {
      (await owner.del("/v1/projects/:projectId/triggers/:slug", { params: { ...params, slug } })).status(200);
      (await owner.del("/v1/projects/:projectId/apps/:appId", { params: { ...params, appId } })).status(200);
    });
  },
);
