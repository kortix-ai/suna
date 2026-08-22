'use client';

// RoleSelect — THE role picker for every access surface.
//
// One `Select` renders both halves of the role model: the built-in roles
// for the scope (with the one-line capability blurb from
// `project-role-descriptors.ts`, generalised to account roles) and, under
// a "Custom" group, the account's non-system `iam_roles` filtered to the
// same `resource_type`. Callers never branch on built-in vs custom — they
// hand us a `RoleValue` and get a `RoleValue` back.
//
// It replaces: the `DropdownMenuRadioGroup` role changer on the account
// Members list, the two `DropdownMenuSub` "Change role" menus on the
// project Access table, `BulkSetRoleDialog`'s concatenated items, the
// inline `SelectItem`s in `InviteMemberModal`, `AttachToProjectDialog`'s
// role `Select`, and `CreateAssignmentDialog`'s custom-role-only `Select`.
// `role-select-item.tsx` folds into this file.

import Link from 'next/link';
import { menuRow } from '@/components/ui/menu-recipe';
import { ArrowRightIcon } from '@phosphor-icons/react';
import { useMemo } from 'react';

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { listRoles, type AccountRole, type IamRole, type ProjectRole } from '@kortix/sdk';
import { useQuery } from '@tanstack/react-query';

export type RoleScope = 'account' | 'project';

/** The built-in role names for a scope, ordered low → high privilege. */
export const ACCOUNT_ROLES_ASCENDING: AccountRole[] = ['member', 'admin', 'owner'];

/** The project roles that exist. Owner decision 2026-08-18: two, not three. */
export type OfferedProjectRole = 'member' | 'manager';
export const PROJECT_ROLES_ASCENDING: OfferedProjectRole[] = ['member', 'manager'];

/**
 * The lowest built-in role for a scope. A custom role is an ADDITIVE layer on
 * top of a built-in baseline. It is now ONE assignment row of that role, not a
 * built-in row plus a policy row — see `access-dialog.tsx`.
 */
export const BUILTIN_BASELINE: { account: AccountRole; project: ProjectRole } = {
  account: 'member',
  project: 'member',
};

export function builtinRolesForScope(scope: RoleScope): Array<AccountRole | ProjectRole> {
  return scope === 'account' ? [...ACCOUNT_ROLES_ASCENDING] : [...PROJECT_ROLES_ASCENDING];
}

interface RoleDescriptor {
  label: string;
  blurb: string;
  /** Two-sentence version, for the Help page and popovers. */
  summary: string;
}

/**
 * Single source of truth for how a built-in role is described in the UI.
 * Copy lifted verbatim from `components/iam/project-role-descriptors.ts`
 * so no wording changes as part of the unification.
 */
export const ACCOUNT_ROLE_DESCRIPTORS: Record<AccountRole, RoleDescriptor> = {
  owner: {
    label: 'Owner',
    blurb: 'Full control. Can transfer ownership, delete the account, and manage billing.',
    summary:
      'Full control of the account. Can transfer ownership, delete the account, and manage billing — and is Manager on every project.',
  },
  admin: {
    label: 'Admin',
    blurb: 'Everything except deleting the account or transferring ownership.',
    summary:
      'Everything an owner can do except deleting the account or transferring ownership. Also Manager on every project.',
  },
  member: {
    label: 'Member',
    blurb:
      "No implicit project access. Sees only projects they've been added to (directly or via a group).",
    summary:
      "The floor role for the account. No implicit project access — they see only the projects they've been added to, directly or via a group.",
  },
};

export const PROJECT_ROLE_DESCRIPTORS: Record<OfferedProjectRole, RoleDescriptor> = {
  member: {
    label: 'Member',
    blurb: 'Read, run sessions, and fire triggers — no editing or config.',
    summary:
      'Read, run sessions, and fire triggers — no editing or config. The project floor role.',
  },
  manager: {
    label: 'Manager',
    blurb: 'Full project control — edit, deploy, triggers, members, delete.',
    summary: 'Full project control — edit, deploy, triggers, members, delete.',
  },
};

export function builtinRoleDescriptor(
  scope: RoleScope,
  role: AccountRole | ProjectRole,
): RoleDescriptor | undefined {
  return scope === 'account'
    ? ACCOUNT_ROLE_DESCRIPTORS[role as AccountRole]
    : PROJECT_ROLE_DESCRIPTORS[role as OfferedProjectRole];
}

/** "Manager", "Owner" — the display name of a built-in role. */
export function builtinRoleLabel(scope: RoleScope, role: AccountRole | ProjectRole): string {
  return builtinRoleDescriptor(scope, role)?.label ?? role;
}

// ─── RoleValue ─────────────────────────────────────────────────────────────

export type RoleValue =
  | { kind: 'builtin'; role: AccountRole | ProjectRole }
  | { kind: 'custom'; roleId: string }
  | { kind: 'none' };

export const ROLE_NONE: RoleValue = { kind: 'none' };

export function builtinRole(role: AccountRole | ProjectRole): RoleValue {
  return { kind: 'builtin', role };
}

export function customRole(roleId: string): RoleValue {
  return { kind: 'custom', roleId };
}

export function roleValuesEqual(a: RoleValue, b: RoleValue): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'builtin' && b.kind === 'builtin') return a.role === b.role;
  if (a.kind === 'custom' && b.kind === 'custom') return a.roleId === b.roleId;
  return true;
}

/**
 * The built-in role actually written to `account_members` /
 * `project_members` for a `RoleValue`. A custom role rides on the lowest
 * built-in baseline for its scope; `none` has no built-in at all.
 */
export function baselineBuiltinRole(
  scope: RoleScope,
  value: RoleValue,
): AccountRole | ProjectRole | null {
  if (value.kind === 'builtin') return value.role;
  if (value.kind === 'custom') return BUILTIN_BASELINE[scope];
  return null;
}

const CUSTOM_PREFIX = 'custom:';
const BUILTIN_PREFIX = 'builtin:';
const NONE_VALUE = '__none__';

/** `RoleValue` → the opaque string the underlying `Select` carries. */
export function roleValueToSelectValue(value: RoleValue): string {
  if (value.kind === 'builtin') return `${BUILTIN_PREFIX}${value.role}`;
  if (value.kind === 'custom') return `${CUSTOM_PREFIX}${value.roleId}`;
  return NONE_VALUE;
}

/** The inverse of {@link roleValueToSelectValue}. */
export function selectValueToRoleValue(raw: string): RoleValue {
  if (raw.startsWith(BUILTIN_PREFIX)) {
    return { kind: 'builtin', role: raw.slice(BUILTIN_PREFIX.length) as AccountRole | ProjectRole };
  }
  if (raw.startsWith(CUSTOM_PREFIX)) return { kind: 'custom', roleId: raw.slice(CUSTOM_PREFIX.length) };
  return ROLE_NONE;
}

/**
 * The label a LIST ROW shows for a role — built-in display name, custom
 * role name, or the em dash the project Access table used for "no access".
 * Pass the `listRoles` result so a custom role resolves to its name.
 */
export function roleValueLabel(
  scope: RoleScope,
  value: RoleValue,
  roles?: readonly IamRole[],
): string {
  if (value.kind === 'builtin') return builtinRoleLabel(scope, value.role);
  if (value.kind === 'custom') {
    return roles?.find((r) => r.role_id === value.roleId)?.name ?? 'Custom role';
  }
  return '—';
}

/** Non-system roles defined for this scope's `resource_type`. */
export function customRolesForScope(
  roles: readonly IamRole[] | undefined,
  scope: RoleScope,
): IamRole[] {
  return (roles ?? []).filter((r) => !r.is_system && r.resource_type === scope);
}

/** The shared query key + fetcher every access surface reads roles through. */
export const IAM_ROLES_KEY = (accountId: string) => ['iam-roles', accountId] as const;

export function useAccountRoles(accountId: string, enabled = true) {
  return useQuery({
    queryKey: IAM_ROLES_KEY(accountId),
    queryFn: () => listRoles(accountId),
    enabled: enabled && !!accountId,
    staleTime: 30_000,
  });
}

// ─── Component ─────────────────────────────────────────────────────────────

export interface RoleSelectProps {
  scope: RoleScope;
  accountId: string;
  value: RoleValue;
  onChange: (next: RoleValue) => void;
  disabled?: boolean;
  /** Adds a leading "No access" option that maps to `{kind:'none'}`. */
  allowNone?: boolean;
  /** Copy for the `allowNone` item. */
  noneLabel?: string;
  /**
   * Whether the account's tier carries the `rbac` entitlement. Custom roles
   * are hidden entirely when false — creating the policy would 402.
   * Defaults to true so a caller that has not resolved the tier yet is not
   * silently downgraded.
   */
  rbacEnabled?: boolean;
  /** Shows the "Create a custom role →" footer link when there are none yet. */
  canManageRoles?: boolean;
  /**
   * Narrow the built-in list, e.g. the account grant flow offers Member and
   * Admin but never Owner (ownership transfer is its own flow). Omit for
   * every built-in role of the scope.
   */
  builtinRoles?: Array<AccountRole | ProjectRole>;
  id?: string;
  className?: string;
  placeholder?: string;
}

export function RoleSelect({
  scope,
  accountId,
  value,
  onChange,
  disabled,
  allowNone = false,
  noneLabel = 'No access',
  rbacEnabled = true,
  canManageRoles = false,
  builtinRoles,
  id,
  className,
  placeholder = 'Choose a role',
}: RoleSelectProps) {
  const rolesQuery = useAccountRoles(accountId, rbacEnabled);
  const builtins = useMemo(() => {
    const offered = builtinRoles ?? builtinRolesForScope(scope);
    // Invariant: the Select must always hold an item matching its value. A row
    // carrying a role this scope no longer offers would otherwise render the
    // placeholder, and Save would silently rewrite the role the admin never
    // touched. Appended for that row only, never offered to anyone else.
    if (value.kind === 'builtin' && !offered.includes(value.role)) {
      return [...offered, value.role];
    }
    return offered;
  }, [builtinRoles, scope, value]);
  const customRoles = useMemo(
    () => (rbacEnabled ? customRolesForScope(rolesQuery.data, scope) : []),
    [rbacEnabled, rolesQuery.data, scope],
  );

  // The selected custom role can be missing from the list while roles are
  // still loading. Render a placeholder item for it so the trigger does not
  // flash empty and then snap back.
  const selectedMissingCustom =
    value.kind === 'custom' && !customRoles.some((r) => r.role_id === value.roleId);

  if (rbacEnabled && rolesQuery.isLoading && value.kind === 'custom') {
    return <Skeleton className={className ?? 'h-9 w-full rounded-lg'} />;
  }

  return (
    <Select
      value={roleValueToSelectValue(value)}
      onValueChange={(next) => onChange(selectValueToRoleValue(next))}
      disabled={disabled}
    >
      <SelectTrigger id={id} className={className}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {allowNone ? <SelectItem value={NONE_VALUE}>{noneLabel}</SelectItem> : null}
        {builtins.map((role) => {
          const descriptor = builtinRoleDescriptor(scope, role);
          return (
            <SelectItem
              key={role}
              value={`${BUILTIN_PREFIX}${role}`}
              description={descriptor?.blurb}
            >
              <span className="font-medium">{builtinRoleLabel(scope, role)}</span>
            </SelectItem>
          );
        })}

        {rbacEnabled && (customRoles.length > 0 || selectedMissingCustom) ? (
          <>
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel>Custom</SelectLabel>
              {selectedMissingCustom && value.kind === 'custom' ? (
                <SelectItem value={`${CUSTOM_PREFIX}${value.roleId}`}>Custom role</SelectItem>
              ) : null}
              {customRoles.map((role) => (
                <SelectItem
                  key={role.role_id}
                  value={`${CUSTOM_PREFIX}${role.role_id}`}
                  description={role.description ?? undefined}
                >
                  <span className="font-medium">{role.name}</span>
                </SelectItem>
              ))}
            </SelectGroup>
          </>
        ) : null}
        {/* No custom roles yet: one footer row that reads as a row (same
            recipe as the items above it — same inset, same height), not a
            "Custom" heading over an empty group with a bare link under it. */}
        {rbacEnabled && customRoles.length === 0 && !selectedMissingCustom && canManageRoles ? (
          <>
            <SelectSeparator />
            <Link
              href={`/accounts/${accountId}?tab=roles`}
              className={menuRow('md', 'default', 'text-muted-foreground hover:text-foreground')}
            >
              <span className="flex w-full items-center justify-between gap-2">
                <span>Create a custom role</span>
                <ArrowRightIcon className="size-3.5 shrink-0" aria-hidden />
              </span>
            </Link>
          </>
        ) : null}
      </SelectContent>
    </Select>
  );
}
