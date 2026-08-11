import type { WorkspaceSecret } from '@kortix/sdk';

/**
 * Which of a workspace's secret rows a session allowlist may actually name.
 *
 * `GET /workspaces/{id}/secrets` lists rows of EVERY scope, but session create
 * validates `secrets:` against runtime-scoped rows only. Allowlisting anything
 * else fails the create with 404 SECRET_IDENTIFIER_NOT_FOUND — pointing at a
 * row the user can see listed right there, which reads like a platform bug
 * rather than a scope rule. Filtering here is what keeps that error
 * unreachable from this app.
 *
 * The scope column is NOT serialized onto the listed row (see `SecretSchema`
 * in `packages/api-contract`), so the only signal a client has is the env KEY.
 * These are the exact keys the platform writes with `scope: 'connector'` when a
 * chat channel is installed (`apps/api/src/channels/install-store.ts`) — an
 * exact-name table rather than a `SLACK_*`-style prefix, so a hand-created
 * secret that merely starts the same way is still treated as the ordinary
 * runtime secret it is.
 */

/** Written by a channel install, one row per key, always `scope: 'connector'`. */
const CHANNEL_INSTALL_KEYS = [
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
  'SLACK_TEAM_ID',
  'SLACK_BOT_USER_ID',
  'SLACK_TEAM_NAME',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_WEBHOOK_SECRET',
  'MS_TEAMS_TENANT_ID',
  'MS_TEAMS_SERVICE_URL',
  'MS_TEAMS_TEAM_ID',
  'MS_TEAMS_TEAM_NAME',
  'MS_TEAMS_BOT_ID',
  'MS_TEAMS_APP_ID',
  'MS_TEAMS_APP_PASSWORD',
  'MS_TEAMS_ORG_INSTALLED',
  'MS_TEAMS_CATALOG_APP_ID',
];

/**
 * Same, except the install appends `_<CONNECTION>` when the inbox is not the
 * default one — so these match with an optional underscore-separated suffix.
 */
const CHANNEL_INSTALL_KEY_PREFIXES = [
  'AGENTMAIL_API_KEY',
  'AGENTMAIL_INBOX_ID',
  'AGENTMAIL_INBOX_EMAIL',
  'AGENTMAIL_INBOX_DISPLAY_NAME',
  'AGENTMAIL_WEBHOOK_ID',
  'AGENTMAIL_WEBHOOK_SECRET',
  'AGENTMAIL_SENDER_POLICY',
];

export type SecretScope =
  /** An ordinary env var injected into the sandbox. The only allowlistable one. */
  | 'runtime'
  /** Credentials for an installed chat channel, resolved server-side. */
  | 'channel_install'
  /** Reserved `KORTIX_*` row the platform manages. */
  | 'platform';

export function secretScope(secret: Pick<WorkspaceSecret, 'name' | 'system'>): SecretScope {
  const key = secret.name.toUpperCase();
  if (secret.system || key.startsWith('KORTIX_')) return 'platform';
  if (CHANNEL_INSTALL_KEYS.includes(key)) return 'channel_install';
  if (
    CHANNEL_INSTALL_KEY_PREFIXES.some(
      (base) => key === base || key.startsWith(`${base}_`),
    )
  ) {
    return 'channel_install';
  }
  return 'runtime';
}

/** May this row be named in a session's `secrets:` allowlist? */
export function isAllowlistable(secret: Pick<WorkspaceSecret, 'name' | 'system'>): boolean {
  return secretScope(secret) === 'runtime';
}

/** The rows a new-session allowlist may offer, in list order. */
export function selectAllowlistableSecrets<T extends Pick<WorkspaceSecret, 'name' | 'system'>>(
  items: T[] | undefined,
): T[] {
  return (items ?? []).filter(isAllowlistable);
}

/** Why a row is withheld from the allowlist, for the marker next to it. */
export function scopeExplanation(scope: SecretScope): string | null {
  if (scope === 'channel_install') {
    return 'Written by a channel install and resolved server-side — it is never injected into a sandbox, so a session allowlist cannot name it.';
  }
  if (scope === 'platform') {
    return 'Managed by Kortix. It is not a workspace secret you can grant, rotate, or remove.';
  }
  return null;
}
