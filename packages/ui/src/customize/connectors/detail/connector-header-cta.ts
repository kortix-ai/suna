import type { AdminConnector } from '@kortix/sdk';

/**
 * The connector header carries ONE action, chosen by the account picture,
 * never by an owner mode:
 *   connect — no account yet;
 *   finish  — accounts exist but none is usable (the fix is per row);
 *   replace — connected with exactly one account: re-authorize THAT one.
 * Two or more working accounts have their own row menus, so the header shows
 * nothing.
 *
 * A computer is different: every member pairs their OWN machine, so it needs
 * no write access and shows until the caller can use a computer here.
 */
export type ConnectorHeaderCta = 'connect' | 'finish' | 'replace' | null;

export function connectorHeaderCta(input: {
  provider: AdminConnector['provider'];
  canWrite: boolean;
  /** A managed provider, or a direct connector with an `authSecret`. */
  hasAuth: boolean;
  connected: boolean;
  accountCount: number;
  hasComputer: boolean;
}): ConnectorHeaderCta {
  if (input.provider === 'computer') return input.hasComputer ? null : 'connect';
  if (!input.canWrite || input.provider === 'channel' || !input.hasAuth) return null;
  if (!input.connected) return input.accountCount === 0 ? 'connect' : 'finish';
  return input.accountCount === 1 ? 'replace' : null;
}
