/**
 * Chat-channel settings and session listing — spec §CHN (CHN-32, CHN-33).
 *
 * Both flows drive a per-project Slack app's signed slash-command webhook, the
 * route a Slack user reaches. The install, the identity links, the channel
 * binding, and the sessions are seeded directly: connect proves the workspace
 * through Slack's auth.test, which the local profile cannot reach.
 */
import { randomUUID } from "node:crypto";
import { flow } from "../core/flow";
import type { FlowContext, Principal } from "../core/types";
import { slackSigned, withDb } from "../fixtures/chat";
import { createDatabaseSession } from "../fixtures/database-project";

const ROUTES = ["POST /v1/projects/:projectId/secrets", "POST /v1/webhooks/slack/:projectId/commands"];
const CHANNEL = "CKE2ESETTINGS";

interface SlackWorld {
  projectId: string;
  accountId: string;
  teamId: string;
  secret: string;
  member: Principal;
  manager: Principal;
  memberSlackId: string;
  managerSlackId: string;
}

/** A team project with a per-project Slack app, a linked member and a linked project manager. */
async function slackWorld(ctx: FlowContext): Promise<SlackWorld> {
  const team = await ctx.fixtures.team();
  const p = await team.project();
  const member = await team.addMember("member");
  const manager = await team.addMember("member");
  await team.grantProjectRole(p.id, member.userId!, "user");
  await team.grantProjectRole(p.id, manager.userId!, "manager");
  const world: SlackWorld = {
    projectId: p.id,
    accountId: "",
    teamId: `TKE2E${randomUUID().slice(0, 8).toUpperCase()}`,
    secret: `ke2e-signing-${randomUUID()}`,
    member,
    manager,
    memberSlackId: `UKE2EM${randomUUID().slice(0, 6).toUpperCase()}`,
    managerSlackId: `UKE2EG${randomUUID().slice(0, 6).toUpperCase()}`,
  };
  const r = await ctx.client
    .as(ctx.P.OWNER)
    .post(
      "/v1/projects/:projectId/secrets",
      { name: "SLACK_SIGNING_SECRET", value: world.secret, strategy: "broker", consumer: "connector" },
      { params: { projectId: p.id } },
    );
  r.status([200, 201]);
  await withDb(ctx, async (db) => {
    world.accountId = (await db.query("SELECT account_id FROM kortix.projects WHERE project_id = $1", [p.id])).rows[0]
      .account_id as string;
    await db.query("INSERT INTO kortix.chat_installs (platform, workspace_id, project_id) VALUES ('slack', $1, $2)", [
      world.teamId,
      p.id,
    ]);
    await db.query(
      `INSERT INTO kortix.chat_user_identities (platform, workspace_id, platform_user_id, user_id)
       VALUES ('slack', $1, $2, $3), ('slack', $1, $4, $5)`,
      [world.teamId, world.memberSlackId, member.userId, world.managerSlackId, manager.userId],
    );
  });
  return world;
}

async function dropSlackWorld(ctx: FlowContext, world: SlackWorld): Promise<void> {
  await withDb(ctx, async (db) => {
    for (const table of ["chat_threads", "chat_channel_bindings", "chat_user_identities", "chat_installs"]) {
      await db.query(`DELETE FROM kortix.${table} WHERE platform = 'slack' AND workspace_id = $1`, [world.teamId]);
    }
  }).catch(() => {});
}

/** Run `/kortix <text>` as a Slack user through the project's signed command webhook. */
async function slash(ctx: FlowContext, world: SlackWorld, slackUserId: string, text: string): Promise<string> {
  const body = new URLSearchParams({
    command: "/kortix",
    text,
    team_id: world.teamId,
    user_id: slackUserId,
    channel_id: CHANNEL,
  }).toString();
  const r = await ctx.client
    .as(ctx.P.ANON)
    .post("/v1/webhooks/slack/:projectId/commands", body, {
      params: { projectId: world.projectId },
      ...slackSigned(world.secret, body, "application/x-www-form-urlencoded"),
    });
  r.status(200);
  return r.text();
}

// CHN-32 — A channel's model, agent and session policy are project settings.
// Changing one from Slack needs what the web binding editor needs: a linked
// Kortix account with project.connector.write on the channel's project.
flow("CHN-32", { domain: "channels", requires: ["database"], routes: ROUTES }, async (ctx) => {
  const world = await slackWorld(ctx);
  const binding = () =>
    withDb(ctx, async (db) =>
      (
        await db.query(
          `SELECT opencode_model, agent_name, conversation_policy FROM kortix.chat_channel_bindings
           WHERE platform = 'slack' AND workspace_id = $1 AND channel_id = $2`,
          [world.teamId, CHANNEL],
        )
      ).rows[0] as { opencode_model: string | null; agent_name: string | null; conversation_policy: string },
    );

  try {
    await ctx.step("the channel is bound to the project with a pinned model and the default policy", async () => {
      await withDb(ctx, (db) =>
        db.query(
          `INSERT INTO kortix.chat_channel_bindings (platform, workspace_id, channel_id, project_id, opencode_model)
           VALUES ('slack', $1, $2, $3, 'kortix/ke2e-seed-model')`,
          [world.teamId, CHANNEL, world.projectId],
        ),
      );
      const row = await binding();
      if (row.opencode_model !== "kortix/ke2e-seed-model") throw new Error("CHN-32: the seeded binding is missing");
    });

    await ctx.step("a linked project member without connector.write is refused a model, agent and policy change; the binding is unchanged", async () => {
      const before = await binding();
      for (const text of ["model default", "agent reviewer", "policy owner_only"]) {
        const reply = await slash(ctx, world, world.memberSlackId, text);
        if (!reply.includes("Only a project manager")) throw new Error(`CHN-32: \`/kortix ${text}\` by a member was not refused: ${reply}`);
      }
      const after = await binding();
      if (JSON.stringify(after) !== JSON.stringify(before)) {
        throw new Error(`CHN-32: a member changed the binding: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
      }
    });

    await ctx.step("an unlinked Slack user is asked to connect, and the binding is unchanged", async () => {
      const reply = await slash(ctx, world, "UKE2EUNLINKED", "model default");
      if (!reply.includes("Connect your Kortix account first")) throw new Error(`CHN-32: an unlinked user was not refused: ${reply}`);
      if ((await binding()).opencode_model !== "kortix/ke2e-seed-model") throw new Error("CHN-32: an unlinked user changed the model");
    });

    await ctx.step("the linked project manager resets the model and sets the policy; the binding records both", async () => {
      const reset = await slash(ctx, world, world.managerSlackId, "model default");
      if (!reset.includes("reset to the project default")) throw new Error(`CHN-32: the manager could not reset the model: ${reset}`);
      const policy = await slash(ctx, world, world.managerSlackId, "policy owner_only");
      if (!policy.includes("policy set to")) throw new Error(`CHN-32: the manager could not set the policy: ${policy}`);
      const row = await binding();
      if (row.opencode_model !== null || row.conversation_policy !== "owner_only") {
        throw new Error(`CHN-32: the manager's changes were not stored: ${JSON.stringify(row)}`);
      }
    });
  } finally {
    await dropSlackWorld(ctx, world);
  }
});

// CHN-33 — `/kortix sessions` lists only the Slack-started sessions the
// caller's linked Kortix account may open on the web.
flow("CHN-33", { domain: "channels", requires: ["database"], routes: ROUTES }, async (ctx) => {
  const world = await slackWorld(ctx);
  const sessions: Record<"ownerPrivate" | "ownerProject" | "memberPrivate", string> = {
    ownerPrivate: "",
    ownerProject: "",
    memberPrivate: "",
  };

  try {
    await ctx.step("three Slack-started sessions exist: the owner's private one, the owner's project-visible one, and the member's own", async () => {
      const make = (userId: string, visibility: "private" | "project") =>
        createDatabaseSession(ctx.env, { projectId: world.projectId, accountId: world.accountId, userId, visibility });
      sessions.ownerPrivate = await make(ctx.P.OWNER.userId!, "private");
      sessions.ownerProject = await make(ctx.P.OWNER.userId!, "project");
      sessions.memberPrivate = await make(world.member.userId!, "private");
      await withDb(ctx, async (db) => {
        let ts = 1_700_000_000;
        for (const sessionId of Object.values(sessions)) {
          await db.query(
            `INSERT INTO kortix.chat_threads (project_id, platform, workspace_id, thread_id, session_id)
             VALUES ($1, 'slack', $2, $3, $4)`,
            [world.projectId, world.teamId, `${ts++}.000100`, sessionId],
          );
        }
      });
    });

    await ctx.step("the linked member sees their own session and the project-visible one, never the owner's private session", async () => {
      const reply = await slash(ctx, world, world.memberSlackId, "sessions");
      if (!reply.includes(sessions.memberPrivate) || !reply.includes(sessions.ownerProject)) {
        throw new Error(`CHN-33: the member's list is missing a session they may open: ${reply}`);
      }
      if (reply.includes(sessions.ownerPrivate)) throw new Error("CHN-33: the member's list names the owner's private session");
    });

    await ctx.step("an unlinked Slack user is asked to connect and sees no session", async () => {
      const reply = await slash(ctx, world, "UKE2EUNLINKED", "sessions");
      if (!reply.includes("Connect your Kortix account")) throw new Error(`CHN-33: an unlinked user was not asked to connect: ${reply}`);
      if (Object.values(sessions).some((id) => reply.includes(id))) throw new Error("CHN-33: an unlinked user saw a session");
    });
  } finally {
    await dropSlackWorld(ctx, world);
    await withDb(ctx, (db) => db.query("DELETE FROM kortix.project_sessions WHERE session_id = ANY($1)", [Object.values(sessions)])).catch(
      () => {},
    );
  }
});
