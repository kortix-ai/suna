/**
 * `claude_subscription` credential resolution — docs/specs/2026-07-22-
 * unified-auth-gateway.md §5.2. Mirrors `codex.ts`'s shape (shared/personal
 * row precedence identical to `loadCodexRow`), but Tier A only: NO refresh
 * call. Unverified whether a `claude setup-token`-minted token has any
 * refresh mechanism at all (public reporting suggests a long-lived ~1-year
 * bearer, not confirmed against Anthropic's own docs) — this module's job
 * is expiry TRACKING (when an expiry is known) plus an optional live probe,
 * never token rotation. If/when a real Anthropic OAuth refresh token format
 * is adopted (gated behind the still-undecided §11#1 one-click flow), a
 * `refreshClaudeCredential` sibling can be added the same way
 * `codex.ts:refreshAndPersist`/`refreshSingleFlight` were — not built here
 * because there is nothing to refresh yet.
 */
import { and, eq, isNull, or } from 'drizzle-orm';
import { projectSecrets } from '@kortix/db';
import { db } from '../../shared/db';
import { decryptProjectSecret } from '../../projects/secrets';

export const CLAUDE_CODE_OAUTH_TOKEN_SECRET_NAME = 'CLAUDE_CODE_OAUTH_TOKEN';

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

interface SecretRow {
  secretId: string;
  ownerUserId: string | null;
  valueEnc: string;
}

/** Identical query SHAPE to `codex.ts`'s `loadCodexRow` — copied, not
 *  imported, because it is keyed to a different secret name and this
 *  module intentionally stays a standalone sibling (no cross-import between
 *  credential modules, matching the existing `codex.ts`/`codex-core.ts`
 *  split's own precedent of not sharing DB-query helpers across provider
 *  boundaries). */
async function loadClaudeRow(
  projectId: string,
  userId: string,
): Promise<{ row: SecretRow; scope: 'shared' | 'personal' } | null> {
  const rows = await db
    .select({
      secretId: projectSecrets.secretId,
      ownerUserId: projectSecrets.ownerUserId,
      valueEnc: projectSecrets.valueEnc,
    })
    .from(projectSecrets)
    .where(and(
      eq(projectSecrets.projectId, projectId),
      eq(projectSecrets.name, CLAUDE_CODE_OAUTH_TOKEN_SECRET_NAME),
      or(isNull(projectSecrets.ownerUserId), eq(projectSecrets.ownerUserId, userId)),
    ));
  if (!rows.length) return null;
  const personal = rows.find((r) => r.ownerUserId === userId);
  if (personal) return { row: personal, scope: 'personal' };
  const shared = rows.find((r) => r.ownerUserId === null);
  return shared ? { row: shared, scope: 'shared' } : null;
}

export interface StoredClaudeAuth {
  token: string;
  /** `null` when the stored value carries no known expiry — true for every
   *  `claude setup-token` paste today (a bare string, no envelope). */
  expiresAt: number | null;
}

/**
 * Parses the stored secret value. Two shapes, tolerated per spec §5.2:
 *   - the plain token string `claude-subscription-form.tsx` writes today
 *     (verified 2026-07-22: `upsertProjectSecret({ value: trimmedToken })`,
 *     no envelope) — no expiry to know.
 *   - a `{ token, expires }` (or `{ token, expiresAt }`) JSON envelope a
 *     FUTURE gated browser-OAuth flow (§7, §11#1) could write — decoded if
 *     present, never required.
 * Never throws — a malformed/empty value degrades to an empty token, which
 * the caller treats as "no usable credential," never a crash.
 */
export function parseClaudeAuth(raw: string): StoredClaudeAuth {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { token?: unknown; expires?: unknown; expiresAt?: unknown };
      if (typeof parsed.token === 'string' && parsed.token.trim()) {
        const expires =
          typeof parsed.expires === 'number'
            ? parsed.expires
            : typeof parsed.expiresAt === 'number'
              ? parsed.expiresAt
              : null;
        return { token: parsed.token, expiresAt: expires };
      }
    } catch {
      // Not a JSON envelope — fall through to the plain-string case below.
    }
  }
  return { token: trimmed, expiresAt: null };
}

export interface ClaudeCredential {
  token: string;
  expiresAt: number | null;
  scope: 'shared' | 'personal';
}

/**
 * Resolves the project's `CLAUDE_CODE_OAUTH_TOKEN` — personal override wins
 * over the shared row when both exist, same precedence `codex.ts` uses.
 * `null` when nothing is stored. Never refreshes (Tier A, see module doc).
 */
export async function resolveClaudeCredential(
  projectId: string,
  userId: string,
): Promise<ClaudeCredential | null> {
  const found = await loadClaudeRow(projectId, userId);
  if (!found) return null;
  const stored = parseClaudeAuth(decryptProjectSecret(projectId, found.row.valueEnc));
  if (!stored.token) return null;
  return { token: stored.token, expiresAt: stored.expiresAt, scope: found.scope };
}

/**
 * Cheap live "test connection" probe — spec §5.2 item 3 / the parity doc's
 * Tier A item 3: the one thing that can flip `unverified` -> `healthy`/
 * `invalid` for a token with no known expiry (the common case today). Uses
 * Anthropic's models-list endpoint (no completion spend) with the token as
 * an OAuth bearer, matching how Claude Code itself presents a `setup-token`-
 * minted credential to Anthropic's API.
 *
 * ── Flagged, not fully live-verified ──
 * The exact header shape an Anthropic OAuth bearer token expects (`Bearer`
 * vs `x-api-key`, whether `anthropic-beta: oauth-...` is required) is
 * inferred from public documentation/behavior, not confirmed against a real
 * token in this pass (no live Claude subscription credential was available
 * to test against, and the brief's live-verification budget was spent on
 * the device-code poller + the Codex regression suite instead). Any
 * ambiguous/unexpected response (network error, non-2xx/401/403 status,
 * malformed body) degrades to `'unverified'`, NEVER `'invalid'` — this
 * probe must never falsely accuse a working credential of being broken.
 * Before Step 5 surfaces `'invalid'` to a user as "reconnect your Claude
 * subscription," verify this header shape against a real token.
 */
export async function probeClaudeConnection(
  token: string,
  fetchImpl: FetchImpl = (input, init) => fetch(input, init),
): Promise<'healthy' | 'invalid' | 'unverified'> {
  const trimmed = token.trim();
  if (!trimmed) return 'invalid';
  try {
    const response = await fetchImpl('https://api.anthropic.com/v1/models?limit=1', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${trimmed}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
      },
    });
    if (response.ok) return 'healthy';
    if (response.status === 401 || response.status === 403) return 'invalid';
    return 'unverified';
  } catch {
    return 'unverified';
  }
}
