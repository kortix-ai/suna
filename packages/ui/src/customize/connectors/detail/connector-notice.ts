import type { AdminConnector } from '@kortix/sdk';

import { isAuthChallenge } from '../../sections/connector-connection-form';

/**
 * What is wrong with a connector, and the one thing that fixes it.
 *
 * The page shows this as ONE banner: what failed, why, and a button that does
 * the next step. A status chip alone ("Error") names a state without saying
 * what to do about it.
 *
 *   no_account        — nothing is connected; add an account.
 *   needs_credential  — an account exists and cannot authenticate.
 *   sign_in           — an MCP server asked for sign-in (401/403); the
 *                       account still has to finish its OAuth sign-in.
 *   error             — the last attempt to load the connector's tools failed;
 *                       `reason` is the server's own words, when it sent any.
 */
export type ConnectorNotice =
  | { kind: 'none' }
  | { kind: 'no_account'; action: 'add_account' }
  | { kind: 'needs_credential'; action: 'set_credential' | 'open_accounts' }
  | { kind: 'sign_in' }
  | {
      kind: 'error';
      reason: string | null;
      action: 'add_account' | 'set_credential' | 'open_accounts' | 'retry';
    };

export function connectorNotice(input: {
  provider: AdminConnector['provider'];
  status: AdminConnector['status'];
  lastError?: string | null;
  /** Usable right now: a credential or authorized account backs it. */
  connected: boolean;
  /** The connector needs a credential or an authorization at all. */
  hasAuth: boolean;
  /** A usable credential is stored for the caller. */
  credentialSet: boolean;
  /** Composio or Pipedream: accounts authorize through a hosted window. */
  managed: boolean;
  accountCount: number;
  /** The accounts list has answered; before that nothing is claimed. */
  accountsLoaded: boolean;
}): ConnectorNotice {
  // Channels and computers connect through their own surfaces.
  if (input.provider === 'channel' || input.provider === 'computer') return { kind: 'none' };
  if (!input.accountsLoaded) return { kind: 'none' };

  // An account that exists but cannot authenticate: a direct one takes a
  // credential here, a managed one is reconnected from its row.
  const fixAccount = input.managed ? 'open_accounts' : 'set_credential';

  if (
    input.status === 'error' &&
    input.provider === 'mcp' &&
    !input.credentialSet &&
    isAuthChallenge(input.lastError ?? '') &&
    // With no account yet, an auth scheme is what makes it a sign-in: the
    // button opens Add account ("Only you").
    (input.accountCount > 0 || input.hasAuth)
  )
    return { kind: 'sign_in' };

  if (input.status === 'error') {
    const reason = input.lastError?.trim() || null;
    if (!input.hasAuth || input.credentialSet) return { kind: 'error', reason, action: 'retry' };
    return {
      kind: 'error',
      reason,
      action: input.accountCount === 0 ? 'add_account' : fixAccount,
    };
  }

  if (input.connected) return { kind: 'none' };
  if (input.accountCount === 0) return { kind: 'no_account', action: 'add_account' };
  return { kind: 'needs_credential', action: fixAccount };
}

/**
 * The account the banner's Sign in / Set credential button fixes: one of the
 * caller's OWN accounts (any owner but the project), the first one not signed
 * in, else the only one. With no account of their own it is `'add'`: the
 * button opens "Add account" with "Only you" preselected, so a personal
 * sign-in never lands on the project's shared account. A shared account is
 * still signed in from its own row.
 */
export function noticeTarget<
  T extends { owner_type: string; status: string; authorized?: boolean },
>(accounts: readonly T[]): T | 'add' | null {
  const own = accounts.filter((account) => account.owner_type !== 'project');
  if (own.length === 0) return 'add';
  return (
    own.find((account) => account.authorized === false || account.status !== 'active') ??
    (own.length === 1 ? own[0]! : null)
  );
}

/**
 * The banner's fix button: what it says and what it runs. `add` opens
 * "Add account"; `sign_in` finishes `account`'s sign-in; `reconnect` opens
 * `account`'s credential entry, or its provider window when managed. `null`
 * means no fix button (Retry, when the notice offers it, is separate).
 */
export function noticeButton<T>(
  notice: ConnectorNotice,
  target: T | 'add' | null,
  managed: boolean,
): {
  /** Which button: its words. `add_account` is the page's Add account control. */
  kind: 'add_account' | 'sign_in' | 'set_credential' | 'connect' | 'reconnect';
  run: 'add' | 'sign_in' | 'reconnect';
  account: T | null;
} | null {
  if (notice.kind === 'none') return null;
  if (notice.kind === 'sign_in') {
    if (target === 'add') return { kind: 'sign_in', run: 'add', account: null };
    return target ? { kind: 'sign_in', run: 'sign_in', account: target } : null;
  }
  if (notice.action === 'add_account') return { kind: 'add_account', run: 'add', account: null };
  if (notice.action === 'retry' || !target) return null;
  if (target === 'add') {
    return { kind: managed ? 'connect' : 'set_credential', run: 'add', account: null };
  }
  return { kind: managed ? 'reconnect' : 'set_credential', run: 'reconnect', account: target };
}

/** A failure line split for the log row: `MCP tools/list failed: HTTP 401` → `401` + `MCP tools/list failed`. */
export function splitNoticeReason(reason: string): { code: string | null; detail: string } {
  const match = /[:\s]*\bHTTP (\d{3})\b/.exec(reason);
  if (!match) return { code: null, detail: reason };
  return { code: match[1]!, detail: reason.replace(match[0], '').trim() };
}
