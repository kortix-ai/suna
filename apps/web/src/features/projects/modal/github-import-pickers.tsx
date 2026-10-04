'use client';

import { Badge } from '@/components/ui/badge';
import {
  InputGroupSearch,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import Loading from '@/components/ui/loading';
import { menuRow } from '@/components/ui/menu-recipe';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  TRIGGER_CARET_CLASS,
  TRIGGER_ICON_SIZE,
  triggerVariants,
} from '@/components/ui/trigger-variants';
import { Github } from '@/features/icon/icons/github';
import { cn } from '@/lib/utils';
import type { GitHubRepository, GitHubRepositoryBranch } from '@kortix/sdk';
import {
  CaretDownIcon as CaretDown,
  GitBranchIcon as GitBranch,
  MagnifyingGlassIcon as Search,
} from '@phosphor-icons/react';
import { useTranslations } from '@/i18n/use-translations';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

/** Varied so the placeholder reads as a list of names, not a barcode. */
const SKELETON_WIDTHS = ['w-3/5', 'w-2/5', 'w-1/2', 'w-3/4', 'w-1/3'];

/** Above this many options the list is fixed-height (see `SearchPicker`). */
const STEADY_LIST_THRESHOLD = 6;
/** Capped by the room actually left above the trigger, minus the search strip. */
const LIST_HEIGHT =
  'h-[min(360px,calc(var(--radix-popover-content-available-height)-3rem))]';
const LIST_MAX_HEIGHT =
  'max-h-[min(360px,calc(var(--radix-popover-content-available-height)-3rem))]';

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
  onSearchChange,
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
  onSearchChange?: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const selected = options.find((option) => option.value === value);
  /** Nothing to show yet — distinct from a refetch behind a list already on screen. */
  const firstLoad = loading && options.length === 0;
  const normalizedSearch = search.trim().toLowerCase();
  const filtered = normalizedSearch
    ? options.filter((option) => option.keywords.includes(normalizedSearch))
    : options;

  useEffect(() => {
    if (!open) {
      setSearch('');
      onSearchChange?.('');
    }
  }, [onSearchChange, open]);

  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      <PopoverTrigger asChild>
        {/* The same field trigger as every Select on the form (Git account,
            Account): surface, height, caret, and the open-state ring. Radix's
            trigger sets `aria-expanded`, `aria-controls` and `aria-haspopup`
            on this button itself. */}
        <button
          type="button"
          disabled={disabled}
          className={cn(triggerVariants({ size: 'md' }), 'w-full')}
        >
          <span className="flex min-w-0 items-center gap-2">
            {/* The icon never gives way to the spinner: swapping them left a
                blank slot, because `Loading` paints `text-background` inside
                any <button> — white on this white field. */}
            <span className="text-muted-foreground flex shrink-0 [&_svg]:size-4">{icon}</span>
            <span className={cn('min-w-0 truncate', !selected && 'text-muted-foreground')}>
              {selected?.label ?? (firstLoad ? loadingLabel : placeholder)}
            </span>
          </span>
          {/* Loading takes the caret's slot, so the row never shifts. `!` beats
              Loading's own in-button colour rule. */}
          {loading ? (
            <Loading variant="spokes" className="text-muted-foreground! size-4 shrink-0" />
          ) : (
            <CaretDown className={cn(TRIGGER_CARET_CLASS, TRIGGER_ICON_SIZE.md)} />
          )}
        </button>
      </PopoverTrigger>
      {/* Always ABOVE the trigger, never flipped. A panel above is anchored at
          its bottom edge, so if it shrank while filtering, the search box at
          its top would slide down under the eye — see `LIST_HEIGHT` below for
          how that is prevented. */}
      <PopoverContent
        side="top"
        align="start"
        avoidCollisions={false}
        className="w-[var(--radix-popover-trigger-width)] overflow-hidden p-0"
      >
        {/* No side padding: the bare search input spans the panel edge to
            edge, and its own `pl-9` keeps the text clear of the icon. */}
        <div className="border-border border-b py-1">
          <InputGroupSearch>
            <InputGroupSearchIcon>
              <Search />
            </InputGroupSearchIcon>
            {/* Bare: the rule under this strip already separates it from
                the list, so a border and a focus ring would box it twice. */}
            <InputGroupSearchInput
              size="xs"
              className="border-transparent focus:border-transparent focus:ring-0"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                onSearchChange?.(event.target.value);
              }}
              placeholder={searchPlaceholder}
              autoCapitalize="none"
              autoCorrect="off"
              autoFocus
            />
          </InputGroupSearch>
        </div>
        {firstLoad ? (
          // Skeleton rows in the real row geometry, so the list does not jump
          // when the first page lands. Not "No repositories": nothing is known
          // yet, and saying "none" before the answer is a wrong answer.
          <div aria-busy="true" className="p-1">
            {SKELETON_WIDTHS.map((width) => (
              <div key={width} className={cn(menuRow('md', 'default'), 'pointer-events-none')}>
                <span className={cn('bg-muted h-3 rounded-sm motion-safe:animate-pulse', width)} />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-muted-foreground px-3 py-6 text-center text-xs">{emptyLabel}</div>
        ) : (
          <ul
            className={cn(
              'overflow-y-auto p-1',
              // A long list keeps ONE height while filtering, so the panel —
              // and the search box on top of it — never moves. A short list
              // has nothing to jump, so it sizes to its rows.
              options.length > STEADY_LIST_THRESHOLD ? LIST_HEIGHT : LIST_MAX_HEIGHT,
            )}
          >
            {filtered.map((option) => {
              const active = option.value === value;
              return (
                <li key={option.value}>
                  {/* The menu row recipe, so these rows match every Select
                      and dropdown. The picked row wears the row's own hover
                      fill instead of a check, which leaves the right edge to
                      the badge. */}
                  <button
                    type="button"
                    aria-pressed={active}
                    className={cn(
                      menuRow('md', 'default'),
                      'text-left',
                      option.description && 'items-start',
                      active && 'bg-primary/10 text-foreground',
                    )}
                    onClick={() => {
                      onValueChange(option.value);
                      setOpen(false);
                    }}
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-foreground truncate">{option.label}</span>
                      {option.description ? (
                        <span className="text-muted-foreground truncate text-xs">
                          {option.description}
                        </span>
                      ) : null}
                    </span>
                    {option.badge ? <span className="shrink-0">{option.badge}</span> : null}
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
  onSearchChange,
}: {
  value: string;
  repos: GitHubRepository[];
  loading: boolean;
  disabled: boolean;
  onValueChange: (value: string) => void;
  onSearchChange?: (value: string) => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const options = useMemo(
    () =>
      repos.map((repo) => ({
        value: repo.full_name,
        label: repo.full_name,
        description: [repo.default_branch, repo.description].filter(Boolean).join(' · '),
        keywords: [repo.full_name, repo.name, repo.default_branch, repo.description ?? '']
          .join(' ')
          .toLowerCase(),
        badge: repo.private ? (
          <Badge size="xs">{tI18nComplete.raw('textc63eb6720c6e')}</Badge>
        ) : undefined,
      })),
    [repos, tI18nComplete],
  );

  return (
    <SearchPicker
      value={value}
      options={options}
      loading={loading}
      disabled={disabled}
      loadingLabel={tI18nComplete.raw('text460ca92c825a')}
      placeholder={tI18nComplete.raw('texta134ed6423fa')}
      searchPlaceholder={tI18nComplete.raw('texta134ed6423fa')}
      emptyLabel={tI18nComplete.raw('text94a1181cd13e')}
      icon={<Github className="size-4" />}
      onValueChange={onValueChange}
      onSearchChange={onSearchChange}
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const options = useMemo(
    () =>
      branches.map((branch) => ({
        value: branch.name,
        label: branch.name,
        keywords: branch.name.toLowerCase(),
        badge: branch.protected ? (
          <Badge size="xs">{tI18nComplete.raw('textb0ed26337336')}</Badge>
        ) : undefined,
      })),
    [branches, tI18nComplete],
  );

  return (
    <SearchPicker
      value={value}
      options={options}
      loading={loading}
      disabled={disabled}
      loadingLabel={tI18nComplete.raw('text55704e8f6004')}
      placeholder={tI18nComplete.raw('text71bf03ad1f6b')}
      searchPlaceholder={tI18nComplete.raw('text00dd9d632755')}
      emptyLabel={tI18nComplete.raw('texta4c7fa51a957')}
      icon={<GitBranch className="size-4" />}
      onValueChange={onValueChange}
    />
  );
}
