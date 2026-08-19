'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ResetAxisButton } from '@/features/session/scope/session-scope-control';
import { cn } from '@/lib/utils';
import type { Icon } from '@phosphor-icons/react';
import { GearSixIcon } from '@phosphor-icons/react';
import { type ReactNode, useState } from 'react';

/**
 * One overridable axis of a session.
 *
 * `summary` is what the axis is set to RIGHT NOW, and for an axis nobody
 * touched that string names its real source (usually "Agent default" — the
 * agent's grant defines the defaults) — never "none". `overridden` is what
 * earns the badge: a session should look inherited until the user deliberately
 * takes it off the default.
 */
export interface SessionOverrideRow {
  id: string;
  name: string;
  icon: Icon;
  /** One line under the axis name in the list. */
  hint: string;
  summary: string;
  overridden?: boolean;
  /** Sentence explaining what an override on this axis does, in the detail pane. */
  description: string;
  /** The axis editor. */
  editor: ReactNode;
  /**
   * Drops the override on this axis. Rendered BESIDE the editor, so an empty
   * catalog can never hide the only way back to the default.
   */
  onReset?: () => void;
  /** Names where the default comes from — "Reset to agent default" etc. */
  resetLabel?: string;
  /** Shown instead of the editor when the axis cannot be edited here. */
  readOnly?: boolean;
}

export interface SessionOverridesControlProps {
  rows: SessionOverrideRow[];
  disabled?: boolean;
  saving?: boolean;
  saveDisabled?: boolean;
  /** Extra note above the footer — e.g. the non-retroactive secrets warning. */
  notice?: ReactNode;
  /**
   * Commits the scope draft. Resolves `true` when the save succeeded (or there
   * was nothing to write) — the popover closes on it, which is the visible
   * result of the click. Agent/model/effort apply the moment they are picked;
   * only secrets/connectors wait for Save.
   */
  onSave: () => boolean | Promise<boolean>;
}

/**
 * The session's overrides, in one place: a list of axes on the left and the
 * focused axis's editor on the right.
 *
 * The old surface was a "Scope" popover holding two collapsed accordions. It
 * hid the two axes it did cover, said nothing about the four other things a
 * session can override (agent, model, reasoning effort, sandbox), and — worst —
 * reported an inherited connector axis as "None selected", which invited the
 * user to Save an override that had never existed.
 *
 * Everything here is inherited until it is not. A row shows what it resolves to
 * today; only a deliberate change writes an override, and every writable axis
 * carries the way back to the default.
 */
export function SessionOverridesControlContent({
  rows,
  disabled = false,
  saving = false,
  saveDisabled = false,
  notice,
  onSave,
}: SessionOverridesControlProps) {
  const [focusedId, setFocusedId] = useState<string | null>(rows[0]?.id ?? null);
  const focused = rows.find((row) => row.id === focusedId) ?? rows[0];
  const controlsDisabled = disabled || saving;

  return (
    <div
      // Radix reports how much room it actually has; without this the panel is
      // taller than the gap above the composer on a short or narrow viewport and
      // its first row slides off the top of the screen.
      className="flex h-96 max-h-96 flex-col overflow-hidden"
    >
      <div className="border-border flex min-h-0 flex-1 flex-col sm:flex-row">
        <ul
          className="border-border flex max-h-[45%] shrink-0 flex-col gap-0.5 overflow-y-auto border-b p-1.5 sm:max-h-none sm:w-[212px] sm:border-r sm:border-b-0"
          aria-label="Session overrides"
        >
          {rows.map((row) => {
            const RowIcon = row.icon;
            const active = row.id === focused?.id;
            return (
              <li key={row.id}>
                <button
                  type="button"
                  aria-current={active}
                  onClick={() => setFocusedId(row.id)}
                  className={cn(
                    'flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-2 text-left',
                    'transition-colors active:scale-[0.99]',
                    active ? 'bg-primary/[0.06]' : 'hover:bg-foreground/[0.04]',
                  )}
                >
                  <RowIcon
                    className={cn(
                      'size-4 shrink-0',
                      active ? 'text-foreground' : 'text-muted-foreground',
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="text-foreground block truncate text-sm font-medium">
                      {row.name}
                    </span>
                    <span className="text-muted-foreground block truncate text-xs">
                      {row.summary}
                    </span>
                  </span>
                  {row.overridden ? (
                    <Badge variant="outline" size="xs" className="shrink-0">
                      Override
                    </Badge>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>

        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-3.5">
          {focused ? (
            <>
              <h3 className="text-foreground text-sm font-medium text-balance">{focused.name}</h3>
              <p className="text-muted-foreground mt-1 text-xs leading-relaxed text-pretty">
                {focused.description}
              </p>
              <div className="mt-3">{focused.editor}</div>
              {focused.overridden && focused.onReset ? (
                <ResetAxisButton
                  disabled={controlsDisabled}
                  onReset={focused.onReset}
                  label={focused.resetLabel}
                />
              ) : null}
            </>
          ) : null}
          {notice ? <div className="mt-3">{notice}</div> : null}
        </div>
      </div>

      <div className="border-border flex items-center justify-between gap-3 border-t px-4 py-2">
        <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
          Changes apply to the next prompt.
        </p>
        <Button
          type="button"
          disabled={controlsDisabled || saveDisabled}
          onClick={onSave}
          size="sm"
        >
          {saving ? <Loading className="size-3.5 shrink-0" /> : null}
          Save
        </Button>
      </div>
    </div>
  );
}

export function SessionOverridesControl({ onSave, ...contentProps }: SessionOverridesControlProps) {
  const [open, setOpen] = useState(false);
  // Closing the panel is the visible result of a successful Save. A failed
  // save keeps it open — the error toast plus a still-open panel says
  // "not saved" without losing the draft.
  const saveAndClose = async () => {
    const saved = await onSave();
    if (saved) setOpen(false);
    return saved;
  };
  // The trigger is an icon and nothing else, in the same muted tone as the
  // agent/model selectors beside it — the axes and their overrides live inside
  // the panel, never on the composer bar.
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={contentProps.disabled || contentProps.saving}
          aria-label="Session overrides"
          className="text-muted-foreground hover:text-foreground data-[state=open]:text-foreground"
        >
          <GearSixIcon className="size-4 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        collisionPadding={12}
        className="w-[min(620px,calc(100vw-2rem))] overflow-hidden rounded-lg p-0 shadow-none"
        // The model, agent and effort editors are themselves popovers rendered
        // into their own portal. Radix sees that portal as "outside", so an
        // unguarded interaction there closes THIS panel under the user's cursor.
        onInteractOutside={(event) => {
          const target = event.target as HTMLElement | null;
          if (target?.closest('[data-radix-popper-content-wrapper]')) event.preventDefault();
        }}
      >
        <SessionOverridesControlContent {...contentProps} onSave={saveAndClose} />
      </PopoverContent>
    </Popover>
  );
}
