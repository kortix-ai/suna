'use client';

import { useState } from 'react';
import type { DateRange } from 'react-day-picker';

import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { IconCalendar, IconChevronDown } from '@/components/ui/kortix-icons';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export type CostRangePreset = '24h' | '7d' | '30d' | '90d' | 'custom';

export interface CostRange {
  preset: CostRangePreset;
  /** ISO 8601, UTC. Window start — inclusive. */
  from: string;
  /** ISO 8601, UTC. Window end — exclusive: bounds are always [from, to). */
  to: string;
}

const PRESET_ORDER = ['24h', '7d', '30d', '90d'] as const;

const PRESET_DAYS: Record<Exclude<CostRangePreset, 'custom'>, number> = {
  '24h': 1,
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

const PRESET_LABELS: Record<Exclude<CostRangePreset, 'custom'>, string> = {
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
};

/**
 * Resolve a preset to concrete UTC ISO bounds, anchored to `now`. Presets are
 * a UI affordance only — every cost endpoint takes just `from`/`to`, so this
 * is where a preset turns into the wire values.
 */
export function resolvePreset(
  preset: Exclude<CostRangePreset, 'custom'>,
  now: Date,
): CostRange {
  const to = now.toISOString();
  const from = new Date(now.getTime() - PRESET_DAYS[preset] * 86_400_000).toISOString();
  return { preset, from, to };
}

/**
 * Turn a calendar day selection into a half-open UTC window: `from` is the
 * start of `startDay`, `to` is the start of the day *after* `endDay`, so the
 * end day the user clicked is fully covered under `[from, to)`.
 *
 * `startDay`/`endDay` are the `Date` objects `react-day-picker` hands back —
 * local midnight on the clicked calendar day. Reading their *local* calendar
 * parts (`getFullYear`/`getMonth`/`getDate`) and rebuilding the instant with
 * `Date.UTC` is what makes the result independent of the host's timezone;
 * calling `.toISOString()` on the picked `Date` directly would instead bake
 * in the host's UTC offset (see the test file for a worked example).
 */
export function toUtcDayRange(startDay: Date, endDay: Date): CostRange {
  const from = new Date(
    Date.UTC(startDay.getFullYear(), startDay.getMonth(), startDay.getDate()),
  ).toISOString();
  const to = new Date(
    Date.UTC(endDay.getFullYear(), endDay.getMonth(), endDay.getDate() + 1),
  ).toISOString();
  return { preset: 'custom', from, to };
}

/**
 * The inverse of `toUtcDayRange`, for feeding a stored `CostRange` back into
 * `<Calendar mode="range">` on reopen. The stored bounds are UTC-midnight
 * instants; `react-day-picker` highlights by *local* calendar day. Shifting
 * the instant by milliseconds (an earlier version of this function did
 * `getTime() - 86_400_000`) only relocates the instant — it does nothing to
 * account for how a *different* host timezone reads that instant's local
 * calendar day, so it "corrects" the display for positive-UTC-offset viewers
 * by coincidence and is wrong in the opposite direction for negative-offset
 * viewers (e.g. the Americas): both bounds land a day early there.
 *
 * The fix mirrors `toUtcDayRange` with its two steps reversed: read the
 * *UTC* calendar parts off the stored instant (`getUTCFullYear`/
 * `getUTCMonth`/`getUTCDate` — always host-independent), then rebuild via
 * the *local* `Date` constructor, so the viewer's own host offset decides
 * how the resulting `Date` reads back — the same offset `react-day-picker`
 * itself will later use to highlight it. `new Date(y, m, d)` normalizes an
 * out-of-range day (`d - 1` below zero, `d + 1` past the month's end), so
 * month/year rollover needs no special-casing.
 */
export function toCalendarSelection(value: CostRange): { from: Date; to: Date } {
  const utcPartsToLocalDay = (iso: string, dayDelta = 0): Date => {
    const instant = new Date(iso);
    return new Date(
      instant.getUTCFullYear(),
      instant.getUTCMonth(),
      instant.getUTCDate() + dayDelta,
    );
  };

  // A preset's from/to are real instants (e.g. `now` minus N days), not day
  // boundaries — pass them through unadjusted. Only a custom range's bounds
  // are calendar days that need this local/UTC reconciliation; its `to` is
  // also the exclusive day-after boundary, so the last inclusive calendar
  // day the user clicked is one day earlier.
  if (value.preset !== 'custom') {
    return { from: new Date(value.from), to: new Date(value.to) };
  }
  return { from: utcPartsToLocalDay(value.from), to: utcPartsToLocalDay(value.to, -1) };
}

/**
 * The widest label `formatRangeLabel` can ever emit, used to reserve the
 * trigger's width so the control does not resize when the range changes.
 *
 * The shape is fixed: `MMM D – MMM D, YYYY`. Every `en-US` short month name is
 * three characters, the year is always four digits, and the widest day number
 * is two digits — so a two-digit/two-digit pair is the maximum at 21
 * characters. Digits are rendered `tabular-nums` on the trigger, so any
 * two-digit day is exactly as wide as `28` and this string is not merely the
 * longest, it is the widest for its digit positions.
 *
 * NOT `Dec 28, 2026 – Jan 3, 2027`: `formatRangeLabel` prints the year once,
 * after the second day, so a range spanning a year boundary is *shorter* than
 * this (`Dec 28 – Jan 3, 2027`), not longer. Sizing to the two-year shape
 * would reserve ~5 characters of permanent dead space.
 *
 * The four preset labels are all shorter (`Last 24 hours`, 13 characters), so
 * this one string governs the trigger width in every state.
 */
export const WIDEST_RANGE_LABEL = 'Dec 28 – Dec 30, 2026';

/** Human label for the trigger button: the preset name, or both dates for a custom range. */
export function formatRangeLabel(range: CostRange): string {
  if (range.preset !== 'custom') return PRESET_LABELS[range.preset];
  const from = new Date(range.from);
  // `to` is the exclusive day-after boundary (half-open [from, to)) — the
  // last inclusive calendar day the user clicked is one day earlier.
  const to = new Date(new Date(range.to).getTime() - 86_400_000);
  const day = (value: Date) =>
    value.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${day(from)} – ${day(to)}, ${to.getUTCFullYear()}`;
}

/** One click's effect on a range that is being picked. */
export type RangeDraftStep =
  | { kind: 'pending'; draft: DateRange }
  | { kind: 'complete'; from: Date; to: Date };

/**
 * What a click on `day` does, given the half-made range currently on screen.
 *
 * This deliberately ignores the range `react-day-picker` hands to `onSelect`,
 * because that value is the bug. Its `addToRange` folds the clicked day into
 * whatever is currently `selected`, and `selected` is always a *complete*
 * range here — a preset resolves to real bounds, so `from` and `to` are both
 * set before the user ever opens the calendar. Feeding a complete range in
 * takes the `from && to` branch, which returns another complete range from a
 * single click:
 *
 *   addToRange(Jul 10, { from: Jul 1, to: Jul 31 })  ->  { from: Jul 1, to: Jul 10 }
 *
 * So the first click looked finished, the picker committed and closed, and a
 * second date could never be chosen. Worse, the committed range was one the
 * user never asked for: their click became the *end* of the previous range
 * instead of the start of a new one.
 *
 * Deriving from the clicked day instead makes the two clicks explicit — the
 * first opens a range, the second closes it, in whichever order they are
 * clicked. Clicking the same day twice is a legitimate single-day range and
 * completes normally.
 */
export function nextRangeDraft(draft: DateRange | undefined, day: Date): RangeDraftStep {
  // Nothing pending — this click opens a new range rather than editing the
  // committed one.
  if (!draft?.from || draft.to) {
    return { kind: 'pending', draft: { from: day, to: undefined } };
  }

  const start = draft.from;
  return day.getTime() < start.getTime()
    ? { kind: 'complete', from: day, to: start }
    : { kind: 'complete', from: start, to: day };
}

interface DateRangePickerProps {
  value: CostRange;
  onChange: (next: CostRange) => void;
}

/**
 * The main control for all three levels of the cost explorer (project,
 * sessions, session). A Popover holding a vertical preset rail beside a range
 * Calendar; both paths resolve to concrete UTC ISO bounds before calling
 * `onChange`.
 */
export function DateRangePicker({ value, onChange }: DateRangePickerProps) {
  const [open, setOpen] = useState(false);
  // The range being picked, if the user is mid-selection. While this is set it
  // is what the calendar shows, so the first click reads as "start here"
  // instead of silently editing the committed range.
  const [draft, setDraft] = useState<DateRange | undefined>(undefined);

  const selected: DateRange = draft ?? toCalendarSelection(value);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    // Closing with only a start day chosen abandons it. Keeping it would mean
    // the next open silently treats an old click as the range's start.
    if (!next) setDraft(undefined);
  };

  const handlePresetSelect = (preset: Exclude<CostRangePreset, 'custom'>) => {
    setDraft(undefined);
    onChange(resolvePreset(preset, new Date()));
    setOpen(false);
  };

  // `range` is ignored on purpose — see `nextRangeDraft`. The clicked day is
  // the only trustworthy input react-day-picker gives us here.
  const handleCalendarSelect = (_range: DateRange | undefined, day: Date) => {
    const step = nextRangeDraft(draft, day);
    if (step.kind === 'pending') {
      setDraft(step.draft);
      return;
    }
    setDraft(undefined);
    onChange(toUtcDayRange(step.from, step.to));
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="gap-1.5 font-normal">
          <IconCalendar className="size-3.5 shrink-0" />
          {/* Width reservation, not decoration. `formatRangeLabel` swings
              between `Last 30 days` (12 characters) and a custom range's
              `Jul 1 – Jul 7, 2026` (19), so an auto-width trigger resized
              every time the range changed and jittered the control row it
              sits in.

              The two spans share one grid cell, so the column is sized by the
              wider of them — always `WIDEST_RANGE_LABEL` — and the visible
              label paints on top of it. This reserves the exact rendered width
              of the worst case in whatever font is actually applied, which a
              hand-measured `min-w-[Npx]` cannot do: that number is only right
              for the font it was measured against, and this control inherits
              the app font stack rather than pinning one.

              `tabular-nums` because the label is numeric text that changes:
              without it, a Jul 1 -> Jul 11 selection re-flows the label inside
              the reserved box even though the box itself holds still. */}
          <span className="grid text-left tabular-nums">
            <span aria-hidden="true" className="invisible col-start-1 row-start-1">
              {WIDEST_RANGE_LABEL}
            </span>
            <span className="col-start-1 row-start-1">{formatRangeLabel(value)}</span>
          </span>
          <IconChevronDown
            className={cn(
              'size-3 shrink-0 opacity-50 transition-transform duration-200 ease-out',
              open && 'rotate-180',
            )}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={8} className="w-auto p-0">
        {/* Rail beside the calendar, not a strip above it. The presets used to
            be a `flex flex-wrap` row over a fixed-width calendar, so the four
            labels wrapped into a ragged second row and the popover read as two
            stacked objects. A rail cannot wrap, and it is the conventional
            shape for this control.

            Below `sm` the rail moves above the calendar, in a fixed 2x2 grid —
            fixed columns rather than `flex-wrap`, so the arrangement is
            declared instead of falling out of whatever width the calendar
            happens to be. */}
        <div className="flex flex-col sm:flex-row">
          <div className="grid grid-cols-2 gap-1 border-b p-2 sm:w-[136px] sm:grid-cols-1 sm:content-start sm:border-r sm:border-b-0">
            {PRESET_ORDER.map((preset) => {
              const active = value.preset === preset;
              return (
                <Button
                  key={preset}
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-pressed={active}
                  className={cn(
                    'h-7 w-full justify-start px-2.5 text-xs font-normal',
                    active ? 'bg-primary/[0.06] text-foreground' : 'text-muted-foreground',
                  )}
                  onClick={() => handlePresetSelect(preset)}
                >
                  {PRESET_LABELS[preset]}
                </Button>
              );
            })}
          </div>
          <Calendar
            mode="range"
            selected={selected}
            onSelect={handleCalendarSelect}
            defaultMonth={selected.from}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
