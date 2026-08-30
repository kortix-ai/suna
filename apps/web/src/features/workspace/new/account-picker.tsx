'use client';

import { EntityAvatar } from '@/components/ui/entity-avatar';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { KortixAccount } from '@kortix/sdk';

/**
 * What `AccountPicker` paints below two creatable accounts: the caller's own
 * identity, and — only once there is a creatable account to name — which one
 * a workspace would be created in.
 *
 * `identityLabel` is ALWAYS `fallbackLabel` (the signed-in user's own email)
 * and NEVER an account's `name`. An account name can belong to someone else:
 * `bootstrap-personal-account.ts` stores every personal account as
 * `"<owner-email>'s Account"`, and an invited admin's only creatable account
 * can be that owner's personal account. Painting `name` into the identity
 * slot discloses the owner's email to the admin as if it were their own.
 * `accountLabel` carries that name instead, for the caller to render as a
 * separate, explicitly labelled "Create in" value — never merged into one
 * string with the identity line.
 *
 * Pure so the split can be asserted directly, without rendering DOM.
 */
export function resolveAccountPickerIdentity({
  accounts,
  value,
  fallbackLabel,
}: {
  accounts: KortixAccount[];
  value: string | null;
  fallbackLabel?: string | null;
}): { identityLabel: string | null; accountLabel: string | null } {
  const selectedByValue = accounts.find((account) => account.account_id === value) ?? null;
  // Only a SOLE account is implicit enough to name without a pick — with two
  // or more, naming one before the user has chosen would assert a decision
  // nobody made yet.
  const soleAccount = accounts.length === 1 ? accounts[0]! : null;
  const account = selectedByValue ?? soleAccount;
  return {
    identityLabel: fallbackLabel ?? null,
    accountLabel: account?.name ?? null,
  };
}

/**
 * Which account owns the new workspace.
 *
 * Lives in the `/new` top bar — a quiet clickable identity row, not a labeled
 * form field. One account is not a decision: the trigger collapses to two
 * static muted lines — the signed-in identity, and (when there is one) the
 * account it will create into — or `null` when there is nothing to show at
 * all. Two or more opens a Select on click, same interaction shape as
 * `AccountSwitcher` in the app header, toned down to match the bar's
 * secondary chrome.
 *
 * Takes `accounts` as-is and offers every one of them — it does NOT filter by
 * role. The caller (`new-workspace-page.tsx`) is responsible for passing only
 * accounts the user may actually create a workspace in
 * (`filterCreatableAccounts`, `new-workspace-form.ts`); this component has no
 * opinion on permissions and must not duplicate that filter.
 */
export function AccountPicker({
  accounts,
  value,
  onChange,
  fallbackLabel,
  className,
}: {
  accounts: KortixAccount[];
  value: string | null;
  onChange: (accountId: string) => void;
  /** Shown when there is no selected/sole account (typically the signed-in email). */
  fallbackLabel?: string | null;
  className?: string;
}) {
  if (accounts.length < 2) {
    const { identityLabel, accountLabel } = resolveAccountPickerIdentity({
      accounts,
      value,
      fallbackLabel,
    });
    if (!identityLabel && !accountLabel) return null;
    return (
      <span className={cn('flex min-w-0 flex-col', className)}>
        {identityLabel ? (
          <span className="text-muted-foreground min-w-0 truncate text-sm">{identityLabel}</span>
        ) : null}
        {accountLabel ? (
          <span className="text-muted-foreground/70 min-w-0 truncate text-xs">
            Create in {accountLabel}
          </span>
        ) : null}
      </span>
    );
  }

  const selectedByValue = accounts.find((account) => account.account_id === value) ?? null;

  return (
    <Select value={value ?? undefined} onValueChange={onChange}>
      <SelectTrigger
        id="workspace-account"
        variant="transparent"
        size="sm"
        aria-label="Account"
        className={cn(
          'text-muted-foreground hover:text-foreground h-8 max-w-[min(100%,16rem)] min-w-0 px-2',
          className,
        )}
      >
        {selectedByValue ? (
          <span className="text-muted-foreground flex min-w-0 items-center gap-2 truncate text-sm">
            {selectedByValue.name}
          </span>
        ) : (
          <span className="text-muted-foreground truncate text-sm">Choose an account</span>
        )}
      </SelectTrigger>
      <SelectContent align="start">
        {accounts.map((account) => (
          <SelectItem key={account.account_id} value={account.account_id}>
            <span className="flex min-w-0 items-center gap-2">
              <EntityAvatar label={account.name} size="xs" />
              <span className="truncate">{account.name}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
