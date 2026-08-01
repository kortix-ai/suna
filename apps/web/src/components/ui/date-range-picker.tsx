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
 * `<Calendar mode="range">` on reopen. `react-day-picker` highlights by
 * *local* calendar day, so a custom range's exclusive day-after `to` bound
 * must be pulled back one day before it reaches the calendar — otherwise the
 * calendar highlights one day past what the trigger button's label says.
 * Presets are not day-boundary values (`to` is `now`, a real instant, not
 * midnight), so they pass through unadjusted — highlighting through the
 * current moment is correct there.
 */
export function toCalendarSelection(value: CostRange): { from: Date; to: Date } {
  const from = new Date(value.from);
  const to =
    value.preset === 'custom'
      ? new Date(new Date(value.to).getTime() - 86_400_000)
      : new Date(value.to);
  return { from, to };
}

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

interface DateRangePickerProps {
  value: CostRange;
  onChange: (next: CostRange) => void;
}

/**
 * The main control for all three levels of the cost explorer (project,
 * sessions, session). A Popover holding a preset row above a range Calendar;
 * both paths resolve to concrete UTC ISO bounds before calling `onChange`.
 */
export function DateRangePicker({ value, onChange }: DateRangePickerProps) {
  const [open, setOpen] = useState(false);

  const selected = toCalendarSelection(value);

  const handlePresetSelect = (preset: Exclude<CostRangePreset, 'custom'>) => {
    onChange(resolvePreset(preset, new Date()));
    setOpen(false);
  };

  const handleCalendarSelect = (range: DateRange | undefined) => {
    if (!range?.from || !range?.to) return;
    onChange(toUtcDayRange(range.from, range.to));
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="gap-1.5 font-normal">
          <IconCalendar className="size-3.5 shrink-0" />
          <span>{formatRangeLabel(value)}</span>
          <IconChevronDown
            className={cn(
              'size-3 shrink-0 opacity-50 transition-transform duration-200',
              open && 'rotate-180',
            )}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={8} className="w-auto p-0 shadow-md">
        <div className="flex flex-wrap items-center gap-1 border-b p-2">
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
                  'h-7 px-2.5 text-xs font-normal',
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
      </PopoverContent>
    </Popover>
  );
}
