/**
 * The settings row — a label on the left, its control on the right, stacked
 * with siblings inside one bordered group.
 *
 * **Why this exists.** Kortix settings panes stacked vertically: a section
 * header, then its control underneath, then a gap, then the next header. That
 * reads as a series of small announcements and makes even a three-field form
 * feel long. Linear's settings — the reference Jay asked for — put the label
 * and its control on ONE line, and group consecutive rows inside a single
 * bordered box separated by hairlines. The eye scans one left-hand column of
 * labels and one right-hand column of controls, so a form is read in two
 * glances instead of six.
 *
 * **Why it is a group, not a bordered row.** The codebase already had the row
 * itself — `Field orientation="horizontal"` — and it was being used with
 * `variant="outline"`, giving every row its own border. Ten settings then read
 * as ten separate cards. The missing piece was never the row; it was the
 * container that lets rows share one border and one rhythm. So `SettingsRow`
 * is a thin arrangement over `Field`'s existing horizontal orientation and its
 * border-less `default` variant, not a reimplementation of it.
 *
 * ```tsx
 * <SettingsRowGroup>
 *   <SettingsRow label="Full name">
 *     <Input className="h-8 w-56" value={name} onChange={…} />
 *   </SettingsRow>
 *   <SettingsRow label="Username" description="One word, like a nickname.">
 *     <Input className="h-8 w-56" value={handle} onChange={…} />
 *   </SettingsRow>
 * </SettingsRowGroup>
 * ```
 */

import * as React from 'react';

import { Field, FieldContent, FieldDescription, FieldTitle } from '@/components/ui/field';
import { cn } from '@/lib/utils';

/**
 * The bordered container. Consecutive rows share one border and are separated
 * by hairlines rather than gaps — `divide-y` rather than `space-y`, which is
 * the whole visual difference between "a grouped form" and "a stack of cards".
 *
 * Flat with a border and no shadow, per the design system: elevation belongs
 * to overlays, and this sits in the page flow.
 */
export function SettingsRowGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="settings-row-group"
      className={cn(
        'bg-popover divide-border divide-y overflow-hidden rounded-md border',
        className,
      )}
      {...props}
    />
  );
}

export interface SettingsRowProps extends Omit<React.ComponentProps<'div'>, 'title'> {
  /** The left-hand label. Sentence case, no trailing colon. */
  label: React.ReactNode;
  /** Optional second line under the label, for the rule that is not obvious. */
  description?: React.ReactNode;
  /**
   * The control. Kept `shrink-0` so a long label wraps rather than squeezing
   * an input — the control's width is deliberate, the label's is not.
   */
  children?: React.ReactNode;
}

export function SettingsRow({
  label,
  description,
  children,
  className,
  ...props
}: SettingsRowProps) {
  return (
    <Field
      orientation="horizontal"
      // The control is ALWAYS vertically centred against the label block —
      // with a description or without one. (Jay, 2026-08-12: "I want it to be
      // coming always in the centre.")
      //
      // This row used to top-align whenever a description was present, on the
      // theory that a control should meet the first line of a two-line label.
      // In practice it reads as a control that slipped upward: the right-hand
      // column stops being a column, because a `h-8` input sits at a different
      // height in every row depending on whether that row's description
      // happened to wrap. Centring restores the single scannable right-hand
      // edge that is the whole point of the grouped-row shape.
      //
      // `!items-center` is required, not stylistic. `Field`'s horizontal
      // variant carries `has-[>[data-slot=field-content]]:items-start`
      // (`field.tsx:64`), and this row ALWAYS renders a `FieldContent` — so
      // that rule always matches, and at specificity (0,2,0) it beats a plain
      // `items-center` (0,1,0). Without the important flag the variant wins and
      // every control top-aligns regardless of what is passed here.
      className={cn('gap-4 px-4 py-3 !items-center', className)}
      {...props}
    >
      <FieldContent className="min-w-0 flex-1 gap-0">
        <FieldTitle className="text-foreground text-sm font-medium">{label}</FieldTitle>
        {description ? (
          <FieldDescription className="text-muted-foreground text-xs leading-normal text-balance">
            {description}
          </FieldDescription>
        ) : null}
      </FieldContent>
      {children ? (
        <div className="flex shrink-0 items-center justify-end gap-2">{children}</div>
      ) : null}
    </Field>
  );
}
