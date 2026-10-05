'use client';

import type { CaptureDay } from '@kortix/sdk';
import { CalendarBlankIcon, CaretDownIcon } from '@phosphor-icons/react';
import { useState, type KeyboardEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';

import { durationParts, localDayOf } from '../capture-time';

/** `YYYY-MM-DDTHH:MM` in local time, for a datetime-local input. */
const toLocalInput = (ms: number) => {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
};

/**
 * The clock chip and its "Jump to" popover: an exact date and time, or one
 * click on a recorded day, which lands on that day's last recorded moment
 * (midnight would land in a gap). The playhead's day is marked.
 */
export function JumpPopover({
  T,
  days,
  bounds,
  onJump,
}: {
  T: number;
  days: readonly CaptureDay[];
  bounds: { first: number; last: number } | null;
  onJump: (at: number) => void;
}) {
  const t = useTranslations('capture.timeline');
  const tCapture = useTranslations('capture');
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [now] = useState(() => Date.now());
  const today = localDayOf(now);
  const yesterday = localDayOf(now - 86_400_000);
  const current = localDayOf(T);
  const year = new Date(now).getFullYear();

  const label = (day: string) => {
    if (day === today) return t('today');
    if (day === yesterday) return t('yesterday');
    const [y, m, d] = day.split('-').map(Number) as [number, number, number];
    const date = new Date(y, m - 1, d, 12);
    return date.toLocaleDateString(locale, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      ...(y === year ? {} : { year: 'numeric' }),
    });
  };
  const recorded = (seconds: number) => {
    const parts = durationParts(seconds);
    return parts.hours > 0
      ? tCapture('duration.hoursMinutes', parts)
      : tCapture('duration.minutes', parts);
  };
  const go = () => {
    const at = new Date(value).getTime();
    if (!Number.isNaN(at)) onJump(at);
    setOpen(false);
  };
  const onListKey = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
    const i = rows.indexOf(document.activeElement as HTMLButtonElement);
    rows[Math.max(0, Math.min(rows.length - 1, i + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setValue(toLocalInput(T));
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="gap-2 tabular-nums"
          disabled={!bounds}
          aria-label={t('jump.label')}
        >
          <CalendarBlankIcon className="size-3.5 shrink-0" />
          {new Date(T).toLocaleDateString(locale, {
            weekday: 'short',
            day: 'numeric',
            month: 'short',
            ...(new Date(T).getFullYear() === year ? {} : { year: 'numeric' }),
          })}
          <CaretDownIcon className="size-3 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-72 space-y-2 p-2">
        <label htmlFor="capture-jump-at" className="text-muted-foreground text-xs">
          {t('jump.title')}
        </label>
        <div className="flex gap-2">
          <Input
            id="capture-jump-at"
            type="datetime-local"
            value={value}
            min={bounds ? toLocalInput(bounds.first) : undefined}
            max={bounds ? toLocalInput(bounds.last) : undefined}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') go();
            }}
            className="font-mono"
          />
          <Button size="sm" onClick={go}>
            {t('jump.go')}
          </Button>
        </div>
        {days.length === 0 ? (
          <p className="text-muted-foreground px-2 py-3 text-center text-xs">{t('jump.none')}</p>
        ) : (
          <ul
            aria-label={t('recordedDays')}
            className="max-h-64 overflow-y-auto"
            onKeyDown={onListKey}
          >
            {days.map((day) => (
              <li key={day.day}>
                <button
                  type="button"
                  aria-current={day.day === current ? 'date' : undefined}
                  onClick={() => {
                    onJump(Date.parse(day.end_at));
                    setOpen(false);
                  }}
                  className={cn(
                    'hover:bg-hover flex w-full items-center justify-between gap-3 rounded-sm px-2 py-1.5 text-left text-sm transition-colors',
                    day.day === current && 'bg-active',
                  )}
                >
                  <span>{label(day.day)}</span>
                  <span className="text-muted-foreground text-xs tabular-nums">
                    {recorded(day.screen_seconds)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
