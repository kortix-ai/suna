/**
 * Channel OAuth install completion — spec §CHN (CHN-34).
 *
 * The Slack and Teams OAuth callbacks hand the browser to the web completion
 * page. That page posts the provider code and the signed state to
 * `POST /v1/projects/:projectId/channels/{slack,teams}/oauth/complete` with
 * the signed-in user's bearer. The route is gated like a manual connect
 * (project manage + connector.write), and it installs only when the state
 * names the caller and the path project. The local profile has no Slack or
 * Microsoft app, so the positive exchange is covered by the API unit tests;
 * this flow proves the gate order and that a state that does not verify
 * writes no install.
 */
import { Client as PgClient } from "pg";
import type { FlowContext } from "../core/types";
import { flow } from "../core/flow";

async function withDb<T>(ctx: FlowContext, run: (db: PgClient) => Promise<T>): Promise<T> {
  const db = new PgClient({ connectionString: ctx.env.databaseUrl! });
  await db.connect();
  try {
    return await run(db);
  } finally {
    await db.end().catch(() => {});
  }
}

flow(
  "CHN-34",
  {
    domain: "channels",
    requires: ["database"],
    routes: [
      "POST /v1/projects/:projectId/channels/slack/oauth/complete",
      "POST /v1/projects/:projectId/channels/teams/oauth/complete",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const p = await team.project();
    const memberOnly = await team.addMember("member");
    await team.grantProjectRole(p.id, memberOnly.userId!, "user");
    const installsFor = (projectId: string) =>
      withDb(ctx, async (db) =>
        Number(
          (await db.query("SELECT count(*)::int AS n FROM kortix.chat_installs WHERE project_id = $1", [projectId]))
            .rows[0].n,
        ),
      );
    const body = { code: "ke2e-code", state: "not-a-signed-state" };

    for (const platform of ["slack", "teams"] as const) {
      const path = `/v1/projects/:projectId/channels/${platform}/oauth/complete`;

      await ctx.step(`${platform}: an anonymous caller → 401`, async () => {
        const r = await ctx.client.as(ctx.P.ANON).post(path, body, { params: { projectId: p.id } });
        r.status(401);
      });

      await ctx.step(`${platform}: a project member without connector.write → 403`, async () => {
        const r = await ctx.client.as(memberOnly).post(path, body, { params: { projectId: p.id } });
        r.status(403);
      });

      await ctx.step(`${platform}: the owner with a state that does not verify → 400, and no install is written`, async () => {
        const r = await ctx.client.as(ctx.P.OWNER).post(path, body, { params: { projectId: p.id } });
        r.status(400).body().has("$.code", "CHANNEL_INSTALL_STATE_INVALID");
        if ((await installsFor(p.id)) !== 0) throw new Error("CHN-34: a refused completion wrote an install");
      });
    }
  },
);
