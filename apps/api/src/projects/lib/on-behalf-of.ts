/**
 * `on_behalf_of` — the human an agent session acts for (spec
 * docs/specs/2026-09-22-agents-as-principals.md §2.3).
 *
 * Stored on the session token (`kortix.account_tokens.on_behalf_of_user_id`).
 * It decides ONLY that human's personal resources (member-owned connector
 * connections, personal secrets, personal provider keys, own computer), and
 * only in that human's private session. It never widens the agent's shared
 * authority, which is the agent's own (iam/agent-principal.ts).
 *
 *   - Mint: the launching human for a human-initiated session; NULL for every
 *     unattended run (trigger, cron, webhook, email/Telegram, a Slack/Teams
 *     message without a linked user, a backend service account). A child
 *     session inherits its parent session's value, never the token user.
 *   - Prompt: the first prompt from a human other than `on_behalf_of` clears it
 *     permanently for the session (closes V6: a person prompting a private
 *     session never acts through another person's accounts).
 *
 * Readers: `getRequestOnBehalfOf(c)` (fresh, per request, from the auth
 * middleware) or `credentialOnBehalfOf(actor)` (iam/actor.ts, 15 s memo).
 */
import type { Context } from 'hono';
import { and, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { accountMemberships, accountTokens, projectSessions } from '@kortix/db';
import { config } from '../../config';
import { loadTokenBinding } from '../../iam/actor';
import { db } from '../../shared/db';

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

/** Pure prompt rule: does this prompt clear `on_behalf_of`? */
export function promptClearsOnBehalfOf(input: {
  onBehalfOfUserId: string | null;
  prompterUserId: string;
  prompterIsHuman: boolean;
}): boolean {
  return input.prompterIsHuman && input.onBehalfOfUserId !== null && input.onBehalfOfUserId !== input.prompterUserId;
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
 * A human prompted session `sessionId`. When the session's token acts on
 * behalf of a DIFFERENT human, clear it on every live token of the session and
 * stamp the session so a re-mint never restores it. Returns true when it
 * cleared a value. Idempotent.
 */
export async function clearSessionOnBehalfOfForPrompt(input: {
  accountId: string;
  sessionId: string;
  prompterUserId: string;
}): Promise<boolean> {
  const cleared = await db
    .update(accountTokens)
    .set({ onBehalfOfUserId: null })
    .where(
      and(
        eq(accountTokens.sessionId, input.sessionId),
        eq(accountTokens.accountId, input.accountId),
        isNotNull(accountTokens.onBehalfOfUserId),
        ne(accountTokens.onBehalfOfUserId, input.prompterUserId),
      ),
    )
    .returning({ tokenId: accountTokens.tokenId });
  if (cleared.length === 0) return false;
  // The IAM token-binding memo carries the value for 15 s; drop it here so
  // this replica's next request already sees NULL.
  for (const row of cleared) loadTokenBinding.invalidate(row.tokenId);
  await db
    .update(projectSessions)
    .set({
      metadata: sql`coalesce(${projectSessions.metadata}, '{}'::jsonb) || jsonb_build_object(${ON_BEHALF_OF_CLEARED_KEY}::text, now()::text)`,
    })
    .where(eq(projectSessions.sessionId, input.sessionId));
  return true;
}

/** Fresh per-request value set by the auth middleware; null for non-session tokens. */
export function getRequestOnBehalfOf(c: Context): string | null {
  return (c.get('onBehalfOfUserId') as string | null | undefined) ?? null;
}
