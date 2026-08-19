'use client';

import { EntityAvatar } from '@/components/ui/entity-avatar';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { KortixAccount } from '@kortix/sdk';

/**
 * Which account owns the new workspace.
 *
 * Lives in the `/new` top bar — a quiet clickable identity row, not a labeled
 * form field. One account is not a decision: the trigger collapses to static
 * muted text (or `null` when there is nothing to show). Two or more opens a
 * Select on click, same interaction shape as `AccountSwitcher` in the app
 * header, toned down to match the bar's secondary chrome.
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
  const selectedByValue = accounts.find((account) => account.account_id === value) ?? null;
  // One account is not a pick — show it as identity. Two or more: only paint
  // a name once the user (or an explicit value) has actually chosen.
  const identityAccount = selectedByValue ?? (accounts.length === 1 ? accounts[0]! : null);
  const label = identityAccount?.name || fallbackLabel || null;

  if (accounts.length < 2) {
    if (!label) return null;
    return (
      <span className={cn('text-muted-foreground min-w-0 truncate text-sm', className)}>
        {label}
      </span>
    );
  }

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
