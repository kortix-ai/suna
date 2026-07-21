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

/** `choiceLabel`'s raw-fallback tiers (`value`/`id`, when neither `name` nor
 *  `label` is present) can be a bare protocol token — e.g. a bare `gpt-5.4-mini`
 *  or `dontAsk`. Real captured payloads (`kortix.acp_session_envelopes`)
 *  always carry a proper `name`, so this rarely fires — it's a defensive
 *  floor, never applied to `name`/`label` themselves (those are the
 *  adapter's OWN authored display text and must render verbatim, never
 *  reformatted — inventing/adjusting a name the harness chose would be
 *  exactly the kind of untruthful enrichment this file must avoid). */
function humanizeRawToken(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function choiceLabel(choice: Record<string, unknown>): string {
  const named = choice.name ?? choice.label;
  if (named != null) return String(named);
  const raw = choice.value ?? choice.id;
  return raw != null ? humanizeRawToken(String(raw)) : '';
}

/** Secondary detail line for a choice, when the adapter sends one — e.g.
 *  claude-agent-acp's real `model` choices ("Sonnet 5 · Efficient for
 *  routine tasks · $3/$15 per Mtok") and `mode` choices ("Standard behavior,
 *  prompts for dangerous operations"), verified live
 *  (`kortix.acp_session_envelopes`, local DB, 2026-07-22). Previously
 *  fetched over the wire and silently dropped — `choiceLabel` only ever read
 *  `name`. `null` when the choice carries none (e.g. claude's `effort`
 *  choices), so the popover row falls back to its single-line layout. */
function choiceDescription(choice: Record<string, unknown>): string | null {
  const description = choice.description;
  return typeof description === 'string' && description.length > 0 ? description : null;
}

/**
 * De-duplicates a choice list by its EFFECTIVE selectable value
 * (`value ?? id`), first occurrence wins — a choice with neither is never
 * deduped against another (nothing meaningful to compare; each renders under
 * its own positional key instead, same as `choiceValue`'s own index
 * fallback).
 *
 * *** BUG THIS FIXES *** (real captured payload, `kortix.acp_session_envelopes`,
 * local DB, 2026-07-22, session `feb77a68-3f5a-4fef-b727-876aec4a1457`):
 * claude-agent-acp's real `model` config option sometimes advertises a 5th
 * choice — `{name: "default", value: "default", description: "Custom
 * model"}` — that collides with the FIRST choice's `value: "default"`
 * ("Default (recommended)"). This is the adapter's own payload, not a bug in
 * how this app merges/caches it (there is no cache-vs-fallback merge in this
 * path at all — `resolveHarnessModelOption` returns EITHER the cache OR the
 * fallback, never both). React key-clashed on the shared `key={value}`
 * (`Encountered two children with the same key, "default"`), and the raw
 * lowercase "default" second entry read as a stray, unlabeled duplicate.
 * Dropping the SECOND occurrence loses nothing functionally: two choices
 * sharing one `value` are indistinguishable once selected — `onChange(value)`
 * sends the identical `configId`/`value` pair to the harness either way, so
 * there was never a way to tell which one the user meant.
 */
export function dedupeConfigChoices<T extends Record<string, unknown>>(choices: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const choice of choices) {
    const key = choice.value != null ? String(choice.value) : choice.id != null ? String(choice.id) : null;
    if (key !== null) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(choice);
  }
  return out;
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
  // See `dedupeConfigChoices`'s doc comment — the harness's own advertised
  // list can contain a genuine value collision (verified live); the popover
  // (`choices.map` below, keyed by `value`) must never render two entries
  // under the same React key.
  const choices = dedupeConfigChoices(option.options ?? []);
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
              const description = choiceDescription(choice);
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
                  {description ? (
                    <div className="min-w-0 flex-1 py-0.5">
                      <div className="truncate text-sm leading-tight">{label}</div>
                      <p className="text-muted-foreground/70 mt-0.5 truncate text-xs leading-snug">
                        {description}
                      </p>
                    </div>
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
                  )}
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
  // See `dedupeConfigChoices`'s doc comment on the pill above — same
  // duplicate-value hazard applies here (`choices.map` below is also keyed
  // by `value`).
  const choices = dedupeConfigChoices(option.options ?? []);
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
