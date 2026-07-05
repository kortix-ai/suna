/**
 * Channels — Slack + AgentMail email integration + public, signature-gated webhooks. Maps to
 * spec §CHN.
 *
 * Behavior confirmed against apps/api/src/channels + apps/api/src/projects/index.ts:
 * - slack/connect|installation|mode are user-authed project routes (read/manage
 *   ACL) and return 404 to non-members (loadProjectForUser fails → "Not found").
 * - connect needs a real `xoxb-` token validated via Slack auth.test → in local
 *   dev (no real Slack) expect 400 (bad token / Slack rejects) or 502 (unreachable).
 * - The shared OAuth-mode webhooks (POST /webhooks/slack, /commands,
 *   /interactivity) and the OAuth callback gate on slackOauthMode().available
 *   (SLACK_CLIENT_ID+SECRET+SIGNING_SECRET). Local dev usually lacks those →
 *   503 BEFORE signature check; if configured, an unsigned body → 401.
 * - url_verification challenge only echoes AFTER signature passes, so unsigned
 *   we never reach it.
 * - BYO per-project webhook (/webhooks/slack/:projectId) returns 404 when the
 *   project has no install configured; a configured-but-bad-signature would be
 *   401.
 * - Email connect is AgentMail-native. The negative path uses an intentionally
 *   bogus API key so live suites do not create real inboxes unless a specific
 *   positive flow opts in.
 */
import { flow } from "../core/flow";

const UNKNOWN = "00000000-0000-4000-a000-000000000000";

// CHN-2 — Slack installation status (read ACL).
flow(
  "CHN-2",
  {
    domain: "channels",
    routes: ["GET /v1/projects/:projectId/channels/slack/installation"],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("OWNER reads install status → 200 (null when not connected)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/channels/slack/installation", { params: { projectId: p.id } });
      r.status(200);
    });
    await ctx.step("NONMEMBER → 404 (loadProjectForUser denies)", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/projects/:projectId/channels/slack/installation", { params: { projectId: p.id } });
      r.status([403, 404]);
    });
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/projects/:projectId/channels/slack/installation", { params: { projectId: p.id } });
      r.status(401);
    });
  },
);

// CHN-14 — Email installation status (read ACL).
flow(
  "CHN-14",
  {
    domain: "channels",
    routes: ["GET /v1/projects/:projectId/channels/email/installation"],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("OWNER reads email install status → 200 (null when not connected)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/channels/email/installation", { params: { projectId: p.id } });
      r.status(200);
    });
    await ctx.step("NONMEMBER → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/projects/:projectId/channels/email/installation", { params: { projectId: p.id } });
      r.status([403, 404]);
    });
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/projects/:projectId/channels/email/installation", { params: { projectId: p.id } });
      r.status(401);
    });
  },
);

// CHN-17 — Email mode/capabilities (managed AgentMail availability).
flow(
  "CHN-17",
  {
    domain: "channels",
    routes: ["GET /v1/projects/:projectId/channels/email/mode"],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("OWNER reads email mode → 200 (disabled unless experimental flag is enabled)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/channels/email/mode", { params: { projectId: p.id } });
      r.status(200).body().has("$.provider", "agentmail").has("$.enabled", false);
    });
    await ctx.step("NONMEMBER → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/projects/:projectId/channels/email/mode", { params: { projectId: p.id } });
      r.status([403, 404]);
    });
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/projects/:projectId/channels/email/mode", { params: { projectId: p.id } });
      r.status(401);
    });
  },
);

// CHN-13 — Email connect (manage ACL); creates AgentMail inbox + webhook.
flow(
  "CHN-13",
  {
    domain: "channels",
    routes: ["POST /v1/projects/:projectId/channels/email/connect"],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("disabled by default → 403 before AgentMail key validation", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/channels/email/connect",
          { api_key: "am_us_bogus", display_name: "Kortix E2E" },
          { params: { projectId: p.id } },
        );
      r.status(403);
    });
    await ctx.step("NONMEMBER cannot connect → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post(
          "/v1/projects/:projectId/channels/email/connect",
          { api_key: "am_us_bogus", display_name: "Kortix E2E" },
          { params: { projectId: p.id } },
        );
      r.status([403, 404]);
    });
  },
);

// CHN-15 — Email disconnect (manage ACL); idempotent.
flow(
  "CHN-15",
  {
    domain: "channels",
    routes: ["DELETE /v1/projects/:projectId/channels/email/installation"],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("OWNER disconnect → 200 (idempotent)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/projects/:projectId/channels/email/installation", { params: { projectId: p.id } });
      r.status(200).body().has("$.status", "disconnected");
    });
    await ctx.step("NONMEMBER cannot disconnect → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .del("/v1/projects/:projectId/channels/email/installation", { params: { projectId: p.id } });
      r.status([403, 404]);
    });
  },
);

// CHN-10 — Slack OAuth mode discovery (read ACL).
flow(
  "CHN-10",
  {
    domain: "channels",
    routes: ["GET /v1/projects/:projectId/channels/slack/mode"],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("OWNER reads mode → 200 with oauth_available + install_url", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/channels/slack/mode", { params: { projectId: p.id } });
      r.status(200).body().exists("$.oauth_available");
    });
    await ctx.step("NONMEMBER → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/projects/:projectId/channels/slack/mode", { params: { projectId: p.id } });
      r.status([403, 404]);
    });
  },
);

// CHN-1 — Slack BYO connect (manage ACL); validates xoxb- via Slack auth.test.
flow(
  "CHN-1",
  {
    domain: "channels",
    routes: ["POST /v1/projects/:projectId/channels/slack/connect"],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("missing/blank bot_token → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/channels/slack/connect", {}, { params: { projectId: p.id } });
      r.status(400);
    });
    await ctx.step("non-xoxb token → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/channels/slack/connect",
          { bot_token: "not-a-bot-token", signing_secret: "s3cr3t" },
          { params: { projectId: p.id } },
        );
      r.status(400);
    });
    await ctx.step("xoxb token but missing signing_secret → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/channels/slack/connect",
          { bot_token: "xoxb-not-a-real-token" },
          { params: { projectId: p.id } },
        );
      r.status(400);
    });
    await ctx.step("well-formed xoxb token Slack rejects → 400/502 (no real Slack app)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/channels/slack/connect",
          { bot_token: "xoxb-0000-0000-fakefakefake", signing_secret: "s3cr3t" },
          { params: { projectId: p.id } },
        );
      r.status([400, 502]);
    });
    await ctx.step("NONMEMBER cannot connect → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post(
          "/v1/projects/:projectId/channels/slack/connect",
          { bot_token: "xoxb-x", signing_secret: "y" },
          { params: { projectId: p.id } },
        );
      r.status([403, 404]);
    });
  },
);

// CHN-3 — Slack disconnect (manage ACL); idempotent.
flow(
  "CHN-3",
  {
    domain: "channels",
    routes: ["DELETE /v1/projects/:projectId/channels/slack/installation"],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("OWNER disconnect → 200 (idempotent)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/projects/:projectId/channels/slack/installation", { params: { projectId: p.id } });
      r.status(200).body().has("$.status", "disconnected");
    });
    await ctx.step("NONMEMBER cannot disconnect → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .del("/v1/projects/:projectId/channels/slack/installation", { params: { projectId: p.id } });
      r.status([403, 404]);
    });
  },
);

// CHN-4 — Slack inbound, shared OAuth mode (POST /v1/webhooks/slack). Public.
// Gated: OAuth mode not configured → 503 (before signature); configured but
// unsigned → 401. Challenge only echoes after signature passes.
flow(
  "CHN-4",
  {
    domain: "channels",
    routes: ["POST /v1/webhooks/slack"],
  },
  async (ctx) => {
    await ctx.step("ANON unsigned event → 503 (unconfigured) or 401 (bad sig)", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/webhooks/slack", { type: "event_callback", event: { type: "app_mention" } });
      r.status([401, 503]);
    });
    await ctx.step("ANON url_verification challenge unsigned → 503/401 (sig gate first)", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/webhooks/slack", { type: "url_verification", challenge: "abc123" });
      r.status([401, 503]);
    });
  },
);

// CHN-5 — Slack inbound, BYO per-project (POST /v1/webhooks/slack/:projectId). Public.
// Not configured for project → 404; configured + bad sig → 401.
flow(
  "CHN-5",
  {
    domain: "channels",
    routes: ["POST /v1/webhooks/slack/:projectId"],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("project with no Slack install → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/webhooks/slack/:projectId", { type: "url_verification", challenge: "abc123" }, {
          params: { projectId: p.id },
        });
      r.status([404, 401]);
    });
    await ctx.step("unknown project → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/webhooks/slack/:projectId", { type: "event_callback" }, { params: { projectId: UNKNOWN } });
      r.status(404);
    });
  },
);

// CHN-11 — Slack slash commands (POST /v1/webhooks/slack/commands). Public, OAuth-mode gated.
flow(
  "CHN-11",
  {
    domain: "channels",
    routes: ["POST /v1/webhooks/slack/commands"],
  },
  async (ctx) => {
    await ctx.step("ANON unsigned command → 503 (unconfigured) or 401 (bad sig)", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/webhooks/slack/commands", { command: "/kortix", text: "hi" });
      r.status([401, 503]);
    });
  },
);

// CHN-12 — Slack interactivity (POST /v1/webhooks/slack/interactivity). Public, OAuth-mode gated.
flow(
  "CHN-12",
  {
    domain: "channels",
    routes: ["POST /v1/webhooks/slack/interactivity"],
  },
  async (ctx) => {
    await ctx.step("ANON unsigned interaction → 503 (unconfigured) or 401 (bad sig)", async () => {
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/webhooks/slack/interactivity", { payload: "{}" });
      r.status([401, 503]);
    });
  },
);

// CHN-16 — AgentMail inbound email webhook. Public, Svix signature-gated when configured.
flow(
  "CHN-16",
  {
    domain: "channels",
    routes: ["POST /v1/webhooks/email/agentmail"],
  },
  async (ctx) => {
    await ctx.step("ANON unsigned AgentMail event → accepted locally or rejected by signing gate", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/webhooks/email/agentmail", {
          type: "event",
          event_type: "message.received",
          event_id: "evt_ke2e_unsigned",
          message: {
            inbox_id: "inb_ke2e_missing",
            thread_id: "thr_ke2e",
            message_id: "msg_ke2e",
            from: "sender@example.com",
            to: ["agent@example.com"],
            labels: [],
            timestamp: new Date().toISOString(),
            size: 1,
            updated_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
          },
          thread: {
            inbox_id: "inb_ke2e_missing",
            thread_id: "thr_ke2e",
            labels: [],
            timestamp: new Date().toISOString(),
            senders: ["sender@example.com"],
            recipients: ["agent@example.com"],
            last_message_id: "msg_ke2e",
            message_count: 1,
            size: 1,
            updated_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
          },
        });
      r.status([200, 401, 503]);
    });
  },
);

// CHN-7 — Slack OAuth callback (GET /v1/webhooks/slack/oauth/callback). Public.
// Unconfigured → 503; configured + missing code/state → 400; slack error → 302.
flow(
  "CHN-7",
  {
    domain: "channels",
    routes: ["GET /v1/webhooks/slack/oauth/callback"],
  },
  async (ctx) => {
    await ctx.step("no params → 503 (unconfigured) or 400 (missing code/state)", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/webhooks/slack/oauth/callback");
      r.status([400, 503]);
    });
    await ctx.step("invalid state token → 503/400 (state never verifies)", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/webhooks/slack/oauth/callback?code=abc&state=garbage.sig");
      r.status([400, 503]);
    });
  },
);
