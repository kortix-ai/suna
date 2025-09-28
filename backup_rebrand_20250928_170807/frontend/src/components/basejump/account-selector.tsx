'use client';

import { ComponentPropsWithoutRef, useMemo, useState } from 'react';
import { Check, ChevronsUpDown, PlusCircle } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import NewTeamForm from '@/components/basejump/new-team-form';
import { useAccounts } from '@/hooks/use-accounts';

type PopoverTriggerProps = ComponentPropsWithoutRef<typeof PopoverTrigger>;

type SelectedAccount = NonNullable<ReturnType<typeof useAccounts>['data']>[0];

interface AccountSelectorProps extends PopoverTriggerProps {
  accountId: string;
  placeholder?: string;
  onAccountSelected?: (account: SelectedAccount) => void;
}

export default function AccountSelector({
  className,
  accountId,
  onAccountSelected,
  placeholder = 'Select an account...',
}: AccountSelectorProps) {
  const [open, setOpen] = useState(false);
  const [showNewTeamDialog, setShowNewTeamDialog] = useState(false);

  const { data: accounts } = useAccounts();

  const { teamAccounts, personalAccount, selectedAccount } = useMemo(() => {
    const personalAccount = accounts?.find(
      (account) => account.personal_account,
    );
    const teamAccounts = accounts?.filter(
      (account) => !account.personal_account,
    );
    const selectedAccount = accounts?.find(
      (account) => account.account_id === accountId,
    );

    return {
      personalAccount,
      teamAccounts,
      selectedAccount,
    };
  }, [accounts, accountId]);

  return (
    <Dialog open={showNewTeamDialog} onOpenChange={setShowNewTeamDialog}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            role="combobox"
            aria-expanded={open}
            aria-label="Select a team"
            className={cn(
              'w-full flex items-center gap-2 h-9 pl-3 pr-2 rounded-md justify-between border border-subtle dark:border-white/10 bg-transparent hover:bg-hover-bg text-foreground/90',
              className,
            )}
          >
            <span className="truncate max-w-[180px]">
              {selectedAccount?.name || placeholder}
            </span>
            <ChevronsUpDown className="h-4 w-4 shrink-0 text-foreground/50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[250px] p-0 border-subtle dark:border-white/10 bg-card-bg dark:bg-background-secondary rounded-xl shadow-custom">
          <Command className="rounded-xl overflow-hidden bg-card-bg dark:bg-background-secondary border-0">
            <CommandList className="border-0 bg-card-bg dark:bg-background-secondary">
              <CommandInput
                placeholder="Search account..."
                className="h-9 border-0 focus:ring-0 rounded-t-xl bg-card-bg dark:bg-background-secondary text-foreground/90"
              />
              <CommandEmpty className="text-foreground/70 text-sm py-2">
                No account found.
              </CommandEmpty>
              <CommandGroup
                heading="Personal Account"
                className="text-xs font-medium text-foreground/70 bg-card-bg dark:bg-background-secondary"
              >
                <CommandItem
                  key={personalAccount?.account_id}
                  onSelect={() => {
                    if (onAccountSelected) {
                      onAccountSelected(personalAccount!);
                    }
                    setOpen(false);
                  }}
                  className="text-sm rounded-md bg-card-bg dark:bg-background-secondary hover:!bg-[#f1eee7] dark:hover:!bg-[#141413] aria-selected:!bg-[#f1eee7] dark:aria-selected:!bg-[#141413] text-foreground/90"
                >
                  {personalAccount?.name}
                  <Check
                    className={cn(
                      'ml-auto h-4 w-4 text-primary',
                      selectedAccount?.account_id ===
                        personalAccount?.account_id
                        ? 'opacity-100'
                        : 'opacity-0',
                    )}
                  />
                </CommandItem>
              </CommandGroup>
              {Boolean(teamAccounts?.length) && (
                <CommandGroup
                  heading="Teams"
                  className="text-xs font-medium text-foreground/70 bg-card-bg dark:bg-background-secondary"
                >
                  {teamAccounts?.map((team) => (
                    <CommandItem
                      key={team.account_id}
                      onSelect={() => {
                        if (onAccountSelected) {
                          onAccountSelected(team);
                        }

                        setOpen(false);
                      }}
                      className="text-sm rounded-md bg-card-bg dark:bg-background-secondary hover:!bg-[#f1eee7] dark:hover:!bg-[#141413] aria-selected:!bg-[#f1eee7] dark:aria-selected:!bg-[#141413] text-foreground/90"
                    >
                      {team.name}
                      <Check
                        className={cn(
                          'ml-auto h-4 w-4 text-primary',
                          selectedAccount?.account_id === team.account_id
                            ? 'opacity-100'
                            : 'opacity-0',
                        )}
                      />
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </CommandList>
            <CommandSeparator className="border-subtle dark:border-white/10" />
            <CommandList className="bg-card-bg dark:bg-background-secondary">
              <CommandGroup className="bg-card-bg dark:bg-background-secondary">
                <DialogTrigger asChild>
                  <CommandItem
                    value="new-team"
                    onSelect={() => {
                      setOpen(false);
                      setShowNewTeamDialog(true);
                    }}
                    className="text-sm rounded-md bg-card-bg dark:bg-background-secondary hover:!bg-[#f1eee7] dark:hover:!bg-[#141413] text-foreground/90"
                  >
                    <PlusCircle className="mr-2 h-4 w-4 text-primary" />
                    Create Team
                  </CommandItem>
                </DialogTrigger>
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <DialogContent className="sm:max-w-[425px] border-subtle dark:border-white/10 bg-card-bg dark:bg-background-secondary rounded-2xl shadow-custom">
        <DialogHeader>
          <DialogTitle className="text-foreground">
            Create a new team
          </DialogTitle>
          <DialogDescription className="text-foreground/70">
            Create a team to collaborate with others.
          </DialogDescription>
        </DialogHeader>
        <NewTeamForm />
      </DialogContent>
    </Dialog>
  );
}
