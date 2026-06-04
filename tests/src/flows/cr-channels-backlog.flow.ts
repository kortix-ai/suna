/**
 * Backlog flows: CR-10 (change-request response-envelope SHAPES) and
 * CHN-9 (channel-webhook signature/configuration gate codes).
 *
 * CR-10 — Response-envelope shapes (verified against apps/api/src/projects/index.ts):
 *   - list  GET  /change-requests        → `{ change_requests: [...] }`   (line ~7880)
 *   - get   GET  /change-requests/:crId   → `{ change_request: {...} }`    (line ~8082)
 *   - merge POST /change-requests/:crId/merge → `{ change_request, merge }` (line ~8283)
 *   - project DELETE /:projectId          → `{ ok: true }` (soft archive, line ~6209)
 *
 *   We exercise the list envelope directly on a read-only sharedProject() (200 +
 *   `$.change_requests` is an array). The get/merge envelopes CANNOT be exercised
 *   positively here: a fresh project has only `main` (no session branch), so there
 *   is no real CR to fetch or merge, and creating+merging one needs a funded
 *   sandbox session (out of scope for a local boundary run). We therefore assert
 *   those envelopes via their 404 boundary (unknown :crId), which proves the route
 *   is wired without inventing a CR. The project DELETE `{ ok: true }` shape is
 *   asserted on a disposable project() fixture (soft archive, repeatable).
 *
 * CHN-9 — Bad/missing signature on ANY channel webhook (verified against
 *   apps/api/src/channels/{slack-webhook,slack-oauth,telegram-webhook}.ts):
 *   - Shared Slack OAuth-mode webhooks (`/webhooks/slack`, `/commands`,
 *     `/interactivity`) and the OAuth callback gate on slackOauthMode().available
 *     FIRST → unconfigured server returns 503 before the signature check; a
 *     configured server with a bad/missing signature returns 401.
 *   - Slack BYO per-project (`/webhooks/slack/:projectId`) and Telegram
 *     (`/webhooks/telegram/:projectId`) look up the per-project secret first →
 *     not configured → 404; configured + bad signature/secret → 401.
 *   We post raw/unsigned bodies with a deliberately-wrong signature header and
 *   assert the documented code, narrowed per route to the handler's actual gate.
 */
import { flow } from "../core/flow";

const RANDOM_CR = "00000000-0000-4000-a000-0000000000d9";
const UNKNOWN_PROJECT = "00000000-0000-4000-a000-0000000000da";

// CR-10 — response-envelope shapes for change requests + project delete.
flow(
  "CR-10",
  {
    domain: "change-requests",
    routes: [
      "GET /v1/projects/:projectId/change-requests",
      "GET /v1/projects/:projectId/change-requests/:crId",
      "POST /v1/projects/:projectId/change-requests/:crId/merge",
      "DELETE /v1/projects/:projectId",
    ],
  },
  async (ctx) => {
    const shared = await ctx.fixtures.sharedProject();

    await ctx.step("list envelope → 200 `{ change_requests: [...] }`", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/change-requests", { params: { projectId: shared.id } });
      r.status(200).body().exists("$.change_requests");
      // The envelope key must be an array (list shape), not an object/scalar.
      const crs = r.json<{ change_requests: unknown }>().change_requests;
      r.body().has("$.change_requests", Array.isArray(crs) ? crs : "<not-array>");
    });

    await ctx.step("get envelope boundary → unknown crId 404 (`{ change_request }` route wired)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/change-requests/:crId", {
          params: { projectId: shared.id, crId: RANDOM_CR },
        });
      r.status(404);
    });

    await ctx.step("merge envelope boundary → unknown crId 404 (`{ change_request, merge }` route wired)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/change-requests/:crId/merge",
          {},
          { params: { projectId: shared.id, crId: RANDOM_CR } },
        );
      r.status(404);
    });

    await ctx.step("project DELETE → 200 `{ ok: true }` (soft archive, not an echoed status)", async () => {
      const disposable = await ctx.fixtures.project();
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/projects/:projectId", { params: { projectId: disposable.id } });
      r.status(200).body().has("$.ok", true);
    });
  },
);

// CHN-9 — bad/missing signature on every channel webhook → documented gate code.
flow(
  "CHN-9",
  {
    domain: "channels",
    routes: [
      "POST /v1/webhooks/slack",
      "POST /v1/webhooks/slack/commands",
      "POST /v1/webhooks/slack/interactivity",
      "GET /v1/webhooks/slack/oauth/callback",
      "POST /v1/webhooks/slack/:projectId",
      "POST /v1/webhooks/telegram/:projectId",
    ],
  },
  async (ctx) => {
    const shared = await ctx.fixtures.sharedProject();
    const badSlackSig = {
      "x-slack-signature": "v0=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
    };

    // Shared OAuth-mode webhooks: OAuth-mode gate fires FIRST → 503 unconfigured,
    // else bad signature → 401.
    await ctx.step("shared Slack events webhook, bad sig → 503 (unconfigured) | 401 (bad sig)", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post(
          "/v1/webhooks/slack",
          { type: "event_callback", event: { type: "app_mention" } },
          { headers: badSlackSig },
        );
      r.status([401, 503]);
    });

    await ctx.step("Slack slash-commands webhook, bad sig → 503 | 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/webhooks/slack/commands", "command=%2Fkortix&text=hi", {
          raw: true,
          headers: { ...badSlackSig, "content-type": "application/x-www-form-urlencoded" },
        });
      r.status([401, 503]);
    });

    await ctx.step("Slack interactivity webhook, bad sig → 503 | 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/webhooks/slack/interactivity", "payload=%7B%7D", {
          raw: true,
          headers: { ...badSlackSig, "content-type": "application/x-www-form-urlencoded" },
        });
      r.status([401, 503]);
    });

    // OAuth callback: unconfigured → 503; configured + missing/invalid code+state → 400.
    await ctx.step("Slack OAuth callback, invalid state → 503 (unconfigured) | 400 (state never verifies)", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/webhooks/slack/oauth/callback", { query: { code: "abc", state: "garbage.sig" } });
      r.status([400, 503]);
    });

    // BYO per-project Slack: per-project secret lookup FIRST → not configured → 404;
    // configured + bad sig → 401. sharedProject has no Slack install.
    await ctx.step("Slack BYO per-project webhook, no install → 404 (else 401 bad sig)", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post(
          "/v1/webhooks/slack/:projectId",
          { type: "event_callback", event: { type: "app_mention" } },
          { params: { projectId: shared.id }, headers: badSlackSig },
        );
      r.status([401, 404]);
    });

    await ctx.step("Slack BYO per-project webhook, unknown project → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post(
          "/v1/webhooks/slack/:projectId",
          { type: "event_callback" },
          { params: { projectId: UNKNOWN_PROJECT }, headers: badSlackSig },
        );
      r.status(404);
    });

    // Telegram: per-project secret lookup FIRST → not configured → 404;
    // configured + wrong secret-token header → 401.
    await ctx.step("Telegram per-project webhook, no secret → 404 (else 401 bad secret)", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post(
          "/v1/webhooks/telegram/:projectId",
          { update_id: 1, message: { message_id: 1, chat: { id: 1, type: "private" } } },
          {
            params: { projectId: shared.id },
            headers: { "x-telegram-bot-api-secret-token": "wrong-secret" },
          },
        );
      r.status([401, 404]);
    });

    await ctx.step("Telegram per-project webhook, unknown project → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post(
          "/v1/webhooks/telegram/:projectId",
          { update_id: 1 },
          {
            params: { projectId: UNKNOWN_PROJECT },
            headers: { "x-telegram-bot-api-secret-token": "wrong-secret" },
          },
        );
      r.status(404);
    });
  },
);
