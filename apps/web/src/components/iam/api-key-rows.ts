/**
 * One key list out of two backends.
 *
 * The API keys surface used to be two stacked cards with two vocabularies:
 * "Personal Access Tokens" (`/accounts/tokens`, `AccountToken`) in one, and
 * "service accounts" (`/accounts/{id}/iam/service-accounts`, `ServiceAccount`)
 * in the other. Nobody arrives at this tab thinking "do I want a PAT or a
 * service account" — they arrive wanting a key. So the UI shows one list and
 * this module is the seam that produces it: two record shapes in, one
 * `ApiKeyRow[]` out.
 *
 * Pure on purpose — `apps/web` has no DOM test harness, so the only part of
 * this surface that can be tested properly is the part with no React in it.
 * Everything decided here (which rows are hidden, what order they come in,
 * what each row says) is decided here rather than inline in JSX.
 */

import type { ServiceAccount } from '@/lib/iam-client';
import type { AccountToken, KortixProject } from '@kortix/sdk';

/**
 * Kortix mints one of these per session and injects it into the sandbox as
 * `KORTIX_TOKEN` (`apps/api/src/platform/services/session-sandbox.ts`,
 * `mintConnectorToken` — `name: \`Connector Session ${sandboxId.slice(0, 8)}\``).
 * They land in the SAME table as human-created keys, so `/accounts/tokens`
 * returns them: a workspace that has run 200 sessions has 200 of these, and
 * listing them turns this tab into a session log nobody asked for.
 *
 * Matching on the name is a heuristic, and it is deliberate: the list payload
 * carries no `session_id` today (`repositories/account-tokens.ts`'s
 * `listAccountTokens` selects nine columns and `session_id` is not one of
 * them), so the name plus the project binding is the only signal the browser
 * has. When that field is added to the response, replace
 * `isRuntimeMintedKey` with a `session_id !== null` check and delete this
 * constant — the call sites do not change.
 */
export const RUNTIME_TOKEN_NAME_PREFIX = 'Connector Session ';

/**
 * True for a key the runtime minted for itself, which a person never created
 * and cannot usefully revoke (the session it belongs to revokes it on
 * delete — `revokeSessionConnectorTokens`).
 *
 * Both halves are required. Every runtime key is bound to a project AND
 * carries the generated name; a human key that happens to be project-scoped
 * (created from the scope picker in this tab, or by `kortix login` inside a
 * sandbox) keeps its own name and stays visible.
 */
export function isRuntimeMintedKey(token: Pick<AccountToken, 'name' | 'project_id'>): boolean {
  return token.project_id !== null && token.name.startsWith(RUNTIME_TOKEN_NAME_PREFIX);
}

/**
 * Two kinds of key exist and the difference is real, so the UI names it in
 * plain words rather than hiding it:
 *
 * - `personal` — a PAT. Acts as the person who made it, works with the CLI
 *   immediately, dies when that person is offboarded.
 * - `automation` — a service account. Its own identity with its own
 *   permissions; keeps working when its author leaves.
 */
export type ApiKeyKind = 'personal' | 'automation';

/**
 * What the key is doing right now, as a person would describe it.
 *
 * `expired` is derived, not stored. Neither backend flips a row's `status`
 * when its `expires_at` passes — the check happens at authentication time
 * (`validateAccountToken`), so an expired key sits in the list reading
 * "active" while every request it makes is rejected. Three states means the
 * list can say which keys are actually working, and the filter can separate
 * "someone revoked this" from "this ran out".
 */
export type ApiKeyStatus = 'active' | 'expired' | 'revoked';

export interface ApiKeyRow {
  /** `token_id` for a personal key, `service_account_id` for an automation key. */
  id: string;
  kind: ApiKeyKind;
  name: string;
  /** The public, non-secret head of the key — how you match a row to a log line. */
  hint: string;
  status: ApiKeyStatus;
  createdAt: string;
  lastUsedAt: string | null;
  /** `null` for a key that never expires. */
  expiresAt: string | null;
  /** What the key can reach. `null` = everything in this workspace. */
  scopeLabel: string | null;
}

/**
 * Trim a public key to something a person can eyeball without wrapping.
 *
 * The two sources arrive at different lengths. A PAT's `public_key` is
 * `pk_` + 32 random characters (`shared/crypto.ts`,
 * `generateAccountTokenPair`) — 35 characters, too long for a meta line. A
 * service account's `public_prefix` is already display-ready and already ends
 * in an ellipsis (`kortix_sa_` + 8 characters + `…`, `generateServiceAccountSecret`),
 * so the default keeps it whole rather than truncating a truncation.
 */
export function shortKeyHint(publicKey: string, max = 20): string {
  if (publicKey.length <= max) return publicKey;
  return `${publicKey.slice(0, max).replace(/…$/, '')}…`;
}

/** A project id with no matching project — show enough to be recognizable. */
function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

export interface BuildApiKeyRowsInput {
  tokens?: AccountToken[];
  serviceAccounts?: ServiceAccount[];
  /** Only used to turn a project-scoped key's id into that project's name. */
  projects?: KortixProject[];
  /** Injected so "has this expired yet?" is testable. */
  now?: number;
}

/** Revoked beats expired beats working — the order the table lists them in. */
const STATUS_RANK: Record<ApiKeyStatus, number> = { active: 0, expired: 1, revoked: 2 };

function resolveStatus(revoked: boolean, expiresAt: string | null, now: number): ApiKeyStatus {
  if (revoked) return 'revoked';
  if (!expiresAt) return 'active';
  const ms = new Date(expiresAt).getTime();
  // An unparseable date is not evidence of expiry — leave the key alone.
  if (!Number.isFinite(ms)) return 'active';
  return ms <= now ? 'expired' : 'active';
}

/**
 * Merge both key sources into the single list the table renders.
 *
 * Order: working keys first, then expired, then revoked; newest first inside
 * each group. A key that no longer works is history — it belongs under the
 * ones that do, whichever filter is showing.
 */
export function buildApiKeyRows({
  tokens = [],
  serviceAccounts = [],
  projects = [],
  now = Date.now(),
}: BuildApiKeyRowsInput): ApiKeyRow[] {
  const projectName = new Map(projects.map((p) => [p.project_id, p.name]));

  const personal: ApiKeyRow[] = tokens
    .filter((t) => !isRuntimeMintedKey(t))
    .map((t) => ({
      id: t.token_id,
      kind: 'personal',
      name: t.name,
      hint: shortKeyHint(t.public_key),
      status: resolveStatus(t.status !== 'active', t.expires_at, now),
      createdAt: t.created_at,
      lastUsedAt: t.last_used_at,
      expiresAt: t.expires_at,
      scopeLabel: t.project_id ? (projectName.get(t.project_id) ?? shortId(t.project_id)) : null,
    }));

  const automation: ApiKeyRow[] = serviceAccounts.map((sa) => ({
    id: sa.service_account_id,
    kind: 'automation',
    name: sa.name,
    hint: shortKeyHint(sa.public_prefix),
    status: resolveStatus(sa.status !== 'active', sa.expires_at, now),
    createdAt: sa.created_at,
    lastUsedAt: sa.last_used_at,
    expiresAt: sa.expires_at,
    scopeLabel: null,
  }));

  return [...personal, ...automation].sort((a, b) => {
    const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (rank !== 0) return rank;
    return createdMillis(b.createdAt) - createdMillis(a.createdAt);
  });
}

/** An unparseable timestamp sorts last rather than throwing the whole list. */
function createdMillis(iso: string): number {
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

// ── Search + filters ────────────────────────────────────────────────────────

/** `all` is the default for both axes — a filter you cannot turn off is a trap. */
export interface ApiKeyFilter {
  /** Free text over the name, the key hint, and the scope label. */
  search?: string;
  status?: ApiKeyStatus | 'all';
  kind?: ApiKeyKind | 'all';
}

/**
 * Everything the toolbar can do, in one pure pass.
 *
 * The three fields a row *shows* are the three fields search looks at — no
 * hidden index, nothing matched that the reader cannot see. That matters more
 * than it sounds: a search that matches an invisible field reads as a bug.
 */
export function filterApiKeyRows(rows: ApiKeyRow[], filter: ApiKeyFilter = {}): ApiKeyRow[] {
  const { search = '', status = 'all', kind = 'all' } = filter;
  const needle = search.trim().toLowerCase();

  return rows.filter((row) => {
    if (status !== 'all' && row.status !== status) return false;
    if (kind !== 'all' && row.kind !== kind) return false;
    if (!needle) return true;
    return [row.name, row.hint, row.scopeLabel ?? ''].join(' ').toLowerCase().includes(needle);
  });
}

/**
 * What the one filter control can be set to.
 *
 * The toolbar used to carry two controls: a four-pill status strip (All /
 * Active / Expired / Revoked) and a separate type dropdown (All types /
 * Personal / Automation) — six targets above a list that is usually under ten
 * rows, and two of them named "All". Jay, 2026-08-12: "group the tabs into a
 * single thing that is not overcomplicated for the non-technical user."
 *
 * So it is one dropdown, one axis at a time. `ApiKeyStatus` and `ApiKeyKind`
 * are disjoint string literals, which is what lets a single value stand in for
 * either axis with no discriminator; `apiKeyFilter` is the only code that has
 * to know which axis a given value belongs to.
 *
 * Nothing is lost that the search field does not already cover: "the revoked
 * automation keys" is Revoked plus typing part of the name. Composing two
 * dropdowns buys that one case and charges every visit for it.
 */
export type ApiKeyFilterValue = 'all' | ApiKeyStatus | ApiKeyKind;

function isKind(value: ApiKeyFilterValue): value is ApiKeyKind {
  return value === 'personal' || value === 'automation';
}

/** Widen the one control's value back into the two-axis filter. */
export function apiKeyFilter(value: ApiKeyFilterValue): ApiKeyFilter {
  if (value === 'all') return {};
  return isKind(value) ? { kind: value } : { status: value };
}

/**
 * One count per option the filter offers, so each choice can say how many rows
 * it leads to before it is picked — and so "Expired" can be left out of the
 * menu entirely when nothing has expired.
 *
 * Counted over the whole list, not the current selection. With a single axis
 * there is no second filter left to stay honest about, and a number that moved
 * while the menu was open would be unreadable.
 */
export function countApiKeys(rows: ApiKeyRow[]): Record<ApiKeyFilterValue, number> {
  return rows.reduce(
    (counts, row) => {
      counts.all += 1;
      counts[row.status] += 1;
      counts[row.kind] += 1;
      return counts;
    },
    { all: 0, active: 0, expired: 0, revoked: 0, personal: 0, automation: 0 },
  );
}
