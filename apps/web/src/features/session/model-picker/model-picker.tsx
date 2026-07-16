'use client';

import { ChevronDown, Search, SlidersHorizontal } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  CommandGroup,
  CommandList,
  CommandPopover,
  CommandPopoverContent,
  CommandPopoverTrigger,
} from '@/components/ui/command';
import Hint from '@/components/ui/hint';
import {
  InputGroupSearch,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import { cn } from '@/lib/utils';
import type { HarnessAuthKind } from '@kortix/sdk/projects-client';
import type { ModelPickerGroup, ModelPickerViewModel } from '@kortix/sdk/react';

import {
  COMPOSER_PILL_ACTIVE_CLASS,
  COMPOSER_PILL_DISABLED_CLASS,
  COMPOSER_PILL_TRIGGER_CLASS,
} from '../composer-pill';
import { CustomModelEntry } from './custom-model-entry';
import { ModelPickerRow } from './model-picker-row';

export interface ModelPickerProps {
  vm: ModelPickerViewModel;
  onConnect: (connectionId: HarnessAuthKind) => void;
  disabled?: boolean;
  /** Optional — opens the full Models management surface. Omitted entirely
   *  (no footer rendered) when the host has no such surface to route to;
   *  this keeps the component pure-presentational (no `useModelConnectionGate`
   *  or router import inside). */
  onManageModels?: () => void;
}

function matchesQuery(query: string, ...values: Array<string | null>): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return values.some((value) => value != null && value.toLowerCase().includes(q));
}

function filterGroups(groups: ModelPickerGroup[], query: string): ModelPickerGroup[] {
  if (!query.trim()) return groups;
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => matchesQuery(query, item.label, item.sublabel)),
    }))
    .filter((group) => group.items.length > 0);
}

/**
 * The unified model-first picker — one popover for every harness. Pure
 * presentational: consumes `ModelPickerViewModel` (`useModelPicker`,
 * `@kortix/sdk/react`) and never branches on harness/policy itself — the
 * hook already folded the catalog-vs-harness fork into `vm.groups`. Every
 * group (including `not-connected`) renders through the same
 * `ModelPickerRow`; there is no separate "disconnected provider" component.
 */
export function ModelPicker({ vm, onConnect, disabled = false, onManageModels }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [customValue, setCustomValue] = useState('');

  const locked = disabled || !vm.trigger.interactive;

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (locked) return;
      setOpen(next);
      if (!next) setSearch('');
    },
    [locked],
  );

  // The custom-entry field doubles as the search query when the picker has
  // no dedicated search box (`!vm.searchable`) — typing a candidate id also
  // narrows the visible catalog (autocomplete), per the locked design.
  const query = vm.searchable ? search : customValue;
  const visibleGroups = useMemo(() => filterGroups(vm.groups, query), [vm.groups, query]);

  const handleSelect = useCallback(
    (key: string) => {
      vm.select(key);
      setOpen(false);
      setSearch('');
    },
    [vm],
  );

  const handleApplyCustom = useCallback(
    (value: string) => {
      if (!vm.customEntry?.validate(value).ok) return;
      vm.select(`custom:${value.trim()}`);
      setOpen(false);
      setCustomValue('');
    },
    [vm],
  );

  const hintLabel = vm.trigger.interactive
    ? vm.trigger.sublabel
      ? `${vm.trigger.label} — ${vm.trigger.sublabel}`
      : vm.trigger.label
    : 'Model selection is locked for this session';

  return (
    <CommandPopover open={locked ? false : open} onOpenChange={handleOpenChange}>
      <CommandPopoverTrigger>
        <button
          type="button"
          aria-disabled={locked}
          className={cn(
            COMPOSER_PILL_TRIGGER_CLASS,
            open && !locked && COMPOSER_PILL_ACTIVE_CLASS,
            locked && COMPOSER_PILL_DISABLED_CLASS,
          )}
        >
          <Hint label={hintLabel}>
            <span className="max-w-[180px] truncate">{vm.trigger.label}</span>
          </Hint>
          <ChevronDown
            className={cn(
              'size-3 opacity-50 transition-transform duration-200',
              open && !locked && 'rotate-180',
            )}
          />
        </button>
      </CommandPopoverTrigger>

      <CommandPopoverContent side="top" align="start" sideOffset={8} className="w-[300px]">
        {vm.searchable ? (
          <InputGroupSearch className="border-border/50 border-b px-3 py-1.5">
            <InputGroupSearchIcon>
              <Search />
            </InputGroupSearchIcon>
            <InputGroupSearchInput
              variant="popover"
              placeholder="Search models"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </InputGroupSearch>
        ) : null}

        <CommandList className="max-h-[380px]">
          {visibleGroups.length > 0 ? (
            visibleGroups.map((group) => (
              <CommandGroup key={group.id} heading={group.label} forceMount>
                {group.connectAction ? (
                  <div className="flex min-h-10 items-center justify-end px-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-full shrink-0 px-2.5 text-xs active:scale-[0.96]"
                      onClick={() => onConnect(group.connectAction!.connectionId)}
                    >
                      {group.connectAction.label}
                    </Button>
                  </div>
                ) : null}
                {group.items.map((item) => (
                  <ModelPickerRow
                    key={item.key}
                    item={item}
                    selected={item.key === vm.selectedKey}
                    onSelect={() => handleSelect(item.key)}
                  />
                ))}
              </CommandGroup>
            ))
          ) : (
            <div className="px-3 py-5 text-center">
              <div className="text-foreground text-sm font-medium">No models available</div>
              <p className="text-muted-foreground mx-auto mt-1 max-w-[220px] text-xs leading-5">
                Try a different search, or connect a provider to see more models.
              </p>
            </div>
          )}
        </CommandList>

        {vm.customEntry?.allowed ? (
          <CustomModelEntry
            customEntry={vm.customEntry}
            value={customValue}
            onValueChange={setCustomValue}
            onApply={handleApplyCustom}
          />
        ) : null}

        {onManageModels ? (
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onManageModels();
            }}
            className="text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04] flex min-h-10 w-full items-center gap-2 border-t px-4 py-2.5 text-xs font-medium transition-[color,background-color,transform] duration-200 active:scale-[0.96]"
          >
            <SlidersHorizontal className="size-3.5 shrink-0" />
            Manage models
          </button>
        ) : null}
      </CommandPopoverContent>
    </CommandPopover>
  );
}
