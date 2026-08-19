// Shared, framework-free helpers for every access-control surface.
//
// One copy of each string / formatter that used to live in three or four
// IAM files at once. Nothing here imports React — it is all pure so the
// unit tests can call it directly (`access-shared.test.ts`).

/**
 * The exact wording the backend's `requireEntitlement('rbac')` 402 uses —
 * keep it in sync with apps/api/src/accounts/iam/helpers.ts
 * `ENTITLEMENT_LABEL.rbac`.
 *
 * Replaces the four verbatim copies that lived in `roles-tab.tsx`,
 * `groups-tab.tsx`, `policy-assignments.tsx` and
 * `accounts/[id]/groups/[groupId]/page.tsx`.
 */
export const RBAC_UPSELL_MESSAGE =
  'Custom roles, policies, and groups are available on the Enterprise plan. Contact sales to enable it.';

/**
 * How a principal is labelled in every list, row, dialog and confirm.
 * Email when we have one, otherwise the raw id — the same `email ||
 * user_id` fallback that was written out inline in `page.tsx`
 * (`memberLabel`), `access-agents-tab.tsx` (`accountMemberLabel`) and
 * `access-projects-tab.tsx` (`userLabel`).
 */
export function principalLabel(
  principal: { email?: string | null; user_id?: string | null; name?: string | null } | null | undefined,
): string {
  if (!principal) return '';
  return principal.email || principal.name || principal.user_id || '';
}

/** Shortened principal id, for surfaces that only have a raw uuid. */
export function shortPrincipalId(userId: string): string {
  return userId.slice(0, 8);
}

// Module-scope formatters: constructing `Intl.DateTimeFormat` is the
// expensive half, and these (locale, options) pairs are static.
const relativeFallbackFormat = new Intl.DateTimeFormat();
const rowDateFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

/**
 * "just now" / "12m ago" / "3h ago" / "9d ago" / absolute date past 30
 * days. Byte-for-byte the ladder that `audit-tab.tsx` and `scim-card.tsx`
 * each carried their own copy of; this version takes both an ISO string
 * and a `Date` so both call sites collapse onto it.
 */
export function formatRelative(input: string | Date | null | undefined): string {
  if (!input) return '—';
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return '—';
  const minutes = Math.floor((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return relativeFallbackFormat.format(date);
}

/** "Aug 18, 2026" — the row-meta date used by every access list. */
export function formatDate(input: string | null | undefined): string {
  if (!input) return '—';
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return '—';
  return rowDateFormat.format(date);
}

export interface ExpiryDisplay {
  /** "Never" when there is no expiry, otherwise the formatted date. */
  label: string;
  /** true once the timestamp is in the past. */
  expired: boolean;
  /** false when there is no expiry at all — render it muted. */
  bounded: boolean;
}

/**
 * The `ExpiresCell` logic from `access-projects-tab.tsx:1186-1195`, minus
 * the JSX: no expiry = permanent "Never"; a past timestamp is flagged so
 * the row can paint it `text-kortix-red` instead of `text-kortix-yellow`.
 */
export function formatExpiry(expiresAt: string | null | undefined): ExpiryDisplay {
  if (!expiresAt) return { label: 'Never', expired: false, bounded: false };
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return { label: '—', expired: false, bounded: true };
  return {
    label: rowDateFormat.format(date),
    expired: date.getTime() < Date.now(),
    bounded: true,
  };
}

/**
 * `<input type="date">` value → ISO instant at the END of that day, in the
 * admin's own timezone. A bare `YYYY-MM-DD` parses as UTC midnight, which
 * reads as the day BEFORE for western-timezone admins — ported from
 * `policy-assignments.tsx`'s `CreateAssignmentDialog`.
 *
 * Returns `undefined` for an empty value so callers can spread it into a
 * payload without sending `expires_at: null` by accident.
 */
export function endOfLocalDayIso(dateValue: string): string | undefined {
  if (!dateValue) return undefined;
  const parsed = new Date(`${dateValue}T23:59:59`);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
}

/** ISO instant → the `YYYY-MM-DD` an `<input type="date">` wants back. */
export function isoToDateInputValue(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export interface RemoveAccessCopyInput {
  /** Display label of the principal losing access. */
  principal: string;
  /** Where they lose it — an account name, a project name, a group name. */
  scopeName: string;
  /**
   * Groups that keep granting them access after the direct grant is gone.
   * Pass the group names; an empty list / omission means the removal is
   * total.
   */
  inherited?: string[];
}

export interface ConfirmCopy {
  title: string;
  description: string;
}

/**
 * The ONE destructive-confirm copy builder for "this principal should no
 * longer have access here". Every remove/revoke/detach confirm in the
 * access surface uses it, always with `confirmVariant="destructive"`.
 */
export function removeAccessCopy({
  principal,
  scopeName,
  inherited,
}: RemoveAccessCopyInput): ConfirmCopy {
  const base = `${principal} loses access to ${scopeName}.`;
  if (!inherited || inherited.length === 0) return { title: 'Remove access?', description: base };
  return {
    title: 'Remove access?',
    description: `${base} They keep the access they get via ${formatList(inherited)}.`,
  };
}

/** "a", "a and b", "a, b and c" — used by `removeAccessCopy`'s inherited note. */
export function formatList(items: readonly string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** "1 project" / "3 projects" — the meta-line pluraliser every row needs. */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
