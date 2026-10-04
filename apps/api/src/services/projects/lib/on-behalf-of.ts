/**
 * `on_behalf_of` — the human an agent session acts for.
 *
 * Stored on the session token (`kortix.account_tokens.on_behalf_of_user_id`).
 * It decides ONLY that human's personal resources (member-owned connector
 * connections, personal secrets, personal provider keys, own computer), and
 * only in that human's private session. It never widens the agent's shared
 * authority, which is the agent's own (services/iam/agent-principal.ts).
 *
 *   - Mint: the launching human for a human-initiated session; NULL for every
 *     unattended run (trigger, cron, webhook, email/Telegram, a Slack/Teams
 *     message without a linked user, a backend service account). A child
 *     session inherits its parent session's value, never the token user.
 *   - Turn: every turn a member starts binds the session token to that member
 *     (`bindSessionTurnIdentity`): `user_id` and `on_behalf_of` both become the
 *     prompter, so a person never acts through another person's authority or
 *     accounts (closes V6). A turn from a non-person (trigger, channel sender,
 *     service account) clears `on_behalf_of` and keeps `user_id`.
 *
 * Readers: `getRequestOnBehalfOf(c)` (fresh, per request, from the auth
 * middleware) or the token row itself. No memo carries it: it changes per turn.
 */
import { and, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { accountMemberships, accountTokens, projectSessions } from '@kortix/db';
import { config } from '../../../lib/config';
import { db } from '../../../lib/db';

/** Session metadata key stamped when a prompt cleared `on_behalf_of`. A
 *  re-mint of the session credential reads it and never restores the value. */
export const ON_BEHALF_OF_CLEARED_KEY = 'on_behalf_of_cleared_at';

const UNATTENDED_ORIGINS: ReadonlySet<string> = new Set(['trigger', 'schedule', 'system']);

export interface OnBehalfOfInput {
  /** The session's authorization user (the launcher, or the owner stand-in). */
  userId: string;
  /** `project_sessions.origin`. */
  origin: string | null;
  /** `project_sessions.metadata`. */
  metadata: Record<string, unknown> | null;
  /** Is `userId` a member of the session's account (i.e. a human)? */
  isAccountMember: boolean;
  /** For a child session: the parent's live token value. `undefined` = the
   *  parent token was not found (fail closed). Ignored for a root session. */
  parentOnBehalfOf?: string | null;
  slackRequiresUserIdentity: boolean;
  teamsRequiresUserIdentity: boolean;
}

/** Pure mint rule. Returns the human id, or null for an unattended run. */
export function decideSessionOnBehalfOf(input: OnBehalfOfInput): string | null {
  const meta = input.metadata ?? {};
  if (typeof meta[ON_BEHALF_OF_CLEARED_KEY] === 'string') return null;
  if (input.origin && UNATTENDED_ORIGINS.has(input.origin)) return null;
  if (meta.trigger_kind != null || meta.trigger_slug != null || meta.trigger_source != null) return null;
  const source = typeof meta.source === 'string' ? meta.source : '';
  // Email and Telegram sessions run as the account-owner stand-in: the sender
  // is not a Kortix identity.
  if (source === 'email' || source === 'telegram') return null;
  if (source === 'slack' && !input.slackRequiresUserIdentity) return null;
  if (source === 'teams' && !input.teamsRequiresUserIdentity) return null;
  if (typeof meta.spawned_by_session === 'string' && meta.spawned_by_session) {
    return input.parentOnBehalfOf ?? null;
  }
  return input.isAccountMember ? input.userId : null;
}

/**
 * Pure rule for a prompt that did NOT come through the HTTP prompt route: a
 * trigger fire or a channel message. Returns the prompter to compare against
 * `on_behalf_of` — a human id, or `null` for a non-human prompter, which clears
 * any value — or `undefined` when this source never changes it (the HTTP
 * sources, which mark their human prompts `bindTurnIdentity`, and platform
 * notifications such as `system:connector-connected`, which the session's own
 * human caused).
 *
 * The channel identities mirror the mint rule above: email and Telegram
 * senders are never Kortix identities, and a Slack/Teams message carries its
 * sender's Kortix user only when the deployment requires a linked identity.
 */
export function channelPrompterForOnBehalfOf(input: {
  source: string;
  userId: string | null;
  slackRequiresUserIdentity: boolean;
  teamsRequiresUserIdentity: boolean;
}): string | null | undefined {
  if (typeof input.source !== 'string') return undefined;
  // A reminder the session's own agent set is that session's background work:
  // its fire leaves the identity as is. A reminder a person set is marked
  // `bindTurnIdentity` at fire time instead (trigger-fire.ts) and never gets here.
  if (input.source === 'trigger:reminder') return undefined;
  if (input.source.startsWith('trigger:')) return null;
  if (input.source === 'email' || input.source === 'telegram') return null;
  if (input.source === 'slack') return input.slackRequiresUserIdentity ? input.userId : null;
  if (input.source === 'teams') return input.teamsRequiresUserIdentity ? input.userId : null;
  return undefined;
}

/**
 * Mint-time resolution for session `sessionId`. Reads the session row, the
 * launcher's account membership, and — for a child — the parent's live
 * token. Any read failure resolves to NULL: a missing value costs personal
 * resources only, never shared authority.
 */
export async function resolveSessionOnBehalfOf(input: {
  accountId: string;
  sessionId: string;
  userId: string;
}): Promise<string | null> {
  try {
    const [session] = await db
      .select({ origin: projectSessions.origin, metadata: projectSessions.metadata })
      .from(projectSessions)
      .where(and(eq(projectSessions.sessionId, input.sessionId), eq(projectSessions.accountId, input.accountId)))
      .limit(1);
    if (!session) return null;
    const metadata = (session.metadata ?? {}) as Record<string, unknown>;
    const parentId = typeof metadata.spawned_by_session === 'string' ? metadata.spawned_by_session : null;
    const [membership, parent] = await Promise.all([
      db
        .select({ userId: accountMemberships.userId })
        .from(accountMemberships)
        .where(and(eq(accountMemberships.userId, input.userId), eq(accountMemberships.accountId, input.accountId)))
        .limit(1),
      parentId
        ? db
            .select({ onBehalfOfUserId: accountTokens.onBehalfOfUserId })
            .from(accountTokens)
            .where(
              and(
                eq(accountTokens.sessionId, parentId),
                eq(accountTokens.accountId, input.accountId),
                eq(accountTokens.status, 'active'),
                isNull(accountTokens.revokedAt),
              ),
            )
            .limit(1)
        : Promise.resolve([]),
    ]);
    return decideSessionOnBehalfOf({
      userId: input.userId,
      origin: session.origin,
      metadata,
      isAccountMember: membership.length > 0,
      parentOnBehalfOf: parentId ? (parent[0] ? (parent[0].onBehalfOfUserId ?? null) : undefined) : undefined,
      slackRequiresUserIdentity: config.SLACK_REQUIRE_USER_IDENTITY !== false,
      teamsRequiresUserIdentity: config.TEAMS_REQUIRE_USER_IDENTITY !== false,
    });
  } catch (err) {
    console.warn('[on-behalf-of] mint resolution failed; minting without a human', {
      sessionId: input.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Someone other than the session's `on_behalf_of` human prompted session
 * `sessionId`. When the session's token acts on behalf of a DIFFERENT human —
 * or of any human, when `prompterUserId` is null (a trigger or an unlinked
 * channel sender) — clear it on every live token of the session and stamp the
 * session so a re-mint never restores it. Returns true when it cleared a
 * value. Idempotent.
 */
export async function clearSessionOnBehalfOfForPrompt(input: {
  accountId: string;
  sessionId: string;
  prompterUserId: string | null;
}): Promise<boolean> {
  const cleared = await db
    .update(accountTokens)
    .set({ onBehalfOfUserId: null })
    .where(
      and(
        eq(accountTokens.sessionId, input.sessionId),
        eq(accountTokens.accountId, input.accountId),
        isNotNull(accountTokens.onBehalfOfUserId),
        input.prompterUserId === null
          ? undefined
          : ne(accountTokens.onBehalfOfUserId, input.prompterUserId),
      ),
    )
    .returning({ tokenId: accountTokens.tokenId });
  if (cleared.length === 0) return false;
  await db
    .update(projectSessions)
    .set({
      metadata: sql`coalesce(${projectSessions.metadata}, '{}'::jsonb) || jsonb_build_object(${ON_BEHALF_OF_CLEARED_KEY}::text, now()::text)`,
    })
    .where(eq(projectSessions.sessionId, input.sessionId));
  return true;
}

/**
 * `prompterUserId` started a turn in session `sessionId`. From this turn on,
 * the session token acts as them:
 *
 *   - a member of the account: `user_id` (authorization, LLM usage and member
 *     budgets, audit) and `on_behalf_of` (personal resources) both become the
 *     prompter, and the cleared stamp is removed so a re-mint follows them;
 *   - anyone else (a service account, an API-key caller): `on_behalf_of` is
 *     cleared and stamped, `user_id` is kept — the same result as
 *     `clearSessionOnBehalfOfForPrompt`.
 *
 * One statement: the token UPDATE and the session stamp run in one
 * data-modifying CTE, so they land together and the prompt waits for one
 * round trip, not two. It writes nothing when the token already acts as the
 * prompter, which is every turn but the first after a change of hands.
 * Returns true when it changed a token.
 */
export async function bindSessionTurnIdentity(input: {
  accountId: string;
  sessionId: string;
  prompterUserId: string;
}): Promise<boolean> {
  const prompter = sql`${input.prompterUserId}::uuid`;
  const member = sql`exists (select 1 from kortix.account_memberships m where m.user_id = ${prompter} and m.account_id = ${input.accountId})`;
  const changed = await db.execute<{ token_id: string }>(sql`
    with changed as (
      update kortix.account_tokens t
         set user_id = case when ${member} then ${prompter} else t.user_id end,
             on_behalf_of_user_id = case when ${member} then ${prompter} else null end
       where t.session_id = ${input.sessionId}
         and t.account_id = ${input.accountId}
         and t.status = 'active'
         and t.revoked_at is null
         and case when ${member}
               then (t.user_id is distinct from ${prompter} or t.on_behalf_of_user_id is distinct from ${prompter})
               else t.on_behalf_of_user_id is not null end
      returning t.token_id
    ), stamped as (
      update kortix.project_sessions s
         set metadata = case when ${member}
               then coalesce(s.metadata, '{}'::jsonb) - ${ON_BEHALF_OF_CLEARED_KEY}::text
               else coalesce(s.metadata, '{}'::jsonb) || jsonb_build_object(${ON_BEHALF_OF_CLEARED_KEY}::text, now()::text) end
       where s.session_id = ${input.sessionId}
         and exists (select 1 from changed)
    )
    select token_id from changed
  `);
  return changed.length > 0;
}
