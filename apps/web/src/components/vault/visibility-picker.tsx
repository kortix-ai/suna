'use client';

// Reusable "Who can use this?" visibility picker. Controlled — owns no state
// of its own beyond the member-search popover. Used by both the account Vault
// tab and the project secrets page.

import { useMemo, useState } from 'react';
import { Check, ChevronsUpDown, Globe, Lock, Users, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { UserAvatar } from '@/components/ui/user-avatar';
import { cn } from '@/lib/utils';
import type { VaultVisibility } from '@/lib/vault-client';
import type { AccountMember } from '@/lib/projects-client';

function memberLabel(member: Pick<AccountMember, 'email' | 'user_id'>) {
  return member.email || member.user_id;
}

interface VisibilityPickerProps {
  visibility: VaultVisibility;
  onVisibilityChange: (visibility: VaultVisibility) => void;
  grantUserIds: string[];
  onGrantsChange: (ids: string[]) => void;
  members: AccountMember[];
  disablePrivate?: boolean;
}

const OPTIONS: {
  value: VaultVisibility;
  label: string;
  helper: string;
  icon: typeof Globe;
}[] = [
  {
    value: 'global',
    label: 'Everyone on the project',
    helper: 'Anyone with access to this project can use it.',
    icon: Globe,
  },
  {
    value: 'private',
    label: 'Only me',
    helper: 'Just you. Nobody else can use or see this secret.',
    icon: Lock,
  },
  {
    value: 'select',
    label: 'Select members…',
    helper: 'Pick exactly who can use this secret.',
    icon: Users,
  },
];

export function VisibilityPicker({
  visibility,
  onVisibilityChange,
  grantUserIds,
  onGrantsChange,
  members,
  disablePrivate = false,
}: VisibilityPickerProps) {
  const [open, setOpen] = useState(false);

  const options = useMemo(
    () => (disablePrivate ? OPTIONS.filter((o) => o.value !== 'private') : OPTIONS),
    [disablePrivate],
  );

  const membersById = useMemo(() => {
    const map = new Map<string, AccountMember>();
    for (const m of members) map.set(m.user_id, m);
    return map;
  }, [members]);

  const selectedMembers = useMemo(
    () => grantUserIds.map((id) => membersById.get(id)).filter(Boolean) as AccountMember[],
    [grantUserIds, membersById],
  );

  function toggleMember(userId: string) {
    if (grantUserIds.includes(userId)) {
      onGrantsChange(grantUserIds.filter((id) => id !== userId));
    } else {
      onGrantsChange([...grantUserIds, userId]);
    }
  }

  return (
    <div className="space-y-3">
      <RadioGroup
        value={visibility}
        onValueChange={(v) => onVisibilityChange(v as VaultVisibility)}
        className="gap-2"
      >
        {options.map((opt) => {
          const Icon = opt.icon;
          const active = visibility === opt.value;
          return (
            <label
              key={opt.value}
              htmlFor={`vis-${opt.value}`}
              className={cn(
                'flex cursor-pointer items-start gap-3 rounded-2xl border px-3 py-2.5 transition-colors',
                active ? 'border-primary/40 bg-primary/5' : 'border-border/60 hover:bg-muted/40',
              )}
            >
              <RadioGroupItem value={opt.value} id={`vis-${opt.value}`} className="mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-sm font-medium text-foreground">{opt.label}</span>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">{opt.helper}</p>
              </div>
            </label>
          );
        })}
      </RadioGroup>

      {visibility === 'select' && (
        <div className="space-y-2 pl-1">
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="outline"
                role="combobox"
                aria-expanded={open}
                className="w-full justify-between font-normal"
              >
                <span className="text-muted-foreground">
                  {selectedMembers.length === 0
                    ? 'Choose members…'
                    : `${selectedMembers.length} member${selectedMembers.length === 1 ? '' : 's'} selected`}
                </span>
                <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
              <Command>
                <CommandInput placeholder="Search members…" />
                <CommandList>
                  <CommandEmpty>No members found.</CommandEmpty>
                  <CommandGroup>
                    {members.map((m) => {
                      const checked = grantUserIds.includes(m.user_id);
                      const label = memberLabel(m);
                      return (
                        <CommandItem
                          key={m.user_id}
                          value={label}
                          onSelect={() => toggleMember(m.user_id)}
                        >
                          <UserAvatar email={m.email ?? ''} size="sm" />
                          <span className="min-w-0 flex-1 truncate">{label}</span>
                          <Check
                            className={cn(
                              'ml-auto h-4 w-4',
                              checked ? 'opacity-100' : 'opacity-0',
                            )}
                          />
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>

          {selectedMembers.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {selectedMembers.map((m) => (
                <Badge key={m.user_id} variant="secondary" size="sm" className="gap-1 pr-1">
                  <UserAvatar email={m.email ?? ''} size="xs" />
                  <span className="max-w-[140px] truncate">{memberLabel(m)}</span>
                  <button
                    type="button"
                    onClick={() => toggleMember(m.user_id)}
                    className="ml-0.5 rounded-full p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                    aria-label={`Remove ${memberLabel(m)}`}
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </Badge>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
