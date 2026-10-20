'use client';

import { CalendarDotsIcon as CalendarClock, CaretDownIcon as ChevronDown } from '@phosphor-icons/react';
import { useTranslations } from '../../../i18n';
import { type ReactNode, useCallback, useEffect, useState } from 'react';

import { Button } from '../../../primitives/button';
import { Input } from '../../../primitives/input';
import { Label } from '../../../primitives/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../primitives/select';
import { errorToast, warningToast } from '../../../primitives/toast';
import { APP_REGISTRY_TRANSLATION_KEYS } from '../../../i18n/ui-catalog/app-registry-translation-keys.generated';
import { localizeUiCatalog } from '../../../i18n/ui-catalog/localize-ui-catalog';
import { cn } from '../../../internal/lib/utils';

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
  disabled?: boolean;
  allowOnce?: boolean;
  runAt?: string | null;
  onRunAtChange?: (iso: string | null) => void;
  /** A last field for the repeating row, e.g. the host's timezone select. */
  trailing?: ReactNode;
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

function describeRunAt(iso: string, tI18nComplete: ReturnType<typeof useTranslations>): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return tI18nComplete.raw('text3b4153c0d3c8');
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
  disabled,
  allowOnce,
  runAt,
  onRunAtChange,
  trailing,
}: ScheduleBuilderProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const tTrigger = useTranslations('triggerComposer');
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
      warningToast(tI18nComplete.raw('text82457b59d590'));
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
    errorToast(tI18nComplete.raw('text641c87998713'), { description: message });
  };

  const cadence = cadenceFor(state);
  const canOnce = Boolean(allowOnce && onRunAtChange);
  const cadences = localizeUiCatalog(CADENCES, tI18nComplete, APP_REGISTRY_TRANSLATION_KEYS);
  const weekdayButtons = localizeUiCatalog(
    WEEKDAY_BUTTONS,
    tI18nComplete,
    APP_REGISTRY_TRANSLATION_KEYS,
  );
  const intervalUnit = (value: number) =>
    state.frequency === 'minutes' ? 'minutes' : `hour${value === 1 ? '' : 's'}`;

  return (
    <div className={cn('space-y-3', disabled && 'pointer-events-none opacity-60 select-none')}>
      {/* One row of stacked fields: how often, the cadence's own detail, the
          time, then whatever the host adds (the composer's timezone). It wraps
          when the column is too narrow; every field keeps its label. */}
      <div className="flex flex-wrap items-end gap-3">
        <ScheduleField label={tI18nComplete.raw('textb6b7a0065808')} className="w-full sm:w-44">
          <Select
            value={onceMode ? 'once' : cadence}
            onValueChange={(next) =>
              next === 'once' ? selectOnce() : selectCadence(next as Cadence)
            }
            disabled={disabled}
          >
            <SelectTrigger className="h-9 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {cadences.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
              {canOnce ? (
                <SelectItem value="once">{tI18nComplete.raw('textd88f6d8372f4')}</SelectItem>
              ) : null}
            </SelectContent>
          </Select>
        </ScheduleField>

        {onceMode ? (
          <ScheduleField label={tI18nComplete.raw('text4b4c31294fb5')} className="w-full sm:w-auto">
            <Input
              type="datetime-local"
              value={runAt ? isoToLocalInput(runAt) : ''}
              min={isoToLocalInput(new Date().toISOString())}
              onChange={(event) => onRunAtChange?.(localInputToIso(event.target.value))}
              onBlur={() => {
                if (hasPastRunAt) warningToast(tI18nComplete.raw('textabf586cc6ecb'));
              }}
              aria-invalid={hasPastRunAt}
              className="h-9 w-full sm:w-auto"
              disabled={disabled}
            />
          </ScheduleField>
        ) : (
          <>
            {(state.frequency === 'minutes' || state.frequency === 'hourly') && (
              <ScheduleField label={tTrigger('every')} className="w-32">
                <Select
                  value={String(state.interval)}
                  onValueChange={(value) => update({ interval: Number(value) })}
                  disabled={disabled}
                >
                  <SelectTrigger className="h-9 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(state.frequency === 'minutes'
                      ? [1, 2, 3, 5, 10, 15, 20, 30, 45]
                      : [1, 2, 3, 4, 6, 8, 12]
                    ).map((value) => (
                      <SelectItem key={value} value={String(value)}>
                        {value} {intervalUnit(value)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </ScheduleField>
            )}

            {state.frequency === 'monthly' && (
              <ScheduleField label={tTrigger('dayOfMonth')} className="w-28">
                <Select
                  value={String(state.monthDay)}
                  onValueChange={(value) => update({ monthDay: Number(value) })}
                  disabled={disabled}
                >
                  <SelectTrigger className="h-9 w-full">
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
              </ScheduleField>
            )}

            {state.frequency !== 'minutes' && (
              <ScheduleField
                label={
                  state.frequency === 'hourly'
                    ? tI18nComplete.raw('text5f2ed72dfcbc')
                    : tI18nComplete.raw('text33b93476cf59')
                }
              >
                <div className="flex items-center gap-1.5">
                  {state.frequency !== 'hourly' && (
                    <>
                      <Select
                        value={String(state.hour)}
                        onValueChange={(value) => update({ hour: Number(value) })}
                        disabled={disabled}
                      >
                        <SelectTrigger className="h-9 w-18 tabular-nums">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {HOURS.map((value) => (
                            <SelectItem key={value} value={String(value)}>
                              {pad2(value)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <span className="text-muted-foreground">:</span>
                    </>
                  )}
                  <Select
                    value={String(state.minute)}
                    onValueChange={(value) => update({ minute: Number(value) })}
                    disabled={disabled}
                  >
                    <SelectTrigger className="h-9 w-18 tabular-nums">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MINUTE_OPTIONS.map((value) => (
                        <SelectItem key={value} value={String(value)}>
                          {state.frequency === 'hourly' ? `:${pad2(value)}` : pad2(value)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </ScheduleField>
            )}

            {trailing}
          </>
        )}
      </div>

      {!onceMode && cadence === 'weekly' && (
        <div className="flex flex-wrap gap-1.5" aria-label={tI18nComplete.raw('text2069f4549744')}>
          {weekdayButtons.map(({ value, label }) => {
            const selected = state.weekdays.includes(value);
            return (
              <Button
                key={value}
                type="button"
                variant={selected ? 'secondary' : 'outline'}
                size="sm"
                aria-pressed={selected}
                onClick={() => toggleWeekday(value)}
                disabled={disabled}
                className="min-w-10 transition-transform active:scale-[0.96]"
              >
                {label}
              </Button>
            );
          })}
        </div>
      )}

      {/* The plain-language summary lives in the host's header. Only the two
          things that header cannot say show here: a one-off in the past, and a
          cron the form cannot describe. */}
      {onceMode && runAt && hasPastRunAt ? (
        <SchedulePreview text={describeRunAt(runAt, tI18nComplete)} error />
      ) : null}
      {!onceMode && isCustom ? (
        <SchedulePreview text={tI18nComplete.raw('text7afd348d0d4b')} />
      ) : null}

      {!onceMode && (
        <div className="space-y-2">
          <Button
            type="button"
            variant="text"
            size="xs"
            onClick={() => setShowCron((visible) => !visible)}
            disabled={disabled}
            className="text-muted-foreground hover:text-foreground -ml-1 transition-transform active:scale-[0.96]"
          >
            <ChevronDown
              className={cn(
                'size-3 transition-transform duration-(--duration-normal)',
                showCron && 'rotate-180',
              )}
            />
            {showCron
              ? tI18nComplete.raw('text6c848b936d1d')
              : tI18nComplete.raw('text1fa1b04791a4')}
          </Button>

          {showCron && (
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="schedule-cron-expression">
                {tI18nComplete.raw('text4ab444f5a66a')}
              </Label>
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
                    ? tI18nComplete.raw('textef7f45ff7f0a')
                    : tI18nComplete.raw('textcc0c25063f43'))}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** One stacked field of the schedule row: a small label over its control. */
function ScheduleField({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label className="text-xs first-letter:uppercase">{label}</Label>
      {children}
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
