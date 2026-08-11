/**
 * Pure parsing for the admin workspaces-list query string.
 *
 * Sibling of `accounts-query.ts`, and separate from the route handler for the
 * same reason: the operator-facing filter semantics (search, account scope,
 * status, sort, pagination) are unit-testable without Drizzle or a database.
 *
 * Two values are sanitized rather than passed through, because Postgres rejects
 * them with 22P02 and a typo in the console should never surface as a 500:
 * `status` is narrowed to real `project_status` enum members, and `accountId`
 * must look like a uuid. An unusable `accountId` is FLAGGED, not dropped —
 * dropping it would silently widen "one account" to "every account".
 */

/** Members of the `kortix.project_status` enum (packages/db/src/schema/kortix.ts). */
export const WORKSPACE_STATUS_VALUES = ["active", "archived"] as const;
export type AdminWorkspaceStatus = (typeof WORKSPACE_STATUS_VALUES)[number];

/** `activity` = last session created_at, DESC NULLS LAST — the default view. */
export type AdminWorkspacesSortBy = "activity" | "created" | "sessions";
export type AdminWorkspacesSortDir = "asc" | "desc";

export interface AdminWorkspacesListQuery {
  search: string;
  /** Set only when the caller supplied a syntactically valid uuid. */
  accountId: string | null;
  /** true → a non-empty `accountId` was supplied that is not a uuid. */
  invalidAccountId: boolean;
  statusValues: AdminWorkspaceStatus[];
  sortBy: AdminWorkspacesSortBy;
  sortDir: AdminWorkspacesSortDir;
  page: number;
  limit: number;
  offset: number;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function csv(value: string | undefined | null): string[] {
  return (value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function intIn(
  value: string | undefined | null,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = parseInt(value || "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function isWorkspaceStatus(value: string): value is AdminWorkspaceStatus {
  return (WORKSPACE_STATUS_VALUES as readonly string[]).includes(value);
}

/**
 * Parse the raw query into a normalized filter intent.
 *
 * @param get accessor over the request query (e.g. `(k) => c.req.query(k)`)
 */
export function parseAdminWorkspacesListQuery(
  get: (key: string) => string | undefined,
): AdminWorkspacesListQuery {
  const sortByRaw = get("sortBy");
  const sortBy: AdminWorkspacesSortBy =
    sortByRaw === "created" || sortByRaw === "sessions"
      ? sortByRaw
      : "activity";

  const page = intIn(get("page"), 1, 1, Number.MAX_SAFE_INTEGER);
  const limit = intIn(get("limit"), 50, 1, 100);

  const accountIdRaw = (get("accountId") || "").trim();
  const accountId = UUID_RE.test(accountIdRaw) ? accountIdRaw : null;

  const statusValues = [
    ...new Set(csv(get("status")).filter(isWorkspaceStatus)),
  ];

  return {
    search: (get("search") || "").trim(),
    accountId,
    invalidAccountId: accountIdRaw.length > 0 && accountId === null,
    statusValues,
    sortBy,
    sortDir: get("sortDir") === "asc" ? "asc" : "desc",
    page,
    limit,
    offset: (page - 1) * limit,
  };
}
