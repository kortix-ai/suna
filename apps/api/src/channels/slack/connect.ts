/**
 * Slack connect/onboarding + runtime-capability logic, lifted out of the
 * bespoke `/channels/slack/*` route handlers in projects/routes/r4.ts so the
 * connector descriptor (registry/slack.ts) is the single owner of channel
 * behavior. The status codes and error bodies are preserved exactly (400 bad
 * token, 502 unreachable Slack, 404 unbound session/channel) via ChannelError.
 */
import { and, eq } from 'drizzle-orm';
import { projectSessions } from '@kortix/db';
import { db } from '../../shared/db';
import { resolveWorkspaceIdForChannel } from './binding';
import { ChannelError } from '../registry/descriptor';

/** Default (and only) profile slug for the built-in Slack channel — single
 * install per project, unlike email's multi-profile support. */
export const SLACK_DEFAULT_SLUG = 'kortix_slack';

export interface SlackConnectBody {
  bot_token?: string;
  signing_secret?: string;
}

export interface SlackAuthTest {
  ok: boolean;
  team_id?: string;
  team?: string;
  user_id?: string;
  error?: string;
}

export interface PreparedSlackConnect {
  botToken: string;
  signingSecret: string;
  teamId: string;
  teamName: string | null;
  botUserId: string;
}

/**
 * Validate a connect() body (bot_token/signing_secret) and confirm the token
 * against Slack's `auth.test`. Pure of persistence — the descriptor saves the
 * install + reconciles. Throws ChannelError with the exact status the old
 * POST /connect handler returned.
 */
export async function prepareSlackConnect(body: SlackConnectBody): Promise<PreparedSlackConnect> {
  const botToken = body.bot_token?.trim();
  const signingSecret = body.signing_secret?.trim();
  if (!botToken || !botToken.startsWith('xoxb-')) {
    throw new ChannelError(400, { error: 'bot_token is required and must start with xoxb-' });
  }
  if (!signingSecret) {
    throw new ChannelError(400, { error: 'signing_secret is required' });
  }

  let authTest: SlackAuthTest;
  try {
    const res = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${botToken}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
    });
    authTest = (await res.json()) as SlackAuthTest;
  } catch (err) {
    throw new ChannelError(502, { error: `Failed to reach Slack: ${(err as Error).message}` });
  }
  if (!authTest.ok || !authTest.team_id || !authTest.user_id) {
    throw new ChannelError(400, {
      error: `Slack rejected the token: ${authTest.error ?? 'unknown error'}`,
    });
  }

  return {
    botToken,
    signingSecret,
    teamId: authTest.team_id,
    teamName: authTest.team ?? null,
    botUserId: authTest.user_id,
  };
}

export interface SlackBindThreadBody {
  session_id?: string;
  channel?: string;
  thread_ts?: string;
  workspace_id?: string;
}

export interface ResolvedBindThreadTarget {
  sessionId: string;
  channel: string;
  threadTs: string;
  workspaceId: string;
}

/**
 * Validate + resolve a bind-thread request: the session must belong to the
 * project, and the Slack workspace is either given explicitly or resolved
 * from the channel's project binding. Throws ChannelError with the exact
 * status the old POST /bind-thread handler returned.
 */
export async function resolveBindThreadTarget(
  ctx: { projectId: string },
  body: SlackBindThreadBody,
): Promise<ResolvedBindThreadTarget> {
  const sessionId = body.session_id?.trim();
  const channel = body.channel?.trim();
  const threadTs = body.thread_ts?.trim();
  if (!sessionId || !channel || !threadTs) {
    throw new ChannelError(400, { error: 'session_id, channel, and thread_ts are required' });
  }
  // the session must belong to this project
  const [sess] = await db
    .select({ sessionId: projectSessions.sessionId })
    .from(projectSessions)
    .where(
      and(eq(projectSessions.sessionId, sessionId), eq(projectSessions.projectId, ctx.projectId)),
    )
    .limit(1);
  if (!sess) {
    throw new ChannelError(404, { error: 'session not found in project' });
  }
  const workspaceId =
    body.workspace_id?.trim() || (await resolveWorkspaceIdForChannel(ctx.projectId, channel));
  if (!workspaceId) {
    throw new ChannelError(400, {
      error:
        'could not resolve Slack workspace for channel (is the channel bound to this project?)',
    });
  }
  return { sessionId, channel, threadTs, workspaceId };
}
