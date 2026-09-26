/**
 * What "log in" means for the TUI, with no pixels attached.
 *
 *   URL + token → validate against that host → identity → CLI host record
 *
 * Every step is a plain function with injectable dependencies, so the whole
 * flow is testable without a terminal, without a network, and without writing
 * to a real `~/.config/kortix/config.json`.
 *
 * THE TOKEN NEVER LEAVES THIS FILE IN A STRING ANYONE RENDERS. Every message
 * this module produces passes through `redactSecret`, and no code path logs,
 * throws, or returns the token. The only place it is written is the CLI config
 * file the CLI itself already stores it in (mode 0600).
 *
 * WHY A SCOPED CLIENT: validating a candidate token means talking to a host
 * that is NOT this process's current host. `createKortix` writes the SDK's
 * process-global platform config, so building a second client to check a
 * pasted token would silently re-point every in-flight call of the running app
 * at the candidate host. `createScopedKortix` (`@kortix/sdk/server`) binds its
 * config to an `AsyncLocalStorage` scope per call instead and never touches the
 * global — the same reason `apps/cli/src/api/sdk.ts` scopes every one of its
 * multi-host reads.
 */

import {
  type Host,
  getHost,
  removeHost,
  upsertHost,
  useHost,
  validateHostName,
} from '@kortix/cli/src/api/config.ts';
import { sdkBackendUrl } from '@kortix/cli/src/api/sdk.ts';
import type { ValidateTokenResult } from '@kortix/sdk';
import { createScopedKortix } from '@kortix/sdk/server';

import { type ResolvedHost, resolvedFromHost } from '../../auth/hosts.ts';

/** Why a login did not happen. `status` is 0 when no HTTP response arrived. */
export interface LoginFailure {
  kind: 'name' | 'url' | 'token' | 'rejected' | 'http' | 'network';
  /** HTTP status, or 0 for a client-side or transport failure. */
  status: number;
  /** One line, safe to render. Never contains the token. */
  message: string;
}

export type LoginResult = { ok: true; resolved: ResolvedHost } | { ok: false; error: LoginFailure };

export interface LoginInput {
  /** Config key, e.g. `local-dev`. Validated by the CLI's own rule. */
  name: string;
  /** What the user typed. A missing scheme is filled in (see `normalizeBackendUrl`). */
  url: string;
  /** PAT, API key, or Supabase JWT. Sent as the bearer, verbatim. */
  token: string;
  /** Prefer this account when the token can see several. */
  preferredAccountId?: string;
  /** Make this host the active one. Default true. */
  makeActive?: boolean;
}

/** The seams a test (or the dev harness) replaces. */
export interface LoginFlowDeps {
  /** `GET /accounts/me` against `backendUrl` with `token`. Must not throw. */
  validate(input: { backendUrl: string; token: string }): Promise<ValidateTokenResult>;
  /** Persist the host record. `makeActive` also points the config at it. */
  save(name: string, host: Host, makeActive: boolean): void;
  /** Read a stored host record back, for `hostToResolved`. */
  read(name: string): Host | null;
  /** Remove a stored host. */
  remove(name: string): { removed: boolean; switchedTo?: string };
  now(): Date;
}

/**
 * Replace every occurrence of `secret` in `text`.
 *
 * Defence in depth, not decoration: an `ApiError` message can carry the request
 * URL, and a host whose token arrives in a query string would put it there. The
 * cost is one `split`; the alternative is a credential on screen.
 */
export function redactSecret(text: string, secret: string): string {
  if (!secret || secret.length < 4) return text;
  return text.split(secret).join('«token»');
}

/**
 * The absolute `<origin>/v1` base the SDK needs, or null when `raw` is not a
 * URL at all.
 *
 * A schemeless entry (`localhost:17408`, `api.kortix.com`) is completed with
 * `http://` and then handed to `sdkBackendUrl`, whose `secureRemoteBase` step
 * upgrades any PUBLIC host to https and leaves loopback / private / self-host
 * names on http. That is the CLI's rule, reused rather than re-derived — a
 * second copy of "when is http legitimate" is a second copy to get wrong.
 */
export function normalizeBackendUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (!url.hostname) return null;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return sdkBackendUrl(withScheme);
}

/** The bare origin the CLI stores in `Host.url` (no `/v1` mount). */
export function hostBaseFromBackendUrl(backendUrl: string): string {
  return backendUrl.replace(/\/v1$/, '');
}

/** Message for a failed `validateToken`, with the status the API answered. */
function failureFromValidate(
  result: ValidateTokenResult,
  token: string,
  origin: string,
): LoginFailure {
  const status = result.error?.status ?? 0;
  const raw = redactSecret(result.error?.message ?? '', token).trim();
  if (status === 401 || status === 403) {
    return {
      kind: 'rejected',
      status,
      message: raw ? `Token rejected (${status}): ${raw}` : `Token rejected (${status}).`,
    };
  }
  if (status > 0) {
    return { kind: 'http', status, message: raw ? `HTTP ${status}: ${raw}` : `HTTP ${status}.` };
  }
  return {
    kind: 'network',
    status: 0,
    message: raw ? `Cannot reach ${origin}: ${raw}` : `Cannot reach ${origin}.`,
  };
}

/** The account a fresh login lands on: the asked-for one, else the first. */
export function pickAccount(
  accounts: Array<{ account_id: string; slug: string; name: string }>,
  preferredAccountId?: string,
): { account_id: string; slug: string; name: string } | null {
  if (accounts.length === 0) return null;
  if (preferredAccountId) {
    const found = accounts.find((account) => account.account_id === preferredAccountId);
    if (found) return found;
  }
  return accounts[0] ?? null;
}

export const defaultLoginDeps: LoginFlowDeps = {
  validate: ({ backendUrl, token }) =>
    createScopedKortix({
      backendUrl,
      getToken: async () => token,
      // Same surface the running client reports (`src/kortix.ts`), so a
      // token validation and the session it unlocks are one source in the
      // backend's audit events.
      clientSource: 'tui',
    }).validateToken(),
  // `upsertHost`'s third argument IS the set-active seam — the CLI config
  // module has no `setActiveHost`; its rename is `useHost`. Both are called so
  // an existing host that was already stored still becomes active.
  save: (name, host, makeActive) => {
    upsertHost(name, host, makeActive);
    if (makeActive) useHost(name);
  },
  read: getHost,
  remove: removeHost,
  now: () => new Date(),
};

/**
 * Validate a token against a host and persist it.
 *
 * Never throws: every failure is a `LoginFailure` the screen renders inline,
 * because "the token was rejected" is a normal outcome of a paste, not an
 * exception.
 */
export async function loginToHost(
  input: LoginInput,
  overrides: Partial<LoginFlowDeps> = {},
): Promise<LoginResult> {
  const deps: LoginFlowDeps = { ...defaultLoginDeps, ...overrides };
  const name = input.name.trim();
  try {
    validateHostName(name);
  } catch (error) {
    return {
      ok: false,
      error: { kind: 'name', status: 0, message: (error as Error).message },
    };
  }

  const backendUrl = normalizeBackendUrl(input.url);
  if (!backendUrl) {
    return {
      ok: false,
      error: {
        kind: 'url',
        status: 0,
        message: `Not a URL: ${input.url.trim() || '(empty)'}`,
      },
    };
  }

  const token = input.token.trim();
  if (!token) {
    return { ok: false, error: { kind: 'token', status: 0, message: 'Paste a token first.' } };
  }

  let result: ValidateTokenResult;
  try {
    result = await deps.validate({ backendUrl, token });
  } catch (error) {
    // `validateToken` is documented never to throw. A throw here is a
    // transport failure that escaped it; render it, redacted, rather than
    // letting it reach the renderer's uncaught handler and kill the TUI.
    const message = redactSecret(error instanceof Error ? error.message : String(error), token);
    return {
      ok: false,
      error: { kind: 'network', status: 0, message: `Cannot reach ${backendUrl}: ${message}` },
    };
  }

  if (!result.valid || !result.identity) {
    return { ok: false, error: failureFromValidate(result, token, backendUrl) };
  }

  const identity = result.identity;
  const account = pickAccount(identity.accounts ?? [], input.preferredAccountId);
  const makeActive = input.makeActive !== false;
  const existing = deps.read(name);

  const host: Host = {
    url: hostBaseFromBackendUrl(backendUrl),
    token,
    user_id: identity.user_id,
    user_email: identity.email ?? '',
    account_id: account?.account_id ?? '',
    ...(account?.slug ? { account_slug: account.slug } : {}),
    ...(account?.name ? { account_name: account.name } : {}),
    // A re-login keeps the host's default project, but only while it still
    // belongs to the account this login landed on — the same invariant
    // `setActiveAccount` enforces in the CLI.
    ...(existing?.default_project && existing.default_project.account_id === account?.account_id
      ? { default_project: existing.default_project }
      : {}),
    ...(existing?.dashboard_url ? { dashboard_url: existing.dashboard_url } : {}),
    logged_in_at: deps.now().toISOString(),
  };

  deps.save(name, host, makeActive);
  return { ok: true, resolved: resolvedFromHost(name, host) };
}

/** Remove a stored host. Returns what the CLI config module did. */
export function removeLoginHost(
  name: string,
  overrides: Partial<LoginFlowDeps> = {},
): { removed: boolean; switchedTo?: string } {
  const deps: LoginFlowDeps = { ...defaultLoginDeps, ...overrides };
  return deps.remove(name);
}
