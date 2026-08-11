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
 * - BYO per-project webhook (/webhooks/slack/:workspaceId) returns 404 when the
 *   project has no install configured; a configured-but-bad-signature would be
 *   401.
 * - Email connect is AgentMail-native. The negative path uses an intentionally
 *   bogus API key so live suites do not create real inboxes unless a specific
 *   positive flow opts in.
 */
import { flow } from "../core/flow";
import { waitFor } from "../core/poll";
import { CliSandbox } from "../fixtures/cli";

const UNKNOWN = "00000000-0000-4000-a000-000000000000";

// CHN-2 — Slack installation status (read ACL).
flow(
  "CHN-2",
  {
    domain: "channels",
    routes: ["GET /v1/projects/:workspaceId/channels/slack/installation"],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("OWNER reads install status → 200 (null when not connected)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:workspaceId/channels/slack/installation", { params: { workspaceId: p.id } });
      r.status(200);
    });
    await ctx.step("NONMEMBER → 404 (loadProjectForUser denies)", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/projects/:workspaceId/channels/slack/installation", { params: { workspaceId: p.id } });
      r.status([403, 404]);
    });
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/projects/:workspaceId/channels/slack/installation", { params: { workspaceId: p.id } });
      r.status(401);
    });
  },
);

// CHN-14 — Email installation status (read ACL).
flow(
  "CHN-14",
  {
    domain: "channels",
    routes: ["GET /v1/projects/:workspaceId/channels/email/installation"],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("OWNER reads email install status → 200 (null when not connected)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:workspaceId/channels/email/installation", { params: { workspaceId: p.id } });
      r.status(200);
    });
    await ctx.step("NONMEMBER → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/projects/:workspaceId/channels/email/installation", { params: { workspaceId: p.id } });
      r.status([403, 404]);
    });
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/projects/:workspaceId/channels/email/installation", { params: { workspaceId: p.id } });
      r.status(401);
    });
  },
);

// CHN-17 — Email mode/capabilities (managed AgentMail availability).
flow(
  "CHN-17",
  {
    domain: "channels",
    routes: ["GET /v1/projects/:workspaceId/channels/email/mode"],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("OWNER reads email mode → 200 (disabled unless experimental flag is enabled)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:workspaceId/channels/email/mode", { params: { workspaceId: p.id } });
      r.status(200).body().has("$.provider", "agentmail").has("$.enabled", false);
    });
    await ctx.step("NONMEMBER → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/projects/:workspaceId/channels/email/mode", { params: { workspaceId: p.id } });
      r.status([403, 404]);
    });
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/projects/:workspaceId/channels/email/mode", { params: { workspaceId: p.id } });
      r.status(401);
    });
  },
);

// CHN-13 — Email connect (manage ACL); creates AgentMail inbox + webhook.
flow(
  "CHN-13",
  {
    domain: "channels",
    routes: ["POST /v1/projects/:workspaceId/channels/email/connect"],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("disabled by default → 403 before AgentMail key validation", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:workspaceId/channels/email/connect",
          { api_key: "am_us_bogus", display_name: "Kortix E2E" },
          { params: { workspaceId: p.id } },
        );
      r.status(403);
      r.body().has("$.code", "feature_disabled");
      r.body().has("$.feature", "agentmail_email");
    });
    await ctx.step("NONMEMBER cannot connect → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post(
          "/v1/projects/:workspaceId/channels/email/connect",
          { api_key: "am_us_bogus", display_name: "Kortix E2E" },
          { params: { workspaceId: p.id } },
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
    routes: ["DELETE /v1/projects/:workspaceId/channels/email/installation"],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("OWNER disconnect → 200 (idempotent)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/projects/:workspaceId/channels/email/installation", { params: { workspaceId: p.id } });
      r.status(200).body().has("$.status", "disconnected");
    });
    await ctx.step("NONMEMBER cannot disconnect → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .del("/v1/projects/:workspaceId/channels/email/installation", { params: { workspaceId: p.id } });
      r.status([403, 404]);
    });
  },
);

// CHN-10 — Slack OAuth mode discovery (read ACL).
flow(
  "CHN-10",
  {
    domain: "channels",
    routes: ["GET /v1/projects/:workspaceId/channels/slack/mode"],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("OWNER reads mode → 200 with oauth_available + install_url", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:workspaceId/channels/slack/mode", { params: { workspaceId: p.id } });
      r.status(200).body().exists("$.oauth_available");
    });
    await ctx.step("NONMEMBER → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/projects/:workspaceId/channels/slack/mode", { params: { workspaceId: p.id } });
      r.status([403, 404]);
    });
  },
);

// CHN-1b — the real CLI process selects one-click OAuth when the host exposes it.
flow(
  "CHN-1b",
  {
    domain: "channels",
    routes: [
      "GET /v1/accounts/me",
      "GET /v1/projects/:projectId/channels/slack/mode",
      "GET /v1/projects/:projectId/channels/slack/installation",
    ],
  },
  async (ctx) => {
    const project = await ctx.fixtures.sharedProject();
    const modeResponse = await ctx.client
      .as(ctx.P.OWNER)
      .get("/v1/projects/:projectId/channels/slack/mode", {
        params: { projectId: project.id },
      });
    modeResponse.status(200);
    const mode = modeResponse.json<{ oauth_available: boolean; install_url: string | null }>();
    const pat = await ctx.fixtures.pat({ name: ctx.fixtures.name("cli-channels") });
    const sandbox = new CliSandbox("channels-one-click");
    try {
      const login = await sandbox.login(pat, { noProject: true });
      if (login.exitCode !== 0) throw new Error(`CLI login failed: ${login.all}`);

      await ctx.step(
        "kortix channels connect reads the host mode and prints the configured setup path",
        async () => {
          const result = await sandbox.run([
            "channels",
            "connect",
            "--project",
            project.id,
            "--json",
          ]);
          if (mode.oauth_available && mode.install_url) {
            const output = JSON.parse(result.stdout) as {
              connected: boolean;
              install_url: string | null;
            };
            if (result.exitCode !== 0) throw new Error(result.all);
            if (!output.install_url) throw new Error("CLI returned no Slack install URL");
            const cliUrl = new URL(output.install_url);
            const apiUrl = new URL(mode.install_url);
            const cliState = cliUrl.searchParams.get("state");
            const apiState = apiUrl.searchParams.get("state");
            if (!cliState || !apiState) throw new Error("Slack install URL omitted signed state");
            cliUrl.searchParams.delete("state");
            apiUrl.searchParams.delete("state");
            if (cliUrl.toString() !== apiUrl.toString()) {
              throw new Error(`CLI install URL ${cliUrl} != API ${apiUrl}`);
            }
          } else {
            if (result.exitCode !== 2) {
              throw new Error(`manual setup without credentials must exit 2, got ${result.exitCode}`);
            }
            if (!/--bot-token/.test(result.stderr) || !/channels manifest/.test(result.stderr)) {
              throw new Error(`CLI did not print the manual Slack setup path: ${result.stderr}`);
            }
          }
        },
      );
    } finally {
      sandbox.dispose();
    }
  },
);

// CHN-1 — Slack BYO connect (manage ACL); validates xoxb- via Slack auth.test.
flow(
  "CHN-1",
  {
    domain: "channels",
    routes: ["POST /v1/projects/:workspaceId/channels/slack/connect"],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("missing/blank bot_token → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:workspaceId/channels/slack/connect", {}, { params: { workspaceId: p.id } });
      r.status(400);
    });
    await ctx.step("non-xoxb token → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:workspaceId/channels/slack/connect",
          { bot_token: "not-a-bot-token", signing_secret: "s3cr3t" },
          { params: { workspaceId: p.id } },
        );
      r.status(400);
    });
    await ctx.step("xoxb token but missing signing_secret → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:workspaceId/channels/slack/connect",
          { bot_token: "xoxb-not-a-real-token" },
          { params: { workspaceId: p.id } },
        );
      r.status(400);
    });
    await ctx.step("well-formed xoxb token Slack rejects → 400/502 (no real Slack app)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:workspaceId/channels/slack/connect",
          { bot_token: "xoxb-0000-0000-fakefakefake", signing_secret: "s3cr3t" },
          { params: { workspaceId: p.id } },
        );
      r.status([400, 502]);
    });
    await ctx.step("NONMEMBER cannot connect → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post(
          "/v1/projects/:workspaceId/channels/slack/connect",
          { bot_token: "xoxb-x", signing_secret: "y" },
          { params: { workspaceId: p.id } },
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
    routes: ["DELETE /v1/projects/:workspaceId/channels/slack/installation"],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("OWNER disconnect → 200 (idempotent)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/projects/:workspaceId/channels/slack/installation", { params: { workspaceId: p.id } });
      r.status(200).body().has("$.status", "disconnected");
    });
    await ctx.step("NONMEMBER cannot disconnect → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .del("/v1/projects/:workspaceId/channels/slack/installation", { params: { workspaceId: p.id } });
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

// CHN-5 — Slack inbound, BYO per-project (POST /v1/webhooks/slack/:workspaceId). Public.
// An unsigned url_verification bootstrap is accepted before installation;
// real callbacks still require a configured project signing secret.
flow(
  "CHN-5",
  {
    domain: "channels",
    routes: ["POST /v1/webhooks/slack/:workspaceId"],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("unsigned url_verification bootstrap → 200 challenge", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/webhooks/slack/:workspaceId", { type: "url_verification", challenge: "abc123" }, {
          params: { workspaceId: p.id },
        });
      r.status(200).body().has("$.challenge", "abc123");
    });
    await ctx.step("unknown project → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/webhooks/slack/:workspaceId", { type: "event_callback" }, { params: { workspaceId: UNKNOWN } });
      r.status(404);
    });
  },
);

// CHN-8 — configure a Telegram boundary, submit both supported update shapes,
// and prove the accepted message creates one project-visible session.
flow(
  "CHN-8",
  {
    domain: "channels",
    serial: true,
    timeoutMs: 180_000,
    requires: ["database", "daytona", "funded"],
    routes: [
      "POST /v1/projects/:projectId/secrets",
      "POST /v1/webhooks/telegram/:projectId",
      "GET /v1/projects/:projectId/sessions",
    ],
  },
  async (ctx) => {
    const senderId = 987654321;
    const project = await ctx.fixtures.project({
      seed: true,
      metadata: { telegram: { allowedUserIds: [senderId] } },
    });
    const webhookSecret = `ke2e-telegram-${Date.now()}`;
    const updateId = Date.now();
    const message = {
      message_id: 42,
      chat: { id: 123456789, type: "private" },
      from: { id: senderId, username: "ke2e" },
      text: "Summarize the release status",
    };

    await ctx.step("a project manager stores the Telegram webhook secret for connector-only use", async () => {
      const response = await ctx.client.as(ctx.P.OWNER).post(
        "/v1/projects/:projectId/secrets",
        {
          name: "TELEGRAM_WEBHOOK_SECRET",
          value: webhookSecret,
          strategy: "broker",
          consumer: "connector",
        },
        { params: { projectId: project.id } },
      );
      response.status(200).body().has("$.strategy", "broker").has("$.consumer", "connector");
    });

    await ctx.step("a configured Telegram webhook rejects a missing or mismatched secret token", async () => {
      const missing = await ctx.client.as(ctx.P.ANON).post(
        "/v1/webhooks/telegram/:projectId",
        { update_id: updateId, message },
        { params: { projectId: project.id } },
      );
      missing.status(401);

      const mismatched = await ctx.client.as(ctx.P.ANON).post(
        "/v1/webhooks/telegram/:projectId",
        { update_id: updateId, message },
        {
          params: { projectId: project.id },
          headers: { "x-telegram-bot-api-secret-token": `${webhookSecret}-wrong` },
        },
      );
      mismatched.status(401);
    });

    await ctx.step("a signed Telegram message creates one project-visible owner session", async () => {
      const response = await ctx.client.as(ctx.P.ANON).post(
        "/v1/webhooks/telegram/:projectId",
        { update_id: updateId, message },
        {
          params: { projectId: project.id },
          headers: { "x-telegram-bot-api-secret-token": webhookSecret },
        },
      );
      response.status(200).body().has("$.ok", true);

      const sessions = await waitFor(
        async () => {
          const read = await ctx.client
            .as(ctx.P.OWNER)
            .get("/v1/projects/:projectId/sessions", { params: { projectId: project.id } });
          read.status(200);
          const body = read.json<any>();
          return Array.isArray(body) ? body : (body.sessions ?? []);
        },
        {
          until: (rows) => rows.some((row: any) => row?.metadata?.source === "telegram"),
          timeoutMs: 120_000,
          intervalMs: 1_000,
          description: `a Telegram session for ${project.id}`,
        },
      );
      const created = sessions.find((row: any) => row?.metadata?.source === "telegram");
      if (created?.visibility !== "project") {
        throw new Error(`Telegram session visibility is ${String(created?.visibility)}`);
      }
      if (created?.created_by !== ctx.P.OWNER.userId) {
        throw new Error(`Telegram session actor is ${String(created?.created_by)}`);
      }
      if (created?.session_id) ctx.track("session", created.session_id, { projectId: project.id });
    });

    await ctx.step("a signed edited_message update is accepted through the same boundary", async () => {
      const response = await ctx.client.as(ctx.P.ANON).post(
        "/v1/webhooks/telegram/:projectId",
        { update_id: updateId, edited_message: message },
        {
          params: { projectId: project.id },
          headers: { "x-telegram-bot-api-secret-token": webhookSecret },
        },
      );
      response.status(200).body().has("$.ok", true);
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

const UNKNOWN_BINDING = "00000000-0000-4000-a000-000000000001";

// CHN-18 — Channel bindings list (read ACL). The web management surface for
// `chat_channel_bindings` — today only reachable via Slack `/kortix` commands.
flow(
  "CHN-18",
  {
    domain: "channels",
    routes: ["GET /v1/projects/:workspaceId/channels/bindings"],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("OWNER lists bindings → 200 (empty when no channel is bound)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:workspaceId/channels/bindings", { params: { workspaceId: p.id } });
      r.status(200).body().exists("$.bindings");
    });
    await ctx.step("NONMEMBER → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/projects/:workspaceId/channels/bindings", { params: { workspaceId: p.id } });
      r.status([403, 404]);
    });
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/projects/:workspaceId/channels/bindings", { params: { workspaceId: p.id } });
      r.status(401);
    });
  },
);

// CHN-19 — Channel binding update (manage ACL / project.connector.write). No
// public seam creates a real Slack binding (requires a live Slack app), so the
// live-only assertable path is the unknown-binding 404 + the auth gate — the
// same shape every other manage-ACL channel route in this file exercises.
flow(
  "CHN-19",
  {
    domain: "channels",
    routes: ["PATCH /v1/projects/:workspaceId/channels/bindings/:bindingId"],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("OWNER, unknown bindingId → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          "/v1/projects/:workspaceId/channels/bindings/:bindingId",
          { conversationPolicy: "owner_only" },
          { params: { workspaceId: p.id, bindingId: UNKNOWN_BINDING } },
        );
      r.status(404);
    });
    await ctx.step("OWNER, unknown binding wins before empty-body validation → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          "/v1/projects/:workspaceId/channels/bindings/:bindingId",
          {},
          { params: { workspaceId: p.id, bindingId: UNKNOWN_BINDING } },
        );
      r.status(404);
    });
    await ctx.step("NONMEMBER cannot update → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .patch(
          "/v1/projects/:workspaceId/channels/bindings/:bindingId",
          { conversationPolicy: "owner_only" },
          { params: { workspaceId: p.id, bindingId: UNKNOWN_BINDING } },
        );
      r.status([403, 404]);
    });
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .patch(
          "/v1/projects/:workspaceId/channels/bindings/:bindingId",
          { conversationPolicy: "owner_only" },
          { params: { workspaceId: p.id, bindingId: UNKNOWN_BINDING } },
        );
      r.status(401);
    });
  },
);

// CHN-20 — send-primitive IAM gate (project.connector.write). The Slack file
// upload proxy POSTs to a channel using the project's own bot credentials; the
// IAM enforcement audit found it was gated by nothing but project-READ, so ANY
// project-read caller could post arbitrary files to Slack. It now asserts
// project.connector.write (the same leaf that gates connect/disconnect and the
// channel-bindings route). Proven black-box: a floor MEMBER (project.read, no
// connector.write) is rejected 403 BEFORE any Slack call, while an EDITOR
// (holds connector.write) passes the gate (fails later on missing install,
// never 403). The scoped-agent-token variant (agent grants are server-minted at
// session start, not reachable over HTTP here) is proven at the API layer in
// integration-project-read-leaf-gates-http.test.ts.
//
// The meet/speak proxy was the other primitive here; it went away with the
// notetaker (see §VOICE) — the voice channel has no send primitive reachable
// over user auth at all.
flow(
  "CHN-20",
  {
    domain: "channels",
    routes: [
      "POST /v1/projects/:workspaceId/channels/slack/file/upload",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const p = await team.project();
    const memberOnly = await team.addMember("member");
    const editor = await team.addMember("member");
    await team.grantProjectRole(p.id, memberOnly.userId!, "user");
    await team.grantProjectRole(p.id, editor.userId!, "editor");

    const SEND_PRIMITIVES = [
      {
        name: "slack file upload",
        path: "/v1/projects/:workspaceId/channels/slack/file/upload",
        body: { channel: "C1", filename: "a.txt", content_base64: "eA==" },
      },
    ] as const;

    for (const sp of SEND_PRIMITIVES) {
      await ctx.step(`${sp.name}: floor MEMBER (no connector.write) → 403`, async () => {
        const r = await ctx.client
          .as(memberOnly)
          .post(sp.path, sp.body, { params: { workspaceId: p.id } });
        r.status(403);
      });
      await ctx.step(`${sp.name}: EDITOR (has connector.write) → passes the gate (not 403)`, async () => {
        const r = await ctx.client
          .as(editor)
          .post(sp.path, sp.body, { params: { workspaceId: p.id } });
        r.status([200, 400, 404, 502, 503]);
      });
      await ctx.step(`${sp.name}: NONMEMBER → 403/404`, async () => {
        const r = await ctx.client
          .as(ctx.P.NONMEMBER)
          .post(sp.path, sp.body, { params: { workspaceId: p.id } });
        r.status([403, 404]);
      });
      await ctx.step(`${sp.name}: ANON → 401`, async () => {
        const r = await ctx.client.as(ctx.P.ANON).post(sp.path, sp.body, { params: { workspaceId: p.id } });
        r.status(401);
      });
    }
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

// CHN-T1 — Teams installation status (read ACL).
flow(
  "CHN-T1",
  {
    domain: "channels",
    routes: ["GET /v1/projects/:workspaceId/channels/teams/installation"],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("OWNER reads install status → 200 (null when not connected)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:workspaceId/channels/teams/installation", { params: { workspaceId: p.id } });
      r.status(200);
    });
    await ctx.step("NONMEMBER → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/projects/:workspaceId/channels/teams/installation", { params: { workspaceId: p.id } });
      r.status([403, 404]);
    });
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/projects/:workspaceId/channels/teams/installation", { params: { workspaceId: p.id } });
      r.status(401);
    });
  },
);

// CHN-T2 — Teams mode discovery (read ACL).
flow(
  "CHN-T2",
  {
    domain: "channels",
    routes: ["GET /v1/projects/:workspaceId/channels/teams/mode"],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("OWNER reads mode → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:workspaceId/channels/teams/mode", { params: { workspaceId: p.id } });
      r.status(200);
    });
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/projects/:workspaceId/channels/teams/mode", { params: { workspaceId: p.id } });
      r.status(401);
    });
  },
);

// CHN-T3 — Teams connect (manage ACL). Teams is a per-project feature flag
// (#5908): disabled projects get the standard 403 feature_disabled before any
// validation, and once the `teams` flag is on, a bad tenant id is rejected
// with 400.
flow(
  "CHN-T3",
  {
    domain: "channels",
    routes: ["POST /v1/projects/:workspaceId/channels/teams/connect"],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("OWNER, teams flag off (default) → 403 feature_disabled", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:workspaceId/channels/teams/connect", { tenant_id: "not a tenant" }, { params: { workspaceId: p.id } });
      r.status(403);
      r.body().has("$.code", "feature_disabled");
      r.body().has("$.feature", "teams");
    });
    const own = await ctx.fixtures.project();
    await ctx.step("OWNER enables the teams experiment, invalid tenant_id → 400", async () => {
      const enabled = await ctx.client
        .as(ctx.P.OWNER)
        .patch("/v1/projects/:workspaceId/experimental", { feature: "teams", enabled: true }, { params: { workspaceId: own.id } });
      enabled.status(200);
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:workspaceId/channels/teams/connect", { tenant_id: "not a tenant" }, { params: { workspaceId: own.id } });
      r.status(400);
    });
    await ctx.step("NONMEMBER → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post("/v1/projects/:workspaceId/channels/teams/connect", { tenant_id: "contoso.onmicrosoft.com" }, { params: { workspaceId: p.id } });
      r.status([403, 404]);
    });
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/projects/:workspaceId/channels/teams/connect", { tenant_id: "contoso.onmicrosoft.com" }, { params: { workspaceId: p.id } });
      r.status(401);
    });
  },
);

// CHN-T4 — Teams inbound webhook (public, JWT-gated). Unconfigured → 503; configured + no/invalid token → 401.
flow(
  "CHN-T4",
  {
    domain: "channels",
    routes: ["POST /v1/webhooks/teams/messages"],
  },
  async (ctx) => {
    await ctx.step("ANON unsigned activity → 503 (unconfigured) or 401 (no/invalid token)", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/webhooks/teams/messages", { type: "message", text: "hi" });
      r.status([401, 503]);
    });
  },
);

// CHN-21 — Slack identity "/login/:token" magic-link redirect (public). Mirrors
// the already-allowlisted teams identity-login twin: login.ts never verifies the
// token server-side (that happens client-side when the web page POSTs /bind), so
// it's a deterministic, always-200 HTML redirect for ANY token shape — bogus
// included. Real coverage: status + content-type + the token round-tripping into
// the redirect target (proves the handler actually read the param, not a 404
// route-miss).
flow(
  "CHN-21",
  {
    domain: "channels",
    routes: ["GET /v1/channels/slack/identity/login/:token"],
  },
  async (ctx) => {
    await ctx.step("ANON bogus token → 200 HTML redirect (never verified server-side)", async () => {
      const token = "bogus-login-token-ke2e";
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/channels/slack/identity/login/:token", { params: { token } });
      r.status(200).headerEquals("content-type", /text\/html/);
      if (!r.text().includes(encodeURIComponent(token))) {
        throw new Error("CHN-21: redirect target did not echo the token back");
      }
    });
  },
);

// CHN-22 — Per-project (BYO app) Slack manifest (public, unauthenticated
// scaffolding template — no DB lookup, so it renders for ANY workspaceId,
// including one that was never created).
flow(
  "CHN-22",
  {
    domain: "channels",
    routes: ["GET /v1/webhooks/slack/:workspaceId/manifest"],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("ANON reads the BYO manifest for a real project → 200 shape", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/webhooks/slack/:workspaceId/manifest", { params: { workspaceId: p.id } });
      r.status(200)
        .body()
        .exists("$.display_information.name")
        .exists("$.features.slash_commands")
        .exists("$.settings.interactivity.request_url");
      const manifest = r.json<any>();
      if (!manifest.settings.interactivity.request_url.includes(p.id)) {
        throw new Error("CHN-22: manifest webhook URLs are not scoped to the requested project");
      }
    });
    await ctx.step("ANON on an unknown workspaceId → still 200 (scaffolding template, no DB check)", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/webhooks/slack/:workspaceId/manifest", { params: { workspaceId: UNKNOWN } });
      r.status(200).body().exists("$.display_information.name");
    });
  },
);

// CHN-23 — Bind a Slack thread to a session (dual-authed: user PAT/JWT with
// project-read, or an in-sandbox project-scoped sandbox token). No public seam
// creates a real Slack thread binding without a live Slack workspace, so the
// live-assertable ceiling is validation + the auth boundary — same shape every
// other user-authed channels route in this file exercises.
flow(
  "CHN-23",
  {
    domain: "channels",
    routes: ["POST /v1/projects/:workspaceId/channels/slack/bind-thread"],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    const session = await ctx.fixtures.session(p);

    await ctx.step("OWNER, missing session_id/channel/thread_ts → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:workspaceId/channels/slack/bind-thread", {}, { params: { workspaceId: p.id } });
      r.status(400);
    });

    await ctx.step("OWNER, well-formed but channel not bound to any Slack workspace → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:workspaceId/channels/slack/bind-thread",
          { session_id: session.id, channel: "C_KE2E_UNBOUND", thread_ts: "1700000000.000100" },
          { params: { workspaceId: p.id } },
        );
      r.status(400);
    });

    await ctx.step("NONMEMBER cannot bind → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post(
          "/v1/projects/:workspaceId/channels/slack/bind-thread",
          { session_id: session.id, channel: "C_KE2E_UNBOUND", thread_ts: "1700000000.000100" },
          { params: { workspaceId: p.id } },
        );
      r.status([403, 404]);
    });

    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post(
          "/v1/projects/:workspaceId/channels/slack/bind-thread",
          { session_id: session.id, channel: "C_KE2E_UNBOUND", thread_ts: "1700000000.000100" },
          { params: { workspaceId: p.id } },
        );
      r.status(401);
    });
  },
);

// CHN-24 / CHN-25 — Per-project (BYO app) Slack slash-command + interactivity
// webhooks. This uses the same signed-rejection pattern as the sandbox webhook flow.
// /v1/webhooks/sandbox/*: POST an unsigned body at a REAL (but Slack-unconnected)
// project. loadSlackSigningSecretForProject resolves to null before the HMAC
// check ever runs, so the rejection is a deterministic 404 "Not configured" —
// real coverage of the reject-unsigned boundary, not a route-miss (a genuinely
// unknown project hits the exact same code path, so this also proves the route
// isn't silently accepting anything).
flow(
  "CHN-24",
  {
    domain: "channels",
    routes: ["POST /v1/webhooks/slack/:workspaceId/commands"],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("ANON unsigned slash command on an unconnected project → 404 (not configured)", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post(
          "/v1/webhooks/slack/:workspaceId/commands",
          "command=%2Fkortix&text=hi&team_id=TKE2E&channel_id=CKE2E&user_id=UKE2E",
          { params: { workspaceId: p.id }, raw: true, headers: { "content-type": "application/x-www-form-urlencoded" } },
        );
      r.status(404);
    });
  },
);

flow(
  "CHN-25",
  {
    domain: "channels",
    routes: ["POST /v1/webhooks/slack/:workspaceId/interactivity"],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("ANON unsigned interaction on an unconnected project → 404 (not configured)", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post(
          "/v1/webhooks/slack/:workspaceId/interactivity",
          `payload=${encodeURIComponent(JSON.stringify({ type: "block_actions" }))}`,
          { params: { workspaceId: p.id }, raw: true, headers: { "content-type": "application/x-www-form-urlencoded" } },
        );
      r.status(404);
    });
  },
);
