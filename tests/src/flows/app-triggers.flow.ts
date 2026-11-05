/**
 * TRG-40: `type: app` triggers. An App emits named events with its own token,
 * and every enabled app trigger that names it fires. Maps to spec section 12.
 */
import { flow } from "../core/flow";
import { withDb } from "../fixtures/chat";

type Listed = {
  triggers: Array<{ slug: string; type: string; app?: string | null; expect_event_within_seconds?: number | null; last_event_at?: string | null; silent_since?: string | null }>;
};
type EventLog = {
  events: Array<{ name: string | null; id: string | null; test: boolean; trigger: string | null; status: string; reason: string | null; data: Record<string, unknown> | null }>;
  next_cursor: string | null;
};

flow(
  "TRG-40",
  {
    domain: "triggers",
    routes: [
      "POST /v1/workspaces/:projectId/apps",
      "DELETE /v1/workspaces/:projectId/apps/:appId",
      "POST /v1/workspaces/:projectId/triggers",
      "GET /v1/workspaces/:projectId/triggers",
      "PATCH /v1/workspaces/:projectId/triggers/:slug",
      "DELETE /v1/workspaces/:projectId/triggers/:slug",
      "GET /v1/workspaces/:projectId/apps/:appId/events/credentials",
      "GET /v1/workspaces/:projectId/apps/:appId/events",
      "POST /v1/workspaces/:projectId/apps/:appId/events/test",
      "POST /v1/workspaces/:projectId/apps/:appId/events",
      "POST /v1/workspaces/:projectId/apps/:appId/runs",
      "DELETE /v1/workspaces/:projectId/apps/:appId/runs/:runId",
    ],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project({ managedGit: true });
    const owner = ctx.client.as(ctx.P.OWNER);
    const anon = ctx.client.as(ctx.P.ANON);
    const params = { projectId: project.id };
    const appSlug = ctx.fixtures.name("watcher").toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40).replace(/-+$/, "");
    const slug = "bank-reply";
    const eventsPath = "/v1/workspaces/:projectId/apps/:appId/events";
    let appId = "";
    let token = "";
    const emit = (body: unknown, bearer: string | null = token, id = appId) =>
      anon.post(eventsPath, body, { params: { ...params, appId: id }, headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });

    await ctx.step("an app trigger is validated against the project's Apps and the other types' wiring", async () => {
      const base = { name: "Bank reply", type: "app", prompt_template: "A bank replied: {{ event.data.subject }}" };
      (await owner.post("/v1/workspaces/:projectId/triggers", { ...base, app: appSlug }, { params })).status(400).body().has("$.error", `No App "${appSlug}" in this project. Create or deploy it first: kortix apps deploy ${appSlug}`);
      const created = await owner.post("/v1/workspaces/:projectId/apps", { slug: appSlug, name: "watcher" }, { params });
      created.status(201);
      appId = created.json<{ app_id: string }>().app_id;
      (await owner.post("/v1/workspaces/:projectId/triggers", base, { params })).status(400);
      (await owner.post("/v1/workspaces/:projectId/triggers", { ...base, app: appSlug, cron: "0 0 9 * * *" }, { params })).status(400);
      (await owner.post("/v1/workspaces/:projectId/triggers", { name: "c", type: "cron", cron: "0 0 9 * * *", prompt_template: "go", app: appSlug }, { params })).status(400);
    });

    await ctx.step("POST type app → 201; the listing has type app and the App slug", async () => {
      (await owner.post("/v1/workspaces/:projectId/triggers", { name: "Bank reply", slug, type: "app", app: appSlug, prompt_template: "A bank replied: {{ event.data.subject }}" }, { params })).status(201);
      const listed = (await owner.get("/v1/workspaces/:projectId/triggers", { params })).status(200).json<Listed>();
      const trigger = listed.triggers.find((t) => t.slug === slug);
      if (trigger?.type !== "app" || trigger.app !== appSlug) throw new Error(`listing: ${JSON.stringify(trigger)}`);
      if (trigger.last_event_at !== null || trigger.silent_since !== null) throw new Error(`no event yet: ${JSON.stringify(trigger)}`);
    });

    await ctx.step("expect_event_within: 10m on the app trigger is listed as 600 s; 1m, a cron trigger and a bad value are 400", async () => {
      (await owner.patch("/v1/workspaces/:projectId/triggers/:slug", { expect_event_within: "10m" }, { params: { ...params, slug } })).status(200);
      const listed = (await owner.get("/v1/workspaces/:projectId/triggers", { params })).status(200).json<Listed>();
      const trigger = listed.triggers.find((t) => t.slug === slug);
      if (trigger?.expect_event_within_seconds !== 600) throw new Error(`expect_event_within: ${JSON.stringify(trigger)}`);
      (await owner.patch("/v1/workspaces/:projectId/triggers/:slug", { expect_event_within: "1m" }, { params: { ...params, slug } })).status(400);
      (await owner.patch("/v1/workspaces/:projectId/triggers/:slug", { expect_event_within: "soon" }, { params: { ...params, slug } })).status(400);
      (await owner.post("/v1/workspaces/:projectId/triggers", { name: "c", type: "cron", cron: "0 0 9 * * *", prompt_template: "go", expect_event_within: "1h" }, { params })).status(400);
    });

    await ctx.step("the owner reads the App's event credentials; ANON gets 401", async () => {
      const read = (await owner.get("/v1/workspaces/:projectId/apps/:appId/events/credentials", { params: { ...params, appId } })).status(200);
      const body = read.json<{ url: string; token: string }>();
      if (!body.url.endsWith(`/v1/projects/${project.id}/apps/${appId}/events`) || !/^[a-f0-9]{64}$/.test(body.token)) {
        throw new Error(`credentials: ${read.text()}`);
      }
      token = body.token;
      (await anon.get("/v1/workspaces/:projectId/apps/:appId/events/credentials", { params: { ...params, appId } })).status(401);
    });

    await ctx.step("the events route refuses a missing or wrong token, an unknown App and a bad body", async () => {
      (await emit({ name: "reply.received" }, null)).status(401).body().has("$.code", "app_token_invalid");
      (await emit({ name: "reply.received" }, "0".repeat(64))).status(401).body().has("$.code", "app_token_invalid");
      // A token is per App: this App's token does not open another id.
      (await emit({ name: "reply.received" }, token, "00000000-0000-4000-a000-000000000000")).status(401);
      (await emit({ name: "bad name!" })).status(400);
      (await emit({ events: Array.from({ length: 51 }, () => ({ name: "x" })) })).status(400);
    });

    await ctx.step("a valid event → 202 triggers 1 accepted 1; the same id again is deduped; the listing has last_event_at", async () => {
      const event = { name: "reply.received", id: "msg-1", data: { subject: "Term sheet" } };
      const before = Date.now();
      (await emit(event)).status(202).body().has("$.triggers", 1).has("$.accepted", 1);
      (await emit({ events: [event] })).status(202).body().has("$.deduped", 1).has("$.accepted", 0);
      const listed = (await owner.get("/v1/workspaces/:projectId/triggers", { params })).status(200).json<Listed>();
      const trigger = listed.triggers.find((t) => t.slug === slug);
      const heard = Date.parse(trigger?.last_event_at ?? "");
      if (!(heard >= before - 5_000) || trigger?.silent_since !== null) throw new Error(`last_event_at: ${JSON.stringify(trigger)}`);
    });

    await ctx.step("the App's event log lists the event under its trigger, pending; a bad limit or cursor is 400; ANON gets 401", async () => {
      const log = (query: Record<string, string> = {}) => owner.get(eventsPath, { params: { ...params, appId }, query });
      const listed = (await log()).status(200).json<EventLog>();
      const [entry] = listed.events;
      if (listed.events.length !== 1 || entry?.name !== "reply.received" || entry.id !== "msg-1" || entry.trigger !== slug || entry.status !== "pending" || entry.data?.subject !== "Term sheet") {
        throw new Error(`event log: ${JSON.stringify(listed)}`);
      }
      (await log({ limit: "0" })).status(400);
      (await log({ cursor: "not-a-cursor" })).status(400);
      (await anon.get(eventsPath, { params: { ...params, appId } })).status(401);
    });

    await ctx.step("the owner sends a test event: 202 with a test- id, listed as a test under the trigger; the real id stays unspent; ANON 401", async () => {
      const testPath = "/v1/workspaces/:projectId/apps/:appId/events/test";
      const sent = (await owner.post(testPath, { name: "reply.received", id: "msg-5", data: { subject: "Wiring check" } }, { params: { ...params, appId } })).status(202);
      sent.body().has("$.triggers", 1).has("$.accepted", 1);
      const ids = sent.json<{ ids: string[] }>().ids;
      if (ids.length !== 1 || ids[0] !== "test-msg-5") throw new Error(`test ids: ${sent.text()}`);
      const listed = (await owner.get(eventsPath, { params: { ...params, appId }, query: { id: "test-msg-5" } })).status(200).json<EventLog>();
      const [entry] = listed.events;
      if (listed.events.length !== 1 || entry?.test !== true || entry.trigger !== slug || entry.status !== "pending" || entry.data?.subject !== "Wiring check") {
        throw new Error(`test event: ${JSON.stringify(listed)}`);
      }
      // The App's own msg-5 is not deduplicated against the test.
      (await emit({ name: "reply.received", id: "msg-5" })).status(202).body().has("$.accepted", 1).has("$.deduped", 0);
      (await owner.post(testPath, { name: "bad name!" }, { params: { ...params, appId } })).status(400);
      (await anon.post(testPath, { name: "reply.received" }, { params: { ...params, appId } })).status(401);
    });

    await ctx.step("the event waits in the trigger's event log for the drain: one pending row per trigger", async () => {
      // The local profile runs no scheduler (KORTIX_TRIGGER_SCHEDULER_ENABLED=false), so the
      // drain that fires it is covered by apps/api/src/projects/lib/app-events.integration.test.ts.
      if (!ctx.env.capabilities.database) return;
      const rows = await withDb(ctx, (db) =>
        db.query(
          "SELECT slug, status, kind, line FROM kortix.project_monitor_events WHERE project_id = $1 AND box_epoch = $2 AND line->>'id' = 'msg-1'",
          [project.id, `app:${appId}`],
        ),
      );
      const row = rows.rows[0] as { slug: string; status: string; kind: string; line: { name: string; id: string; data: { subject: string } } } | undefined;
      if (rows.rowCount !== 1 || row?.slug !== slug || row.status !== "pending" || row.kind !== "event" || row.line.name !== "reply.received" || row.line.data.subject !== "Term sheet") {
        throw new Error(`event log: ${JSON.stringify(rows.rows)}`);
      }
    });

    await ctx.step("the App schedules a one-off run and cancels it; a wrong token, a bad body and a second cancel are refused", async () => {
      const runs = "/v1/workspaces/:projectId/apps/:appId/runs";
      const as = (bearer: string) => ({ params: { ...params, appId }, headers: { authorization: `Bearer ${bearer}` } });
      (await anon.post(runs, { run_after: "10m" }, as("0".repeat(64)))).status(401).body().has("$.code", "app_token_invalid");
      (await anon.post(runs, { run_after: "10m", run_at: "2030-01-01T00:00:00Z" }, as(token))).status(400);
      (await anon.post(runs, { run_after: "soon" }, as(token))).status(400);
      (await anon.post(runs, { run_after: "400d" }, as(token))).status(400);
      const created = (await anon.post(runs, { run_after: "10m", path: "/tick", payload: { n: 1 } }, as(token))).status(201);
      const runId = created.json<{ run_id: string; run_at: string }>().run_id;
      if (!/^apprun\.[a-f0-9]{16}$/.test(runId)) throw new Error(`run: ${created.text()}`);
      const cancel = () => anon.del("/v1/workspaces/:projectId/apps/:appId/runs/:runId", { params: { ...params, appId, runId }, headers: { authorization: `Bearer ${token}` } });
      (await cancel()).status(200).body().has("$.cancelled", true);
      (await cancel()).status(404);
    });

    await ctx.step("a disabled app trigger matches no event: triggers 0, unmatched 1, and the log keeps it with the reason", async () => {
      (await owner.patch("/v1/workspaces/:projectId/triggers/:slug", { enabled: false }, { params: { ...params, slug } })).status(200);
      const reason = `every trigger on App "${appSlug}" is disabled (${slug}): enable one to run it`;
      (await emit({ name: "reply.received", id: "msg-2" })).status(202).body().has("$.triggers", 0).has("$.unmatched", 1).has("$.hint", reason);
      const unmatched = (await owner.get(eventsPath, { params: { ...params, appId }, query: { status: "unmatched" } })).status(200).json<EventLog>();
      const [entry] = unmatched.events;
      if (unmatched.events.length !== 1 || entry?.id !== "msg-2" || entry.trigger !== null || entry.reason !== reason) {
        throw new Error(`unmatched: ${JSON.stringify(unmatched)}`);
      }
    });

    await ctx.step("cleanup: delete the trigger and the App", async () => {
      (await owner.del("/v1/workspaces/:projectId/triggers/:slug", { params: { ...params, slug } })).status(200);
      (await owner.del("/v1/workspaces/:projectId/apps/:appId", { params: { ...params, appId } })).status(200);
    });
  },
);
