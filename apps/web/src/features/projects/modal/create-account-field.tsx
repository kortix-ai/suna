'use client';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import type { KortixAccount } from '@kortix/sdk';
import { CheckCircleSolid } from '@mynaui/icons-react';
import { ChevronsUpDown } from 'lucide-react';

export function CreateAccountField({
  current,
  options,
  canSwitch,
  disabled,
  onSelect,
}: {
  current: KortixAccount;
  options: KortixAccount[];
  canSwitch: boolean;
  disabled?: boolean;
  onSelect: (accountId: string) => void;
}) {
  const label = current.name || 'Account';
  const summary = (
    <span className="flex min-w-0 items-center gap-2">
      <EntityAvatar label={label} size="xs" />
      <span className="text-foreground min-w-0 truncate text-sm font-medium">{label}</span>
    </span>
  );

  return (
    <div className="space-y-1.5 px-5" data-testid="project-create-account">
      <Label>Account</Label>
      {canSwitch ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="secondary-outline"
              disabled={disabled}
              className="h-10 w-full justify-between px-3"
            >
              {summary}
              <ChevronsUpDown className="text-muted-foreground size-3.5 shrink-0" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="w-[var(--radix-dropdown-menu-trigger-width)]"
          >
            <DropdownMenuLabel className="text-muted-foreground">Create in</DropdownMenuLabel>
            <div className="max-h-[280px] [scrollbar-width:none] overflow-y-auto [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
              {options.map((account) => {
                const itemLabel = account.name || 'Account';
                const active = account.account_id === current.account_id;
                return (
                  <DropdownMenuItem
                    key={account.account_id}
                    onSelect={() => onSelect(account.account_id)}
                    className="min-h-10"
                  >
                    <EntityAvatar label={itemLabel} size="xs" />
                    <span className="min-w-0 flex-1 truncate text-sm leading-tight font-medium">
                      {itemLabel}
                    </span>
                    <CheckCircleSolid
                      aria-hidden="true"
                      className={cn(
                        'text-kortix-green size-3.5 shrink-0 transition-[opacity,filter,scale] duration-300 ease-[cubic-bezier(0.2,0,0,1)]',
                        active
                          ? 'scale-100 opacity-100 blur-0'
                          : 'scale-[0.25] opacity-0 blur-[4px]',
                      )}
                    />
                  </DropdownMenuItem>
                );
              })}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <div className="border-border bg-secondary flex h-10 w-full items-center rounded-md border px-3">
          {summary}
        </div>
      )}
    </div>
  );
}
