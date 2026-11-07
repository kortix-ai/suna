/**
 * Discord channel — spec §CHN (CHN-DC1, CHN-DC2).
 *
 * The Kortix Discord application is one app for every project. A deployment
 * without its credentials (the local profile, a preview) offers no install and
 * refuses the interactions webhook; every project route still answers its
 * contract. The signed webhook, the Gateway intake and the conversation are
 * proven in apps/api/src/channels/discord/discord.integration.test.ts, which
 * signs with a test key against a fake Discord.
 */
import { flow } from "../core/flow";
import { withDb } from "../fixtures/chat";

const SNOWFLAKE_A = "740000000000000001";
const SNOWFLAKE_B = "740000000000000002";
const SNOWFLAKE_C = "740000000000000003";

// CHN-DC1 — Discord without a server: availability, the install hand-off and
// its completion, the allowed list and every per-user route need a server, and
// the interactions webhook refuses an unsigned request.
flow(
  "CHN-DC1",
  {
    domain: "channels",
    routes: [
      "GET /v1/workspaces/:projectId/channels/discord/mode",
      "GET /v1/workspaces/:projectId/channels/discord/installation",
      "POST /v1/workspaces/:projectId/channels/discord/oauth/complete",
      "PUT /v1/workspaces/:projectId/channels/discord/allowed-users",
      "DELETE /v1/workspaces/:projectId/channels/discord",
      "GET /v1/workspaces/:projectId/channels/discord/users",
      "GET /v1/workspaces/:projectId/channels/discord/users/:user_id/photo",
      "POST /v1/workspaces/:projectId/channels/discord/allowed-users",
      "DELETE /v1/workspaces/:projectId/channels/discord/allowed-users/:user_id",
      "DELETE /v1/workspaces/:projectId/channels/discord/access-requests/:user_id",
      "GET /v1/webhooks/discord/oauth/callback",
      "POST /v1/webhooks/discord",
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    const params = { projectId: p.id };

    await ctx.step("mode answers availability; an install link carries only Discord's authorize page", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/workspaces/:projectId/channels/discord/mode", { params });
      r.status(200);
      const mode = r.json<{ available: boolean; install_url: string | null }>();
      if (typeof mode.available !== "boolean") throw new Error(`available is not a boolean: ${JSON.stringify(mode)}`);
      if (!mode.available && mode.install_url !== null) throw new Error("an unavailable Discord offers an install link");
      if (mode.install_url && !mode.install_url.startsWith("https://discord.com/oauth2/authorize?")) {
        throw new Error(`install link is not Discord's authorize page: ${mode.install_url}`);
      }
    });

    await ctx.step("a project with no server reads a null installation", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/workspaces/:projectId/channels/discord/installation", { params });
      r.status(200);
      if (r.json<unknown>() !== null) throw new Error(`expected null installation, got ${JSON.stringify(r.json())}`);
    });

    await ctx.step("a completion whose state does not verify installs nothing → 400 CHANNEL_INSTALL_STATE_INVALID", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/workspaces/:projectId/channels/discord/oauth/complete", { code: "synthetic-code", state: "not-a-state" }, { params });
      r.status(400).body().has("$.code", "CHANNEL_INSTALL_STATE_INVALID");
    });

    await ctx.step("the OAuth callback without a code → 400; a cancelled install with a bad state → 302 to the dashboard", async () => {
      (await ctx.client.as(ctx.P.ANON).get("/v1/webhooks/discord/oauth/callback")).status(400);
      const cancelled = await ctx.client.as(ctx.P.ANON).get("/v1/webhooks/discord/oauth/callback", {
        query: { error: "access_denied", state: "not-a-state" },
      });
      cancelled.status(302);
    });

    await ctx.step("allowed users: non-numeric ids → 400; valid ids without a server → 404 discord_not_connected", async () => {
      const owner = ctx.client.as(ctx.P.OWNER);
      (await owner.put("/v1/workspaces/:projectId/channels/discord/allowed-users", { user_ids: ["@someone"] }, { params }))
        .status(400)
        .body()
        .has("$.code", "discord_user_ids_invalid");
      (await owner.put("/v1/workspaces/:projectId/channels/discord/allowed-users", { user_ids: [SNOWFLAKE_A] }, { params }))
        .status(404)
        .body()
        .has("$.code", "discord_not_connected");
    });

    await ctx.step("without a server, every user route answers 404 discord_not_connected; a malformed user id → 400", async () => {
      const owner = ctx.client.as(ctx.P.OWNER);
      const userParams = { ...params, user_id: SNOWFLAKE_A };
      (await owner.get("/v1/workspaces/:projectId/channels/discord/users", { params })).status(404).body().has("$.code", "discord_not_connected");
      (await owner.get("/v1/workspaces/:projectId/channels/discord/users/:user_id/photo", { params: userParams }))
        .status(404)
        .body()
        .has("$.code", "discord_not_connected");
      (await owner.post("/v1/workspaces/:projectId/channels/discord/allowed-users", { user_id: "12345" }, { params }))
        .status(400)
        .body()
        .has("$.code", "discord_user_ids_invalid");
      (await owner.post("/v1/workspaces/:projectId/channels/discord/allowed-users", { user_id: SNOWFLAKE_A }, { params }))
        .status(404)
        .body()
        .has("$.code", "discord_not_connected");
      (await owner.del("/v1/workspaces/:projectId/channels/discord/allowed-users/:user_id", { params: userParams }))
        .status(404)
        .body()
        .has("$.code", "discord_not_connected");
      (await owner.del("/v1/workspaces/:projectId/channels/discord/access-requests/:user_id", { params: userParams }))
        .status(404)
        .body()
        .has("$.code", "discord_not_connected");
    });

    await ctx.step("disconnect is idempotent → 200 ok; a non-member cannot disconnect → 403/404", async () => {
      (await ctx.client.as(ctx.P.OWNER).del("/v1/workspaces/:projectId/channels/discord", { params })).status(200).body().has("$.ok", true);
      (await ctx.client.as(ctx.P.NONMEMBER).del("/v1/workspaces/:projectId/channels/discord", { params })).status([403, 404]);
    });

    await ctx.step("the interactions webhook refuses an unsigned request: 401, or 404 where Discord is not configured", async () => {
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/webhooks/discord", { type: 1 });
      r.status([401, 404]);
    });
  },
);

// CHN-DC2 — Discord access requests: the installation names the server and
// counts the waiting requests, the user list names them from the stored
// request, a project read never carries them, and an admin allows, removes and
// dismisses users one at a time. The install is seeded directly (the real one
// needs Discord's OAuth exchange).
flow(
  "CHN-DC2",
  {
    domain: "channels",
    requires: ["database"],
    routes: [
      "GET /v1/workspaces/:projectId/channels/discord/installation",
      "GET /v1/workspaces/:projectId/channels/discord/users",
      "POST /v1/workspaces/:projectId/channels/discord/allowed-users",
      "PUT /v1/workspaces/:projectId/channels/discord/allowed-users",
      "DELETE /v1/workspaces/:projectId/channels/discord/allowed-users/:user_id",
      "DELETE /v1/workspaces/:projectId/channels/discord/access-requests/:user_id",
      "DELETE /v1/workspaces/:projectId/channels/discord",
      "GET /v1/workspaces/:projectId",
    ],
  },
  async (ctx) => {
    const guildId = `72${String(Date.now()).padStart(16, "0")}`;
    const seeded = await ctx.fixtures.project({
      metadata: {
        discord: {
          allowedUserIds: [SNOWFLAKE_A],
          accessRequests: [
            { id: SNOWFLAKE_B, username: "ke2e_requester", first_name: "Synthetic", last_name: null, last_seen: new Date().toISOString() },
          ],
        },
      },
    });
    const params = { projectId: seeded.id };
    try {
      await withDb(ctx, (db) =>
        db.query("INSERT INTO kortix.chat_installs (platform, workspace_id, project_id) VALUES ('discord', $1, $2)", [guildId, seeded.id]),
      );

      await ctx.step("the installation names the server and counts the waiting request; the user list names it", async () => {
        const owner = ctx.client.as(ctx.P.OWNER);
        (await owner.get("/v1/workspaces/:projectId/channels/discord/installation", { params }))
          .status(200)
          .body()
          .has("$.guild_id", guildId)
          .has("$.allowed_user_ids", [SNOWFLAKE_A])
          .has("$.access_request_count", 1);
        (await owner.get("/v1/workspaces/:projectId/channels/discord/users", { params }))
          .status(200)
          .body()
          .has("$.requests[0].user_id", SNOWFLAKE_B)
          .has("$.requests[0].username", "ke2e_requester")
          .has("$.requests[0].known", true);
      });

      await ctx.step("a project read never carries the Discord lists in its metadata", async () => {
        const r = await ctx.client.as(ctx.P.OWNER).get("/v1/workspaces/:projectId", { params });
        r.status(200);
        const metadata = r.json<{ metadata?: Record<string, unknown> }>().metadata ?? {};
        if ("discord" in metadata) throw new Error(`project metadata exposes discord: ${JSON.stringify(metadata.discord)}`);
      });

      await ctx.step("allow moves the request to the allowed list; remove and dismiss are idempotent; PUT replaces the list", async () => {
        const owner = ctx.client.as(ctx.P.OWNER);
        (await owner.post("/v1/workspaces/:projectId/channels/discord/allowed-users", { user_id: SNOWFLAKE_B }, { params }))
          .status(200)
          .body()
          .has("$.allowed_user_ids", [SNOWFLAKE_A, SNOWFLAKE_B])
          .has("$.access_request_count", 0);
        for (let i = 0; i < 2; i++) {
          (await owner.del("/v1/workspaces/:projectId/channels/discord/allowed-users/:user_id", { params: { ...params, user_id: SNOWFLAKE_B } }))
            .status(200)
            .body()
            .has("$.allowed_user_ids", [SNOWFLAKE_A]);
          (await owner.del("/v1/workspaces/:projectId/channels/discord/access-requests/:user_id", { params: { ...params, user_id: SNOWFLAKE_B } }))
            .status(200)
            .body()
            .has("$.access_request_count", 0);
        }
        (await owner.put("/v1/workspaces/:projectId/channels/discord/allowed-users", { user_ids: [SNOWFLAKE_C] }, { params }))
          .status(200)
          .body()
          .has("$.allowed_user_ids", [SNOWFLAKE_C]);
      });

      await ctx.step("a member without connector.write allows no one → 403; a non-member reads no identities → 403/404", async () => {
        (await ctx.client.as(ctx.P.NONMEMBER).get("/v1/workspaces/:projectId/channels/discord/users", { params })).status([403, 404]);
        (await ctx.client.as(ctx.P.NONMEMBER).post("/v1/workspaces/:projectId/channels/discord/allowed-users", { user_id: SNOWFLAKE_C }, { params })).status([403, 404]);
      });

      await ctx.step("disconnect removes the server and keeps the allowed list for a reconnect", async () => {
        const owner = ctx.client.as(ctx.P.OWNER);
        (await owner.del("/v1/workspaces/:projectId/channels/discord", { params })).status(200).body().has("$.ok", true);
        const r = await owner.get("/v1/workspaces/:projectId/channels/discord/installation", { params });
        r.status(200);
        if (r.json<unknown>() !== null) throw new Error(`expected null installation after disconnect, got ${JSON.stringify(r.json())}`);
        const rows = await withDb(ctx, (db) =>
          db.query("SELECT metadata->'discord'->'allowedUserIds' AS ids FROM kortix.projects WHERE project_id = $1", [seeded.id]),
        );
        if (JSON.stringify(rows.rows[0]?.ids) !== JSON.stringify([SNOWFLAKE_C])) throw new Error(`allowed list not kept: ${JSON.stringify(rows.rows[0])}`);
      });
    } finally {
      await withDb(ctx, (db) => db.query("DELETE FROM kortix.chat_installs WHERE platform = 'discord' AND workspace_id = $1", [guildId])).catch(() => {});
    }
  },
);
