/**
 * Every credential the API accepts, as an Artifact live socket holds it
 * (KRTX-3669). A socket outlives the request that minted its ticket, so it
 * must end when that credential ends: at its expiry (closed with 4401 by the
 * sweep, no database read) and when it is revoked (closed with 4401 at the
 * 60 s re-check). REST refuses the same credential on its next request.
 *
 * | authType          | kind              | expiry                               | revocation, re-read every 60 s                  |
 * |-------------------|-------------------|--------------------------------------|-------------------------------------------------|
 * | `supabase`        | `browser_session` | the access token's `exp` (at mint)   | the `auth.sessions` row: sign-out, ban, deletion |
 * | `oauth`           | `oauth`           | `oauth_access_tokens.expires_at`     | `revoked_at`, the OAuth client's `active`       |
 * | `pat` (a person)  | `pat`             | `account_tokens.expires_at`          | status, `revoked_at`, idle revoke               |
 * | `pat` (a session) | `agent_session`   | `account_tokens.expires_at`          | as `pat`, plus the session's sandbox lease      |
 * | `service_account` | `service_account` | `service_accounts.expires_at`        | `service_accounts.status`                       |
 * | `apiKey`          | none              | -                                    | refused: no ticket for a sandbox or legacy key  |
 *
 * Every socket also re-authenticates through REST at least once an hour
 * (`CREDENTIAL_MAX_MS` in `live-hub.ts`). `LIVE_AUTH_TYPES` is typed over every
 * `authType` (`types.ts`): a new one does not compile until it is mapped here,
 * and `live-credential.test.ts` walks the whole table.
 */
import type { Credential } from '../iam/actor';
import { readOAuthAccessTokenState } from '../oauth/access-token';
import { validateAccountTokenById } from '../repositories/account-tokens';
import { readServiceAccountState } from '../repositories/service-accounts';
import { authSessionLive } from '../shared/jwt-liveness';
import type { AuthVariables } from '../types';

export const LIVE_CREDENTIAL_KINDS = ['browser_session', 'oauth', 'pat', 'agent_session', 'service_account'] as const;
export type LiveCredentialKind = (typeof LIVE_CREDENTIAL_KINDS)[number];

/** The credential a ticket names: its kind and the row the re-check reads (null: none known). */
export interface LiveCredentialRef {
  kind: LiveCredentialKind;
  id: string | null;
}

type AuthType = NonNullable<AuthVariables['authType']>;

/** Every authType, and the kinds it may be. Null: it never opens a live socket. */
export const LIVE_AUTH_TYPES: Record<AuthType, readonly LiveCredentialKind[] | null> = {
  supabase: ['browser_session'],
  oauth: ['oauth'],
  pat: ['pat', 'agent_session'],
  service_account: ['service_account'],
  apiKey: null,
};

/** The kind of the credential that authenticated a request, or null when it may not open a socket. */
export function liveCredentialKind(authType: AuthType | undefined, credential: Credential['kind']): LiveCredentialKind | null {
  if (!authType) return null;
  const kinds = LIVE_AUTH_TYPES[authType];
  if (!kinds) return null;
  if (authType === 'pat') return credential === 'agent_session' ? 'agent_session' : credential === 'pat' ? 'pat' : null;
  return kinds[0] ?? null;
}

/** `live`: not revoked and not expired now. `expiresAt`: epoch ms, or null when the row has no expiry. */
export interface LiveCredentialState {
  live: boolean;
  expiresAt: number | null;
}

interface Who {
  userId: string;
  accountId: string;
}

const dead: LiveCredentialState = { live: false, expiresAt: null };

/** PATs and agent-session tokens: the same validation as a request with the token. A failed read throws. */
async function accountToken(id: string | null): Promise<LiveCredentialState> {
  if (!id) return dead;
  const result = await validateAccountTokenById(id);
  if (!result.isValid) {
    if (result.credentialDead) return dead;
    throw new Error(result.error ?? 'Token validation is unavailable');
  }
  return { live: true, expiresAt: result.expiresAt ? result.expiresAt.getTime() : null };
}

export const LIVE_CREDENTIALS: Record<LiveCredentialKind, {
  expiry: string;
  revocation: string;
  inspect(id: string | null, who: Who): Promise<LiveCredentialState>;
}> = {
  browser_session: {
    expiry: "the access token's `exp` claim, read when the ticket is minted",
    revocation: 'the `auth.sessions` row of `session_id` (`authSessionLive`): sign-out deletes it; a ban or a deletion ends it',
    // A token from before session ids has no row to read: its `exp` and the hourly cap bound it.
    inspect: async (id, who) => ({ live: id ? await authSessionLive(who.userId, id) : true, expiresAt: null }),
  },
  oauth: {
    expiry: '`oauth_access_tokens.expires_at`',
    revocation: "`oauth_access_tokens.revoked_at` and the OAuth client's `active` flag",
    inspect: async (id) => {
      const row = id ? await readOAuthAccessTokenState(id) : null;
      if (!row) return dead;
      const expiresAt = row.expiresAt.getTime();
      return { live: !row.revokedAt && row.clientActive && expiresAt > Date.now(), expiresAt };
    },
  },
  pat: {
    expiry: '`account_tokens.expires_at`',
    revocation: '`validateAccountTokenById`: status, `revoked_at`, expiry and idle revoke',
    inspect: (id) => accountToken(id),
  },
  agent_session: {
    expiry: '`account_tokens.expires_at`',
    revocation: "`validateAccountTokenById`: as a PAT, plus the session's sandbox lease",
    inspect: (id) => accountToken(id),
  },
  service_account: {
    expiry: '`service_accounts.expires_at`',
    revocation: '`service_accounts.status` (a disabled or deleted service account)',
    inspect: async (id, who) => {
      const row = id ? await readServiceAccountState(who.accountId, id) : null;
      if (!row) return dead;
      const expiresAt = row.expiresAt ? row.expiresAt.getTime() : null;
      return { live: row.status === 'active' && (expiresAt === null || expiresAt > Date.now()), expiresAt };
    },
  },
};

/** Is the credential still live, and when does it expire? Throws when the read fails: the caller keeps the socket and retries. */
export function inspectLiveCredential(ref: LiveCredentialRef, who: Who): Promise<LiveCredentialState> {
  return LIVE_CREDENTIALS[ref.kind].inspect(ref.id, who);
}
