'use client';

import { EntityAvatar } from '@/components/ui/entity-avatar';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import type { KortixAccount } from '@kortix/sdk';

/**
 * Which account owns the new workspace.
 *
 * Renders NOTHING for a user with one account. A select with a single option
 * is a decision the user cannot make — it costs a row of vertical space and a
 * beat of "wait, is this important?" to say nothing. The overwhelming
 * majority of users have one account, so the plain page must actually be
 * plain.
 *
 * Rendered as a third field inside the page's existing `bg-popover rounded-md
 * border` card (`new-workspace-page.tsx`) — same `flex flex-col gap-1.5`
 * field-group shape and `Label` treatment as the name field and the Advanced
 * disclosure beside it. Never a second card: `card.tsx:35` — `<Card>` is a
 * transparent, borderless grid system, not a bordered panel, and Task 11 next
 * to this one already had to fix a card-inside-a-card.
 *
 * `EntityAvatar` at `size="sm"` — the same size `workspace-menu-section.tsx` uses
 * for its own account/workspace rows, so the two surfaces share one tile
 * scale, and it sits correctly beside this default `h-9` `SelectTrigger`.
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
}: {
  accounts: KortixAccount[];
  value: string | null;
  onChange: (accountId: string) => void;
}) {
  if (accounts.length < 2) return null;

  const selected = accounts.find((account) => account.account_id === value) ?? null;

  return (
    <div className="flex flex-col space-y-3">
      <Label htmlFor="workspace-account">Account</Label>
      <Select value={value ?? undefined} onValueChange={onChange}>
        <SelectTrigger id="workspace-account" className="w-full" size="md">
          {selected ? (
            <span className="flex min-w-0 items-center gap-2">
              <EntityAvatar label={selected.name} size="sm" />
              <span className="truncate">{selected.name}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">Choose an account</span>
          )}
        </SelectTrigger>
        <SelectContent>
          {accounts.map((account) => (
            <SelectItem key={account.account_id} value={account.account_id}>
              <span className="flex min-w-0 items-center gap-2">
                <EntityAvatar label={account.name} size="sm" />
                <span className="truncate">{account.name}</span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
