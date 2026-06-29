'use client';

import { CalendarClock, ChevronDown, Clock } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { errorToast, warningToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

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
  allowOnce?: boolean;
  runAt?: string | null;
  onRunAtChange?: (iso: string | null) => void;
}

const DEFAULT_STATE: ScheduleState = {
  frequency: 'daily',
  interval: 15,
  hour: 9,
  minute: 0,
  weekdays: [1, 2, 3, 4, 5],
  monthDay: 1,
};

const WEEKDAY_BUTTONS = [
  { value: 1, label: 'Mo' },
  { value: 2, label: 'Tu' },
  { value: 3, label: 'We' },
  { value: 4, label: 'Th' },
  { value: 5, label: 'Fr' },
  { value: 6, label: 'Sa' },
  { value: 0, label: 'Su' },
];

const HOURS = Array.from({ length: 24 }, (_, index) => index);
const MINUTE_OPTIONS = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];

type Cadence = 'minutes' | 'hourly' | 'daily' | 'weekdays' | 'weekends' | 'weekly' | 'monthly';

const CADENCES: { value: Cadence; label: string }[] = [
  { value: 'minutes', label: 'Every few minutes' },
  { value: 'hourly', label: 'Every few hours' },
  { value: 'daily', label: 'Every day' },
  { value: 'weekdays', label: 'Weekdays' },
  { value: 'weekends', label: 'Weekends' },
  { value: 'weekly', label: 'Custom days' },
  { value: 'monthly', label: 'Every month' },
];

function stateToCron(state: ScheduleState): string {
  switch (state.frequency) {
    case 'minutes':
      return `0 */${state.interval} * * * *`;
    case 'hourly':
      return `0 ${state.minute} */${state.interval} * * *`;
    case 'daily':
      return `0 ${state.minute} ${state.hour} * * *`;
    case 'weekly':
      return `0 ${state.minute} ${state.hour} * * ${[...state.weekdays].sort().join(',')}`;
    case 'monthly':
      return `0 ${state.minute} ${state.hour} ${state.monthDay} * *`;
  }
}

function cronToState(expression: string): ScheduleState | null {
  try {
    const parts = expression.trim().split(/\s+/);
    if (parts.length !== 6) return null;

    const [, minute, hour, day, , weekday] = parts;
    if (minute.startsWith('*/') && hour === '*' && day === '*' && weekday === '*') {
      return {
        ...DEFAULT_STATE,
        frequency: 'minutes',
        interval: Number.parseInt(minute.slice(2), 10) || 15,
      };
    }
    if (hour.startsWith('*/') && day === '*' && weekday === '*') {
      return {
        ...DEFAULT_STATE,
        frequency: 'hourly',
        interval: Number.parseInt(hour.slice(2), 10) || 1,
        minute: Number.parseInt(minute, 10) || 0,
      };
    }
    if (day !== '*' && !day.includes('/') && weekday === '*') {
      return {
        ...DEFAULT_STATE,
        frequency: 'monthly',
        hour: Number.parseInt(hour, 10) || 9,
        minute: Number.parseInt(minute, 10) || 0,
        monthDay: Number.parseInt(day, 10) || 1,
      };
    }
    if (day === '*' && weekday !== '*') {
      const weekdays = weekday.includes('-')
        ? Array.from(
            { length: Number(weekday.split('-')[1]) - Number(weekday.split('-')[0]) + 1 },
            (_, index) => Number(weekday.split('-')[0]) + index,
          )
        : weekday.split(',').map(Number).filter(Number.isFinite);
      if (weekdays.length === 0) return null;
      return {
        ...DEFAULT_STATE,
        frequency: 'weekly',
        hour: Number.parseInt(hour, 10) || 9,
        minute: Number.parseInt(minute, 10) || 0,
        weekdays,
      };
    }
    if (day === '*' && weekday === '*' && !hour.includes('*') && !hour.includes('/')) {
      return {
        ...DEFAULT_STATE,
        frequency: 'daily',
        hour: Number.parseInt(hour, 10) || 9,
        minute: Number.parseInt(minute, 10) || 0,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function ordinal(value: number): string {
  if (value >= 11 && value <= 13) return 'th';
  return value % 10 === 1 ? 'st' : value % 10 === 2 ? 'nd' : value % 10 === 3 ? 'rd' : 'th';
}

function describeSchedule(state: ScheduleState): string {
  const time = `${String(state.hour).padStart(2, '0')}:${String(state.minute).padStart(2, '0')}`;
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  switch (state.frequency) {
    case 'minutes':
      return `Runs every ${state.interval} minute${state.interval === 1 ? '' : 's'}`;
    case 'hourly':
      return state.interval === 1
        ? `Runs every hour at :${String(state.minute).padStart(2, '0')}`
        : `Runs every ${state.interval} hours at :${String(state.minute).padStart(2, '0')}`;
    case 'daily':
      return `Runs every day at ${time}`;
    case 'weekly': {
      const sorted = [...state.weekdays].sort();
      if (sorted.join(',') === '1,2,3,4,5') return `Runs weekdays at ${time}`;
      if (sorted.join(',') === '0,6') return `Runs weekends at ${time}`;
      if (sorted.length === 7) return `Runs every day at ${time}`;
      return `Runs ${sorted.map((day) => names[day]).join(', ')} at ${time}`;
    }
    case 'monthly':
      return `Runs on the ${state.monthDay}${ordinal(state.monthDay)} of each month at ${time}`;
  }
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function isoToLocalInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function localInputToIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function defaultRunAtIso(): string {
  const date = new Date();
  date.setHours(date.getHours() + 1, 0, 0, 0);
  return date.toISOString();
}

function describeRunAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Pick a date and time';
  const formatted = date.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  return date.getTime() <= Date.now() ? `${formatted} is in the past` : `Runs once on ${formatted}`;
}

function cadenceFor(state: ScheduleState): Cadence {
  if (state.frequency !== 'weekly') return state.frequency;
  const weekdays = [...state.weekdays].sort().join(',');
  if (weekdays === '1,2,3,4,5') return 'weekdays';
  if (weekdays === '0,6') return 'weekends';
  return 'weekly';
}

export function ScheduleBuilder({
  value,
  onChange,
  compact = false,
  disabled,
  allowOnce,
  runAt,
  onRunAtChange,
}: ScheduleBuilderProps) {
  const [state, setState] = useState<ScheduleState>(() => cronToState(value) ?? DEFAULT_STATE);
  const [showCron, setShowCron] = useState(() => cronToState(value) === null);
  const [rawCron, setRawCron] = useState(value);
  const [cronError, setCronError] = useState<string | null>(null);

  const onceMode = Boolean(allowOnce && onRunAtChange && runAt != null);
  const isCustom = cronToState(rawCron) === null;
  const hasPastRunAt = Boolean(runAt && new Date(runAt).getTime() <= Date.now());

  useEffect(() => {
    const parsed = cronToState(value);
    if (parsed) setState(parsed);
    setRawCron(value);
    setShowCron((visible) => visible || !parsed);
  }, [value]);

  const update = useCallback(
    (partial: Partial<ScheduleState>) => {
      const next = { ...state, ...partial };
      setState(next);
      const cron = stateToCron(next);
      setRawCron(cron);
      setCronError(null);
      onChange(cron);
    },
    [onChange, state],
  );

  const selectCadence = (cadence: Cadence) => {
    const presets: Record<Cadence, Partial<ScheduleState>> = {
      minutes: { frequency: 'minutes' },
      hourly: { frequency: 'hourly' },
      daily: { frequency: 'daily' },
      weekdays: { frequency: 'weekly', weekdays: [1, 2, 3, 4, 5] },
      weekends: { frequency: 'weekly', weekdays: [0, 6] },
      weekly: { frequency: 'weekly' },
      monthly: { frequency: 'monthly' },
    };
    onRunAtChange?.(null);
    update(presets[cadence]);
  };

  const selectOnce = () => onRunAtChange?.(runAt ?? defaultRunAtIso());

  const toggleWeekday = (day: number) => {
    const weekdays = state.weekdays.includes(day)
      ? state.weekdays.filter((value) => value !== day)
      : [...state.weekdays, day];
    if (weekdays.length === 0) {
      warningToast('Select at least one day');
      return;
    }
    update({ weekdays });
  };

  const onRawCronEdit = (expression: string) => {
    setRawCron(expression);
    const parsed = cronToState(expression);
    if (parsed) {
      setState(parsed);
      setCronError(null);
    }
    onChange(expression);
  };

  const validateRawCron = () => {
    if (!isCustom) {
      setCronError(null);
      return;
    }
    const message = 'Use a supported six-field cron expression.';
    setCronError(message);
    errorToast('Check the cron expression', { description: message });
  };

  const needsTime = state.frequency !== 'minutes';
  const cadence = cadenceFor(state);

  return (
    <div
      className={cn(
        'space-y-3',
        compact && 'space-y-2',
        disabled && 'pointer-events-none opacity-60 select-none',
      )}
    >
      {allowOnce && onRunAtChange ? (
        <Tabs
          value={onceMode ? 'once' : 'recurring'}
          onValueChange={(mode) => (mode === 'once' ? selectOnce() : onRunAtChange(null))}
        >
          <TabsList size="sm" className="w-full sm:w-fit">
            <TabsTrigger value="recurring" className="min-w-24">
              Repeats
            </TabsTrigger>
            <TabsTrigger value="once" className="min-w-24">
              Once
            </TabsTrigger>
          </TabsList>

          <TabsContent value="once" className="mt-3 space-y-2">
            <label className="text-foreground flex flex-col gap-2 text-sm font-medium sm:flex-row sm:items-center">
              <span className="text-muted-foreground flex items-center gap-2">
                <CalendarClock className="size-4" />
                Run at
              </span>
              <Input
                type="datetime-local"
                value={runAt ? isoToLocalInput(runAt) : ''}
                min={isoToLocalInput(new Date().toISOString())}
                onChange={(event) => onRunAtChange(localInputToIso(event.target.value))}
                onBlur={() => {
                  if (hasPastRunAt) warningToast('Choose a future time');
                }}
                aria-invalid={hasPastRunAt}
                className="h-9 w-full sm:w-auto"
                disabled={disabled}
              />
            </label>
            <SchedulePreview
              text={runAt ? describeRunAt(runAt) : 'Pick a date and time'}
              error={hasPastRunAt}
            />
          </TabsContent>

          <TabsContent value="recurring" className="mt-3">
            <RecurringControls
              state={state}
              cadence={cadence}
              compact={compact}
              disabled={disabled}
              needsTime={needsTime}
              previewText={isCustom ? 'Custom cron expression' : undefined}
              onCadenceChange={selectCadence}
              onUpdate={update}
              onToggleWeekday={toggleWeekday}
            />
          </TabsContent>
        </Tabs>
      ) : (
        <RecurringControls
          state={state}
          cadence={cadence}
          compact={compact}
          disabled={disabled}
          needsTime={needsTime}
          previewText={isCustom ? 'Custom cron expression' : undefined}
          onCadenceChange={selectCadence}
          onUpdate={update}
          onToggleWeekday={toggleWeekday}
        />
      )}

      {!onceMode && (
        <div className="space-y-2">
          <Button
            type="button"
            variant="text"
            size="xs"
            onClick={() => setShowCron((visible) => !visible)}
            disabled={disabled}
            className="transition-transform active:scale-[0.96]"
          >
            <ChevronDown
              className={cn('size-3 transition-transform duration-150', showCron && 'rotate-180')}
            />
            {showCron ? 'Hide cron expression' : 'Use cron expression'}
          </Button>

          {showCron && (
            <div className="space-y-1.5">
              <label
                className="text-foreground text-sm font-medium"
                htmlFor="schedule-cron-expression"
              >
                Advanced cron expression
              </label>
              <Input
                id="schedule-cron-expression"
                type="text"
                value={rawCron}
                onChange={(event) => onRawCronEdit(event.target.value)}
                onBlur={validateRawCron}
                aria-invalid={Boolean(cronError)}
                className="h-9 font-mono text-sm"
                placeholder="0 0 9 * * *"
                disabled={disabled}
              />
              <p className={cn('text-muted-foreground text-xs', cronError && 'text-destructive')}>
                {cronError ??
                  (isCustom
                    ? 'The visual editor will stay available for supported schedules.'
                    : 'Six fields: second, minute, hour, day, month, weekday.')}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface RecurringControlsProps {
  state: ScheduleState;
  cadence: Cadence;
  compact: boolean;
  disabled?: boolean;
  needsTime: boolean;
  previewText?: string;
  onCadenceChange: (cadence: Cadence) => void;
  onUpdate: (partial: Partial<ScheduleState>) => void;
  onToggleWeekday: (day: number) => void;
}

function RecurringControls({
  state,
  cadence,
  compact,
  disabled,
  needsTime,
  previewText,
  onCadenceChange,
  onUpdate,
  onToggleWeekday,
}: RecurringControlsProps) {
  return (
    <div className={cn('space-y-3', compact && 'space-y-2')}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Repeat</span>
        <Select
          value={cadence}
          onValueChange={(value) => onCadenceChange(value as Cadence)}
          disabled={disabled}
        >
          <SelectTrigger className="h-9 min-w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CADENCES.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {(state.frequency === 'minutes' || state.frequency === 'hourly') && (
          <>
            <Select
              value={String(state.interval)}
              onValueChange={(value) => onUpdate({ interval: Number(value) })}
              disabled={disabled}
            >
              <SelectTrigger className="h-9 w-18">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(state.frequency === 'minutes'
                  ? [1, 2, 3, 5, 10, 15, 20, 30, 45]
                  : [1, 2, 3, 4, 6, 8, 12]
                ).map((value) => (
                  <SelectItem key={value} value={String(value)}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-muted-foreground">
              {state.frequency === 'minutes' ? 'minutes' : `hour${state.interval === 1 ? '' : 's'}`}
            </span>
          </>
        )}

        {state.frequency === 'monthly' && (
          <>
            <span className="text-muted-foreground">on day</span>
            <Select
              value={String(state.monthDay)}
              onValueChange={(value) => onUpdate({ monthDay: Number(value) })}
              disabled={disabled}
            >
              <SelectTrigger className="h-9 w-18">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: 31 }, (_, index) => index + 1).map((value) => (
                  <SelectItem key={value} value={String(value)}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        )}
      </div>

      {cadence === 'weekly' && (
        <div className="flex flex-wrap gap-1.5" aria-label="Days to run">
          {WEEKDAY_BUTTONS.map(({ value, label }) => {
            const selected = state.weekdays.includes(value);
            return (
              <Button
                key={value}
                type="button"
                variant={selected ? 'secondary' : 'outline'}
                size="sm"
                aria-pressed={selected}
                onClick={() => onToggleWeekday(value)}
                disabled={disabled}
                className="min-w-10 transition-transform active:scale-[0.96]"
              >
                {label}
              </Button>
            );
          })}
        </div>
      )}

      {needsTime && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Clock className="text-muted-foreground size-4" />
          <span className="text-muted-foreground">
            {state.frequency === 'hourly' ? 'at minute' : 'at'}
          </span>
          {state.frequency !== 'hourly' && (
            <Select
              value={String(state.hour)}
              onValueChange={(value) => onUpdate({ hour: Number(value) })}
              disabled={disabled}
            >
              <SelectTrigger className="h-9 w-18">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {HOURS.map((value) => (
                  <SelectItem key={value} value={String(value)}>
                    {String(value).padStart(2, '0')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {state.frequency !== 'hourly' && (
            <span className="text-muted-foreground font-medium">:</span>
          )}
          <Select
            value={String(state.minute)}
            onValueChange={(value) => onUpdate({ minute: Number(value) })}
            disabled={disabled}
          >
            <SelectTrigger className="h-9 w-18">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MINUTE_OPTIONS.map((value) => (
                <SelectItem key={value} value={String(value)}>
                  {state.frequency === 'hourly'
                    ? `:${String(value).padStart(2, '0')}`
                    : String(value).padStart(2, '0')}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <SchedulePreview text={previewText ?? describeSchedule(state)} />
    </div>
  );
}

function SchedulePreview({ text, error = false }: { text: string; error?: boolean }) {
  return (
    <p
      className={cn(
        'text-muted-foreground flex items-center gap-2 text-xs tabular-nums',
        error && 'text-destructive',
      )}
    >
      <CalendarClock className="size-3.5 shrink-0" />
      {text}
    </p>
  );
}

export { cronToState, describeSchedule, stateToCron, type ScheduleState };
