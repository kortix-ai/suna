'use client';

/**
 * `useAccountRoleEditor` — the ONE way a surface edits a person's ACCOUNT
 * role. The account Members list and a group's Members list both show people,
 * and both offer the same "Edit access" row action. That action opens the
 * shared `AccessDialog` in account-scope edit mode, seeded with the person's
 * current role.
 *
 * A member's account role is ONE value: a built-in role (`owner` / `admin` /
 * `member`), or a custom role that rides on the `member` baseline plus one
 * account-scoped `iam_policies` row. Resolving the custom half needs two
 * independent gates, and both must hold:
 *
 *  1. ENTITLEMENT (`rbacEnabled`) — without `rbac` there are no custom roles
 *     and no policies to resolve.
 *  2. PERMISSION (`canReadPolicies`) — `GET .../iam/policies` asserts
 *     `policy.read`, which a plain member does not hold
 *     (`apps/api/src/iam/role-perms.ts`). `=== true`, not `!== false`: a
 *     permission probe reads `false` while in flight, and an optimistic gate
 *     fires the request it exists to suppress.
 *
 * The query key is the Members list's own key, so every surface shares one
 * cached read and `AccessDialog`'s invalidation refreshes all of them.
 */

import { listPolicies, type AccountRole, type IamPolicy } from '@kortix/sdk';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo, useState, type ReactNode } from 'react';

import { AccessDialog, type AccessDialogResult } from './access-dialog';
import { builtinRole, customRole, type RoleValue } from './role-select';

export interface AccountRoleEditTarget {
  userId: string;
  label: string;
  accountRole: AccountRole;
}

export interface UseAccountRoleEditorOptions {
  accountId: string;
  /** Used in the dialog copy. Defaults to "this account" inside the dialog. */
  accountName?: string;
  rbacEnabled: boolean;
  /** `policy.read` — see the module note. */
  canReadPolicies: boolean;
  /** Shows the "Create a custom role →" link inside the role select. */
  canManageRoles: boolean;
  onDone?: (result: AccessDialogResult) => void;
}

export interface AccountRoleEditor {
  /** The person's current account role, custom role included once resolved. */
  roleValueFor: (userId: string, accountRole: AccountRole) => RoleValue;
  /** Opens the edit dialog for one person. */
  openEdit: (target: AccountRoleEditTarget) => void;
  /** Render once, anywhere in the surface's tree. */
  dialog: ReactNode;
}

export function useAccountRoleEditor({
  accountId,
  accountName,
  rbacEnabled,
  canReadPolicies,
  canManageRoles,
  onDone,
}: UseAccountRoleEditorOptions): AccountRoleEditor {
  const [target, setTarget] = useState<AccountRoleEditTarget | null>(null);

  const policiesQuery = useQuery({
    queryKey: ['iam-policies', accountId],
    queryFn: () => listPolicies(accountId),
    enabled: rbacEnabled && canReadPolicies === true,
    staleTime: 30_000,
  });
  const accountPolicyByUser = useMemo(() => {
    const map = new Map<string, IamPolicy>();
    for (const policy of policiesQuery.data ?? []) {
      if (policy.principal_type === 'member' && policy.scope_type === 'account') {
        map.set(policy.principal_id, policy);
      }
    }
    return map;
  }, [policiesQuery.data]);

  const roleValueFor = useCallback(
    (userId: string, accountRole: AccountRole): RoleValue => {
      const policy = accountPolicyByUser.get(userId);
      return policy ? customRole(policy.role_id) : builtinRole(accountRole);
    },
    [accountPolicyByUser],
  );

  const dialog = target ? (
    <AccessDialog
      key={target.userId}
      open
      onOpenChange={(open) => {
        if (!open) setTarget(null);
      }}
      accountId={accountId}
      accountName={accountName}
      scope={{ kind: 'account' }}
      mode={{
        kind: 'edit',
        principal: { type: 'member', id: target.userId, label: target.label },
        // No `assignmentId`: the policies read carries legacy policy ids,
        // which are NOT assignment ids. The dialog reads the row back.
        current: { role: roleValueFor(target.userId, target.accountRole) },
      }}
      rbacEnabled={rbacEnabled}
      canManageRoles={canManageRoles}
      onDone={onDone}
    />
  ) : null;

  return { roleValueFor, openEdit: setTarget, dialog };
}
