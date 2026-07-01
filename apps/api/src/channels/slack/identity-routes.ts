/**
 * Slack `/login` — the AUTHENTICATED bind half.
 *
 * The Slack slash command mints a short-lived signed token (channels/slack/login.ts)
 * and DMs the user a link to the web page. That page requires a normal Kortix
 * login and POSTs the token here with the user's bearer. We verify the token,
 * confirm the now-known Kortix user is a member of the Slack workspace's project
 * account, and persist the (workspace, slack_user) → kortix_user mapping.
 *
 * Same trust model as accepting a team invite: the token proves which Slack user
 * asked to link; the bearer proves which Kortix user is accepting.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { projects } from "@kortix/db";
import { inArray } from "drizzle-orm";
import { Effect } from "effect";
import type { Context } from "hono";
import { combinedAuth } from "../../middleware/auth";
import { auth, errors, json, makeOpenApiApp } from "../../openapi";
import { sharedConfig as config, sharedDb as db } from "../../shared/effect";
import {
  dependency,
  failJson,
  fireAndLog,
  jsonResponse,
  parseOptionalJsonBody,
  runChannelWorkflow,
} from "../effect-workflows";
import {
  listProjectsForWorkspace,
  loadSlackTeamNameForProject,
} from "../install-store";
import {
  consumePendingSlackAuthMessage,
  replaceSlackAuthPromptConnected,
} from "./auth-resume";
import { spawnAgentTurn } from "./dispatch";
import { isAccountMember, linkSlackIdentity } from "./identity";
import { verifyLoginState } from "./login";
import { effectHandler } from "../../effect/hono";

export const slackIdentityApp = makeOpenApiApp();

slackIdentityApp.openapi(
  createRoute({
    method: "get",
    path: "/login/{token}",
    tags: ["channels"],
    summary: "Redirect a Slack login link to the web login page",
    request: { params: z.object({ token: z.string().min(1) }) },
    responses: {
      200: { description: "HTML redirect to web Slack login page" },
    },
  }),
  effectHandler(async (c: Context) => {
    const token = c.req.param("token") ?? "";
    const base = (config.FRONTEND_URL || "https://kortix.com").replace(
      /\/+$/,
      "",
    );
    const target = `${base}/slack/login/${encodeURIComponent(token)}`;
    return c.html(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="refresh" content="0; url=${target}" />
    <title>Opening Kortix</title>
  </head>
  <body>
    <p>Opening Kortix...</p>
    <script>window.location.replace(${JSON.stringify(target)});</script>
    <p><a href="${target}">Continue to Kortix</a></p>
  </body>
</html>`);
  }),
);

const BindBody = z.object({ token: z.string().min(1) });
type BindBodyInput = { token?: string };
const BindResult = z.object({
  ok: z.boolean(),
  workspaceName: z.string().nullable(),
  // Whether the now-linked user is actually a member of the workspace's account.
  // Connecting is decoupled from access: a non-member links successfully
  // (hasAccess=false) and then requests access in-thread. The runtime gate still
  // blocks any agent run until they're an approved member.
  hasAccess: z.boolean(),
  resumed: z.boolean(),
});

const bindSlackIdentityWorkflow = (c: Context) =>
  Effect.gen(function* () {
    // Whole feature is flag-gated — the bind endpoint is inert when off.
    if (!config.SLACK_REQUIRE_USER_IDENTITY)
      return yield* failJson({ error: "Not found" }, 404);

    const userId = c.get("userId") as string;
    const { token } = yield* parseOptionalJsonBody<BindBodyInput>(c, {});
    if (!token) return yield* failJson({ error: "Missing token" }, 400);

    const payload = verifyLoginState(token);
    if (!payload) {
      return yield* failJson(
        {
          error:
            "This link is invalid or has expired. Run `/kortix login` again.",
        },
        410,
      );
    }

    // The workspace must be connected to at least one Kortix project. Linking is
    // intentionally decoupled from membership so non-members can request access.
    const projectIds = yield* dependency(() =>
      listProjectsForWorkspace("slack", payload.teamId),
    );
    if (projectIds.length === 0) {
      return yield* failJson(
        {
          error: "This Slack workspace is not connected to any Kortix project.",
        },
        403,
      );
    }

    const accountRows = yield* dependency(() =>
      db
        .select({ accountId: projects.accountId })
        .from(projects)
        .where(inArray(projects.projectId, projectIds)),
    );
    const accountIds = Array.from(new Set(accountRows.map((r) => r.accountId)));
    const memberships = yield* dependency(() =>
      Promise.all(
        accountIds.map((accountId) => isAccountMember(userId, accountId)),
      ),
    );
    const hasAccess = memberships.some(Boolean);

    yield* dependency(() =>
      linkSlackIdentity({
        teamId: payload.teamId,
        slackUserId: payload.slackUserId,
        userId,
      }),
    );

    const pending = yield* dependency(() =>
      consumePendingSlackAuthMessage({
        pendingId: payload.pendingId,
        teamId: payload.teamId,
        slackUserId: payload.slackUserId,
      }),
    );
    if (pending) {
      fireAndLog(
        "[slack-auth] failed to update pending Slack auth prompt after bind",
        dependency(() =>
          replaceSlackAuthPromptConnected(pending.slackResponseUrl, {
            hasAccess,
          }),
        ),
      );
      fireAndLog(
        "[slack-auth] failed to resume pending Slack message after bind",
        dependency(() =>
          spawnAgentTurn(pending.projectId, pending.envelope, pending.event),
        ),
      );
    }

    const workspaceName = projectIds.length
      ? yield* dependency(() =>
          loadSlackTeamNameForProject(projectIds[0]).catch(() => null),
        )
      : null;
    return jsonResponse({
      ok: true,
      workspaceName: workspaceName || null,
      hasAccess,
      resumed: !!pending,
    });
  });

slackIdentityApp.openapi(
  createRoute({
    method: "post",
    path: "/bind",
    tags: ["channels"],
    summary: "Bind the calling Kortix user to a Slack user from a /login token",
    ...auth,
    middleware: [combinedAuth] as const,
    request: {
      body: { content: { "application/json": { schema: BindBody } } },
    },
    responses: {
      200: json(BindResult, "Identity linked"),
      ...errors(400, 403, 404, 410),
    },
  }),
  async (c: Context) => {
    return runChannelWorkflow(c, bindSlackIdentityWorkflow(c));
  },
);
