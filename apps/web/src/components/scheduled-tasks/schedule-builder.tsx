"use client";

import React, { useState, useCallback, useEffect } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { FilterBar, FilterBarItem } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { ChevronDown, Clock } from 'lucide-react';

// ─── Types ──────────────────────────────────────────────────────────────────

type Frequency = 'minutes' | 'hourly' | 'daily' | 'weekly' | 'monthly';

interface ScheduleState {
  frequency: Frequency;
  interval: number;
  hour: number;
  minute: number;
  weekdays: number[];
  monthDay: number;
}

interface ScheduleBuilderProps {
  value: string;
  onChange: (cronExpr: string) => void;
  compact?: boolean;
  disabled?: boolean;
}

// ─── Cron ↔ State ───────────────────────────────────────────────────────────

const DEFAULT_STATE: ScheduleState = {
  frequency: 'daily',
  interval: 15,
  hour: 9,
  minute: 0,
  weekdays: [1, 2, 3, 4, 5],
  monthDay: 1,
};

function stateToCron(s: ScheduleState): string {
  switch (s.frequency) {
    case 'minutes':
      return `0 */${s.interval} * * * *`;
    case 'hourly':
      return `0 ${s.minute} */${s.interval} * * *`;
    case 'daily':
      return `0 ${s.minute} ${s.hour} * * *`;
    case 'weekly': {
      const days = s.weekdays.length > 0 ? s.weekdays.sort().join(',') : '*';
      return `0 ${s.minute} ${s.hour} * * ${days}`;
    }
    case 'monthly':
      return `0 ${s.minute} ${s.hour} ${s.monthDay} * *`;
    default:
      return `0 ${s.minute} ${s.hour} * * *`;
  }
}

function cronToState(expr: string): ScheduleState | null {
  try {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 6) return null;
    const [_sec, min, hour, day, _month, weekday] = parts;

    if (min.startsWith('*/') && hour === '*' && day === '*' && weekday === '*') {
      return { ...DEFAULT_STATE, frequency: 'minutes', interval: parseInt(min.slice(2)) || 15 };
    }
    if (hour.startsWith('*/') && day === '*' && weekday === '*') {
      return { ...DEFAULT_STATE, frequency: 'hourly', interval: parseInt(hour.slice(2)) || 1, minute: parseInt(min) || 0 };
    }
    if (!day.includes('*') && !day.includes('/') && weekday === '*') {
      return { ...DEFAULT_STATE, frequency: 'monthly', hour: parseInt(hour) || 9, minute: parseInt(min) || 0, monthDay: parseInt(day) || 1 };
    }
    if (day === '*' && weekday !== '*') {
      let days: number[];
      if (weekday.includes('-')) {
        const [start, end] = weekday.split('-').map(Number);
        days = [];
        for (let i = start; i <= end; i++) days.push(i);
      } else {
        days = weekday.split(',').map(Number).filter(n => !isNaN(n));
      }
      return { ...DEFAULT_STATE, frequency: 'weekly', hour: parseInt(hour) || 9, minute: parseInt(min) || 0, weekdays: days.length > 0 ? days : [1, 2, 3, 4, 5] };
    }
    if (day === '*' && weekday === '*' && !hour.includes('*') && !hour.includes('/')) {
      return { ...DEFAULT_STATE, frequency: 'daily', hour: parseInt(hour) || 9, minute: parseInt(min) || 0 };
    }
    return null;
  } catch {
    return null;
  }
}

function describeSchedule(s: ScheduleState): string {
  const time = `${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`;
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  switch (s.frequency) {
    case 'minutes':
      return `Runs every ${s.interval} minute${s.interval === 1 ? '' : 's'}`;
    case 'hourly':
      return s.interval === 1
        ? `Runs every hour at :${String(s.minute).padStart(2, '0')}`
        : `Runs every ${s.interval} hours at :${String(s.minute).padStart(2, '0')}`;
    case 'daily':
      return `Runs every day at ${time}`;
    case 'weekly': {
      if (s.weekdays.length === 0) return 'No days selected';
      if (s.weekdays.length === 7) return `Runs every day at ${time}`;
      const sorted = [...s.weekdays].sort();
      if (sorted.join(',') === '1,2,3,4,5') return `Runs weekdays at ${time}`;
      if (sorted.join(',') === '0,6') return `Runs weekends at ${time}`;
      return `Runs ${sorted.map(d => dayNames[d]).join(', ')} at ${time}`;
    }
    case 'monthly':
      return `Runs on the ${s.monthDay}${ordSuffix(s.monthDay)} of each month at ${time}`;
    default:
      return '';
  }
}

function ordSuffix(n: number): string {
  if (n >= 11 && n <= 13) return 'th';
  switch (n % 10) {
    case 1: return 'st';
    case 2: return 'nd';
    case 3: return 'rd';
    default: return 'th';
  }
}

// ─── Constants ──────────────────────────────────────────────────────────────

const FREQUENCY_TABS: { value: Frequency; label: string }[] = [
  { value: 'minutes', label: 'Minutes' },
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
];

const WEEKDAY_BUTTONS = [
  { value: 1, label: 'Mo' },
  { value: 2, label: 'Tu' },
  { value: 3, label: 'We' },
  { value: 4, label: 'Th' },
  { value: 5, label: 'Fr' },
  { value: 6, label: 'Sa' },
  { value: 0, label: 'Su' },
];

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTE_OPTIONS = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];

// ─── Component ──────────────────────────────────────────────────────────────

export function ScheduleBuilder({ value, onChange, disabled }: ScheduleBuilderProps) {
  const [state, setState] = useState<ScheduleState>(() => cronToState(value) ?? DEFAULT_STATE);
  const [showCron, setShowCron] = useState(false);
  const [rawCron, setRawCron] = useState(value);
  const [isCustom, setIsCustom] = useState(() => cronToState(value) === null);

  useEffect(() => {
    const parsed = cronToState(value);
    if (parsed) { setState(parsed); setIsCustom(false); }
    else { setIsCustom(true); }
    setRawCron(value);
  }, [value]);

  const update = useCallback((partial: Partial<ScheduleState>) => {
    setState(prev => {
      const next = { ...prev, ...partial };
      const cron = stateToCron(next);
      setRawCron(cron);
      setIsCustom(false);
      setTimeout(() => onChange(cron), 0);
      return next;
    });
  }, [onChange]);

  const onRawCronEdit = (expr: string) => {
    setRawCron(expr);
    const parsed = cronToState(expr);
    if (parsed) { setState(parsed); setIsCustom(false); }
    else { setIsCustom(true); }
    onChange(expr);
  };

  const toggleWeekday = (day: number) => {
    const next = state.weekdays.includes(day)
      ? state.weekdays.filter(d => d !== day)
      : [...state.weekdays, day];
    update({ weekdays: next });
  };

  const needsTime = state.frequency !== 'minutes';

  // ── Custom cron fallback ──

  if (isCustom) {
    return (
      <div className="rounded-xl border border-border bg-muted/20 p-4 space-y-3">
        <p className="text-sm text-muted-foreground">Custom cron expression</p>
        <Input type="text"
          value={rawCron}
          onChange={(e) => onRawCronEdit(e.target.value)}
          className="font-mono text-sm h-9"
          placeholder="0 0 9 * * *"
          disabled={disabled}
        />
        <p className="text-[11px] text-muted-foreground">
          6-field: second minute hour day month weekday
        </p>
        <Button
          type="button"
          variant="link"
          size="sm"
          onClick={() => update({ frequency: 'daily' })}
          disabled={disabled}
          className="h-auto p-0 text-xs"
        >
          Switch to visual editor
        </Button>
      </div>
    );
  }

  // ── Visual editor ──

  return (
    <div className={cn("space-y-2", disabled && "opacity-60 pointer-events-none select-none")}>
      {/* Frequency tabs */}
      <FilterBar className="w-full">
        {FREQUENCY_TABS.map(({ value: freq, label }) => (
          <FilterBarItem
            key={freq}
            onClick={() => update({ frequency: freq })}
            disabled={disabled}
            data-state={state.frequency === freq ? 'active' : 'inactive'}
            className="flex-1"
          >
            {label}
          </FilterBarItem>
        ))}
      </FilterBar>

      {/* Controls — flat layout, no extra card chrome. The frequency pills
          above already group these visually. */}
      <div className="space-y-2 px-1 pt-0.5">
        {/* Interval row — minutes & hourly */}
        {(state.frequency === 'minutes' || state.frequency === 'hourly') && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Every</span>
            <Select
              value={String(state.interval)}
              onValueChange={(v) => update({ interval: Number(v) })}
              disabled={disabled}
            >
              <SelectTrigger className="w-20 h-8 text-sm cursor-pointer hover:bg-muted/40 transition-colors">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(state.frequency === 'minutes'
                  ? [1, 2, 3, 5, 10, 15, 20, 30, 45]
                  : [1, 2, 3, 4, 6, 8, 12]
                ).map(n => (
                  <SelectItem key={n} value={String(n)} className="cursor-pointer data-[highlighted]:bg-muted/70">{n}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-sm text-muted-foreground">
              {state.frequency === 'minutes' ? 'minutes' : `hour${state.interval === 1 ? '' : 's'}`}
            </span>
          </div>
        )}

        {/* Month day row */}
        {state.frequency === 'monthly' && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">On day</span>
            <Select
              value={String(state.monthDay)}
              onValueChange={(v) => update({ monthDay: Number(v) })}
              disabled={disabled}
            >
              <SelectTrigger className="w-20 h-8 text-sm cursor-pointer hover:bg-muted/40 transition-colors">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: 31 }, (_, i) => i + 1).map(d => (
                  <SelectItem key={d} value={String(d)} className="cursor-pointer data-[highlighted]:bg-muted/70">{d}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-sm text-muted-foreground">of each month</span>
          </div>
        )}

        {/* Weekday chips */}
        {state.frequency === 'weekly' && (
          <div className="flex items-center gap-1">
            {WEEKDAY_BUTTONS.map(({ value: day, label }, idx) => (
              <Button
                key={`${day}-${idx}`}
                type="button"
                onClick={() => toggleWeekday(day)}
                disabled={disabled}
                variant={state.weekdays.includes(day) ? "default" : "outline"}
                size="sm"
                className="flex-1"
              >
                {label}
              </Button>
            ))}
          </div>
        )}

        {/* Time row */}
        {needsTime && (
          <div className="flex items-center gap-2">
            <Clock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            {state.frequency === 'hourly' ? (
              <>
                <span className="text-sm text-muted-foreground">at minute</span>
                <Select
                  value={String(state.minute)}
                  onValueChange={(v) => update({ minute: Number(v) })}
                  disabled={disabled}
                >
                  <SelectTrigger className="w-20 h-8 text-sm cursor-pointer hover:bg-muted/40 transition-colors">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MINUTE_OPTIONS.map(m => (
                      <SelectItem key={m} value={String(m)} className="cursor-pointer data-[highlighted]:bg-muted/70">
                        :{String(m).padStart(2, '0')}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </>
            ) : (
              <>
                <span className="text-sm text-muted-foreground">at</span>
                <Select
                  value={String(state.hour)}
                  onValueChange={(v) => update({ hour: Number(v) })}
                  disabled={disabled}
                >
                  <SelectTrigger className="w-20 h-8 text-sm cursor-pointer hover:bg-muted/40 transition-colors">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {HOURS.map(h => (
                      <SelectItem key={h} value={String(h)} className="cursor-pointer data-[highlighted]:bg-muted/70">
                        {String(h).padStart(2, '0')}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-sm font-medium text-muted-foreground">:</span>
                <Select
                  value={String(state.minute)}
                  onValueChange={(v) => update({ minute: Number(v) })}
                  disabled={disabled}
                >
                  <SelectTrigger className="w-20 h-8 text-sm cursor-pointer hover:bg-muted/40 transition-colors">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MINUTE_OPTIONS.map(m => (
                      <SelectItem key={m} value={String(m)} className="cursor-pointer data-[highlighted]:bg-muted/70">
                        {String(m).padStart(2, '0')}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </>
            )}
          </div>
        )}

        {/* Summary — small caption, no card divider since the wrapping
            card is gone. */}
        <p className="text-[11px] text-muted-foreground/60">
          {describeSchedule(state)}
        </p>
      </div>

      {/* Cron expression toggle */}
      <div>
        <Button
          type="button"
          variant="muted"
          size="xs"
          onClick={() => setShowCron(!showCron)}
          disabled={disabled}
        >
          <ChevronDown className={cn("h-3 w-3 transition-transform", showCron && "rotate-180")} />
          {showCron ? 'Hide' : 'Edit'} cron expression
        </Button>
        {showCron && (
          <div className="mt-2 space-y-1">
            <Input type="text"
              value={rawCron}
              onChange={(e) => onRawCronEdit(e.target.value)}
              className="font-mono text-xs h-8"
              placeholder="0 0 9 * * *"
              disabled={disabled}
            />
            <p className="text-[11px] text-muted-foreground">
              6-field: sec min hour day month weekday
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

export { describeSchedule, cronToState, stateToCron, type ScheduleState };
