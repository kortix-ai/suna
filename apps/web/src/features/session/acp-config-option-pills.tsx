'use client';

import { useEffect, useRef, useState } from 'react';

import {
  CommandGroup,
  CommandItem,
  CommandList,
  CommandPopover,
  CommandPopoverContent,
  CommandPopoverTrigger,
} from '@/components/ui/command';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import { Tabs, TabsListCompact, TabsTriggerCompact } from '@/components/ui/tabs';
import { errorToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import type { AcpSessionConfigOption } from '@kortix/sdk';
import { Check, ChevronDown } from 'lucide-react';

import {
  COMPOSER_PILL_ACTIVE_CLASS,
  COMPOSER_PILL_DISABLED_CLASS,
  COMPOSER_PILL_TRIGGER_CLASS,
} from './composer-pill';

function choiceValue(choice: Record<string, unknown>, index: number): string {
  return String(choice.value ?? choice.id ?? index);
}

function choiceLabel(choice: Record<string, unknown>): string {
  return String(choice.name ?? choice.label ?? choice.value ?? choice.id ?? '');
}

/** A single non-model, `select`-typed ACP session config option, rendered in
 *  the composer's bottom toolbar with the same pill affordance as the
 *  model/agent selectors (rounded-full trigger, popover select). Grafted
 *  from main (merge policy P1), moved out of `acp-session-chat.tsx` onto the
 *  shared pill constants (Task 22) — behavior is unchanged. */
export function AcpConfigOptionPill({
  option,
  onChange,
  disabled = false,
}: {
  option: AcpSessionConfigOption;
  onChange: (value: unknown) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const choices = option.options ?? [];
  if (choices.length === 0) return null;
  const currentRaw = option.currentValue;
  const currentChoice = choices.find(
    (choice, index) => choiceValue(choice, index) === String(currentRaw ?? ''),
  );
  // The pill must never render blank (2026-07-22): a caller that genuinely
  // has no explicit `currentValue` yet (e.g. the pre-session harness-native
  // model selector before any pick has been made — see
  // `HarnessManagedModelState`'s doc comment) still has SOMETHING to show —
  // the harness's own first advertised choice, which live evidence
  // (`kortix.acp_session_envelopes`, local DB, 2026-07-22) shows is exactly
  // what a fresh claude-agent-acp/codex-acp session's own `currentValue`
  // settles on with no override. Only an option with zero choices (already
  // handled above) has truly nothing to fall back to.
  const currentLabel = currentChoice
    ? choiceLabel(currentChoice)
    : currentRaw != null
      ? String(currentRaw)
      : choiceLabel(choices[0] as Record<string, unknown>);

  const trigger = (
    <button
      type="button"
      data-testid="acp-config-option-pill"
      data-option-id={option.id}
      aria-disabled={disabled || undefined}
      className={cn(
        COMPOSER_PILL_TRIGGER_CLASS,
        open && COMPOSER_PILL_ACTIVE_CLASS,
        disabled && COMPOSER_PILL_DISABLED_CLASS,
      )}
    >
      <span className="max-w-[140px] truncate">
        {currentLabel ? <span className="text-muted-foreground/70">{currentLabel}</span> : null}
      </span>
      <ChevronDown
        className={cn(
          'size-3 shrink-0 opacity-50 transition-transform duration-200',
          open && 'rotate-180',
        )}
      />
    </button>
  );

  return (
    <CommandPopover open={open && !disabled} onOpenChange={(next) => setOpen(disabled ? false : next)}>
      <CommandPopoverTrigger>
        {disabled ? (
          <Hint side="top" label="Not available right now" className="text-xs">
            {trigger}
          </Hint>
        ) : (
          trigger
        )}
      </CommandPopoverTrigger>
      <CommandPopoverContent side="top" align="start" sideOffset={8} className="w-[260px]">
        <CommandList className="max-h-[280px]">
          <CommandGroup heading={option.name ?? option.id} forceMount>
            {choices.map((choice, index) => {
              const value = choiceValue(choice, index);
              const label = choiceLabel(choice);
              const selected = value === String(currentRaw ?? '');
              return (
                <CommandItem
                  key={value}
                  value={label}
                  className={selected ? 'bg-primary/[0.06]' : undefined}
                  onSelect={() => {
                    onChange(value);
                    setOpen(false);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
                  {selected ? <Check className="text-foreground size-4 shrink-0" /> : null}
                </CommandItem>
              );
            })}
          </CommandGroup>
        </CommandList>
      </CommandPopoverContent>
    </CommandPopover>
  );
}

/** A single `mode`-typed ACP session config option, rendered as a compact
 *  segmented control (`TabsListCompact`/`TabsTriggerCompact`, the design
 *  system's filter-tab primitive) on the same `h-8` baseline every other
 *  composer toolbar pill uses — B1 (2026-07-14 hardening design) calls for a
 *  segmented control rather than a popover here: a mode's few,
 *  mutually-exclusive choices read better as always-visible tabs than as a
 *  hidden list.
 *
 *  `setConfigOption` in flight (per B1): the clicked choice becomes the
 *  active tab immediately (optimistic), a `Loading` spinner sits beside the
 *  control while the request is outstanding, and every trigger disables for
 *  that window so a second click can't race the first. On success the
 *  optimistic value is released once `option.currentValue` itself catches up
 *  (avoids a flash back to the old value if the prop update lags a tick). On
 *  failure the optimistic value reverts and `errorToast` explains it — the
 *  control never gets stuck showing a choice that didn't actually take.
 *
 *  The authoritative `currentValue` always wins the moment it CHANGES, not
 *  only when it happens to catch up to the optimistic pick: `optimisticBaseRef`
 *  remembers the `currentValue` the in-flight pick was made against, and the
 *  reconciliation effect clears the optimistic value as soon as `currentValue`
 *  moves away from that baseline — whether that's the pick actually landing,
 *  or a third value arriving mid-flight (an external change, or a harness
 *  that doesn't echo the pick back verbatim). Without this, a mid-flight
 *  external update would leave the control stuck showing the user's stale
 *  pick forever. */
export function AcpConfigOptionSegment({
  option,
  onChange,
  disabled = false,
}: {
  option: AcpSessionConfigOption;
  onChange: (value: unknown) => Promise<unknown> | unknown;
  disabled?: boolean;
}) {
  const choices = option.options ?? [];
  const currentValue = String(option.currentValue ?? '');
  const [optimisticValue, setOptimisticValue] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const activeValue = optimisticValue ?? currentValue;

  // The `currentValue` in effect the moment the optimistic pick was made —
  // updated on every settle below, so it always reflects "the baseline the
  // in-flight pick is relative to". Any move away from it (success OR a
  // third value arriving mid-flight) means the authoritative value should
  // take over immediately.
  const optimisticBaseRef = useRef(currentValue);

  useEffect(() => {
    if (optimisticValue !== null && currentValue !== optimisticBaseRef.current) {
      setOptimisticValue(null);
    }
    optimisticBaseRef.current = currentValue;
  }, [currentValue, optimisticValue]);

  if (choices.length === 0) return null;

  const handleSelect = (value: string) => {
    if (disabled || isPending || value === activeValue) return;
    setOptimisticValue(value);
    setIsPending(true);
    Promise.resolve()
      .then(() => onChange(value))
      .catch(() => {
        setOptimisticValue(null);
        errorToast(`Couldn't change ${option.name ?? option.id}. Try again.`);
      })
      .finally(() => setIsPending(false));
  };

  const segmentedControl = (
    <Tabs value={activeValue} onValueChange={handleSelect}>
      <TabsListCompact
        className={cn('h-8', disabled && COMPOSER_PILL_DISABLED_CLASS)}
        data-testid="acp-config-option-segment"
        data-option-id={option.id}
      >
        {choices.map((choice, index) => {
          const value = choiceValue(choice, index);
          return (
            <TabsTriggerCompact
              key={value}
              value={value}
              disabled={disabled || isPending}
              className={cn(disabled && 'cursor-not-allowed')}
            >
              {choiceLabel(choice)}
            </TabsTriggerCompact>
          );
        })}
      </TabsListCompact>
    </Tabs>
  );

  return (
    <div className="flex items-center gap-1.5">
      {disabled ? (
        <Hint side="top" label="Not available right now" className="text-xs">
          {segmentedControl}
        </Hint>
      ) : (
        segmentedControl
      )}
      {isPending ? (
        <span data-testid="acp-config-option-segment-loading">
          <Loading className="size-3 shrink-0" />
        </span>
      ) : null}
    </div>
  );
}
