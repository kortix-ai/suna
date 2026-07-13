'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  InputGroupSearch,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import Loading from '@/components/ui/loading';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { Icon } from '@/features/icon/icon';
import { cn } from '@/lib/utils';
import type { GitHubRepository, GitHubRepositoryBranch } from '@kortix/sdk';
import { CheckCircleSolid } from '@mynaui/icons-react';
import { ChevronsUpDown, GitBranch, Search } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

interface PickerOption {
  value: string;
  label: string;
  description?: string | null;
  keywords: string;
  badge?: ReactNode;
}

function SearchPicker({
  value,
  options,
  loading,
  disabled,
  loadingLabel,
  placeholder,
  searchPlaceholder,
  emptyLabel,
  icon,
  onValueChange,
}: {
  value: string;
  options: PickerOption[];
  loading: boolean;
  disabled: boolean;
  loadingLabel: string;
  placeholder: string;
  searchPlaceholder: string;
  emptyLabel: string;
  icon: ReactNode;
  onValueChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const selected = options.find((option) => option.value === value);
  const normalizedSearch = search.trim().toLowerCase();
  const filtered = normalizedSearch
    ? options.filter((option) => option.keywords.includes(normalizedSearch))
    : options;

  useEffect(() => {
    if (!open) setSearch('');
  }, [open]);

  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="secondary-outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="h-10 w-full justify-between p-0 has-[>svg]:p-0"
        >
          <span className="flex min-w-0 items-center self-stretch">
            <span className="px-3">{loading ? <Loading className="size-4" /> : icon}</span>
            <Separator orientation="vertical" className="mr-2" />
            <span
              className={cn('min-w-0 truncate text-left', !selected && 'text-muted-foreground')}
            >
              {loading ? loadingLabel : (selected?.label ?? placeholder)}
            </span>
          </span>
          <ChevronsUpDown className="text-muted-foreground mr-3 size-4 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        className="w-[var(--radix-popover-trigger-width)] overflow-hidden p-0"
      >
        <div className="border-border/60 border-b p-2">
          <InputGroupSearch>
            <InputGroupSearchIcon>
              <Search />
            </InputGroupSearchIcon>
            <InputGroupSearchInput
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={searchPlaceholder}
              autoCapitalize="none"
              autoCorrect="off"
              autoFocus
              variant="popover"
            />
          </InputGroupSearch>
        </div>
        {filtered.length === 0 ? (
          <div className="text-muted-foreground px-3 py-6 text-center text-xs">{emptyLabel}</div>
        ) : (
          <ul className="max-h-[min(50vh,360px)] space-y-1 overflow-y-auto p-1.5">
            {filtered.map((option) => {
              const active = option.value === value;
              return (
                <li key={option.value}>
                  <button
                    type="button"
                    className={cn(
                      'hover:bg-muted flex min-h-10 w-full items-center gap-3 rounded-md px-2.5 py-2 text-left transition-[color,background-color,transform] active:scale-[0.96]',
                      active && 'bg-muted/70',
                    )}
                    onClick={() => {
                      onValueChange(option.value);
                      setOpen(false);
                    }}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="text-foreground min-w-0 truncate text-sm font-medium">
                          {option.label}
                        </span>
                        {option.badge}
                      </span>
                      {option.description ? (
                        <span className="text-muted-foreground mt-0.5 block truncate text-xs">
                          {option.description}
                        </span>
                      ) : null}
                    </span>
                    {active ? (
                      <CheckCircleSolid className="text-kortix-green size-4 shrink-0" />
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function RepositoryPicker({
  value,
  repos,
  loading,
  disabled,
  onValueChange,
}: {
  value: string;
  repos: GitHubRepository[];
  loading: boolean;
  disabled: boolean;
  onValueChange: (value: string) => void;
}) {
  const options = useMemo(
    () =>
      repos.map((repo) => ({
        value: repo.full_name,
        label: repo.full_name,
        description: [repo.default_branch, repo.description].filter(Boolean).join(' · '),
        keywords: [repo.full_name, repo.name, repo.default_branch, repo.description ?? '']
          .join(' ')
          .toLowerCase(),
        badge: repo.private ? <Badge size="xs">Private</Badge> : undefined,
      })),
    [repos],
  );

  return (
    <SearchPicker
      value={value}
      options={options}
      loading={loading}
      disabled={disabled}
      loadingLabel="Loading repositories…"
      placeholder="Search repositories"
      searchPlaceholder="Search repositories"
      emptyLabel="No repositories found"
      icon={<Icon.Github className="size-4" />}
      onValueChange={onValueChange}
    />
  );
}

export function BranchPicker({
  value,
  branches,
  loading,
  disabled,
  onValueChange,
}: {
  value: string;
  branches: GitHubRepositoryBranch[];
  loading: boolean;
  disabled: boolean;
  onValueChange: (value: string) => void;
}) {
  const options = useMemo(
    () =>
      branches.map((branch) => ({
        value: branch.name,
        label: branch.name,
        keywords: branch.name.toLowerCase(),
        badge: branch.protected ? <Badge size="xs">Protected</Badge> : undefined,
      })),
    [branches],
  );

  return (
    <SearchPicker
      value={value}
      options={options}
      loading={loading}
      disabled={disabled}
      loadingLabel="Loading branches…"
      placeholder="Select a branch"
      searchPlaceholder="Search branches"
      emptyLabel="No branches found"
      icon={<GitBranch className="size-4" />}
      onValueChange={onValueChange}
    />
  );
}
