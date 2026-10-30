'use client';

import type { TriggerFilterValue } from '@kortix/sdk';
import { useTranslations } from '../../../i18n';
/**
 * The controls the create flow and the detail panel both use, so the two can
 * never drift. Everything here is presentational — the caller decides whether
 * a change is staged locally or written straight back.
 */

import { Button } from '../../../primitives/button';
import { Input } from '../../../primitives/input';
import { Label } from '../../../primitives/label';
import Loading from '../../../primitives/loading';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../primitives/select';
import { errorToast, successToast } from '../../../primitives/toast';
import { cn } from '../../../internal/lib/utils';
import { copyToClipboard } from '../../../internal/lib/utils/clipboard';
import { CheckIcon, CopyIcon, PlusIcon, TrashIcon } from '@phosphor-icons/react';
import { AnimatedCopyIcon } from '../../../animated-copy-icon';
import { type ReactNode, useState } from 'react';

import {
  SESSION_MODE_HELP,
  SESSION_MODE_LABEL,
  SESSION_MODES,
  type SessionMode,
} from './schedule-copy';

/* ─── Read-only property list ───────────────────────────────────────────── */

/**
 * Label/value pairs. A `<dl>` rather than the `<Table>` this used to be: a
 * table drew a full bordered grid around four facts and read as data you
 * could act on.
 */
export function PropertyList({
  rows,
}: {
  rows: { label: string; value: ReactNode; hint?: string }[];
}) {
  return (
    <dl className="divide-border/60 divide-y">
      {rows.map((row) => (
        <div
          key={row.label}
          className="flex flex-col gap-0.5 py-2 first:pt-0 last:pb-0 sm:flex-row sm:items-baseline sm:gap-4"
        >
          <dt className="text-muted-foreground shrink-0 text-xs sm:w-32">{row.label}</dt>
          <dd className="text-foreground min-w-0 flex-1 text-sm break-words">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ─── Copyable value ────────────────────────────────────────────────────── */

/**
 * A value you are meant to take somewhere else — the webhook address, the
 * sample request. The copy control crossfades its icon (scale 0.25→1,
 * opacity 0→1, blur 4px→0 on a `bounce: 0` spring) so the confirmation reads
 * as one morph rather than two glyphs blinking.
 */
export function CopyBlock({
  value,
  copiedLabel = 'Copied',
  label = 'Copy',
  multiline = false,
  className,
}: {
  value: string;
  copiedLabel?: string;
  label?: string;
  multiline?: boolean;
  className?: string;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    const ok = await copyToClipboard(value);
    if (!ok) {
      errorToast(tI18nComplete.raw('text9eb5ba7f83b0'));
      return;
    }
    successToast(copiedLabel);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div
      className={cn(
        'bg-secondary flex items-start gap-2 rounded-md border p-2 transition-colors',
        copied ? 'border-kortix-green/15' : 'border-transparent',
        className,
      )}
    >
      <code
        className={cn(
          'text-foreground min-w-0 flex-1 px-1 py-0.5 font-mono text-xs leading-relaxed',
          // Horizontal only. This used to be `max-h-40 overflow-auto`, which put
          // a SECOND vertical scroller inside a sheet that already scrolls — the
          // wheel then goes to whichever surface the cursor happens to be over,
          // so the sheet appears stuck the moment you point at a webhook URL.
          // One vertical scrolling surface per view; long values make the sheet
          // taller and the sheet scrolls, which is what a reader expects.
          multiline ? 'block overflow-x-auto whitespace-pre' : 'block truncate',
        )}
      >
        {value}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? copiedLabel : label}
        className={cn(
          'inline-flex size-7 shrink-0 items-center justify-center rounded-md',
          'text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06]',
          'hit-area-2 cursor-pointer transition-colors active:scale-[0.96]',
          'outline-none focus-visible:outline-none',
        )}
      >
        <span className="relative inline-flex size-3.5 items-center justify-center">
          <AnimatedCopyIcon copied={copied}>
            {copied ? (
              <CheckIcon className="text-kortix-green size-3.5" />
            ) : (
              <CopyIcon className="size-3.5" />
            )}
          </AnimatedCopyIcon>
        </span>
      </button>
    </div>
  );
}

/* ─── Where the work happens ────────────────────────────────────────────── */

/**
 * The wire calls this `session_mode` with values `fresh` / `reuse` /
 * `pinned` / `keyed`. None of those words appear here: the question is
 * "does the agent remember the last run?", so the options answer that, and
 * the help line under the picker only explains the option you actually chose
 * instead of listing all four.
 */
export function RunLocationFields({
  mode,
  onModeChange,
  pinnedSessionId,
  onPinnedSessionChange,
  sessionKey,
  onSessionKeyChange,
  sessions,
  sessionsLoading,
  sessionKeyAction,
  disabled,
}: {
  mode: SessionMode;
  onModeChange: (next: SessionMode) => void;
  pinnedSessionId: string | null;
  onPinnedSessionChange: (next: string) => void;
  sessionKey: string;
  onSessionKeyChange: (next: string) => void;
  sessions: { session_id: string; name?: string | null; branch_name?: string | null }[];
  sessionsLoading: boolean;
  /** Optional save affordance rendered beside the grouping input. */
  sessionKeyAction?: ReactNode;
  disabled?: boolean;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <div className="space-y-3">
      <Select
        value={mode}
        onValueChange={(v) => onModeChange(v as SessionMode)}
        disabled={disabled}
      >
        <SelectTrigger className="w-full cursor-pointer text-sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SESSION_MODES.map((m) => (
            <SelectItem key={m} value={m} className="cursor-pointer">
              {SESSION_MODE_LABEL[m]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
        {SESSION_MODE_HELP[mode]}
      </p>

      {mode === 'pinned' && (
        <div className="space-y-1.5">
          <Label className="text-xs">{tI18nComplete.raw('text6959b4159575')}</Label>
          <Select
            value={pinnedSessionId ?? ''}
            onValueChange={onPinnedSessionChange}
            disabled={sessionsLoading || disabled}
          >
            <SelectTrigger className="w-full cursor-pointer text-sm">
              <SelectValue
                placeholder={
                  sessionsLoading
                    ? tI18nComplete.raw('textc4141f554a0c')
                    : tI18nComplete.raw('textb40f3be54b3e')
                }
              />
            </SelectTrigger>
            <SelectContent>
              {sessions.map((s) => (
                <SelectItem key={s.session_id} value={s.session_id} className="cursor-pointer">
                  {s.name || s.branch_name || s.session_id}
                </SelectItem>
              ))}
              {!sessionsLoading && sessions.length === 0 && (
                <div className="text-muted-foreground px-2 py-1.5 text-xs">
                  {tI18nComplete.raw('texte6bfacea252e')}
                </div>
              )}
            </SelectContent>
          </Select>
        </div>
      )}

      {mode === 'keyed' && (
        <div className="space-y-1.5">
          <Label className="text-xs">{tI18nComplete.raw('text7dc864ffbdfe')}</Label>
          <div className="flex gap-2">
            <Input
              value={sessionKey}
              onChange={(e) => onSessionKeyChange(e.target.value)}
              placeholder={tI18nComplete.raw('text56c6c5117e48')}
              className="font-mono text-sm"
              disabled={disabled}
            />
            {sessionKeyAction}
          </div>
          <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
            {tI18nComplete.raw('textd9bed5da95cc')}
          </p>
        </div>
      )}
    </div>
  );
}

/* ─── Conditions (the wire calls this `filter`) ─────────────────────────── */

/**
 * The editor's operators: the wire's `not`, `in`, `prefix`, `not_prefix`, plus
 * `equals` (a plain value) and `exists` split into "exists" / "missing".
 */
export const CONDITION_OPERATORS = ['equals', 'not', 'in', 'prefix', 'not_prefix', 'exists', 'missing'] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

export interface ConditionRow {
  path: string;
  /** Absent means equals. */
  operator?: ConditionOperator;
  /** Comma-separated for not, in, prefix and not_prefix. Unused for exists and missing. */
  value: string;
}

type TriggerFilter = Record<string, TriggerFilterValue>;

/** False for exists and missing: those rows have no value field. */
export function conditionNeedsValue(operator: ConditionOperator = 'equals'): boolean {
  return operator !== 'exists' && operator !== 'missing';
}

export function conditionsToRows(filter: TriggerFilter | null | undefined): ConditionRow[] {
  return Object.entries(filter ?? {}).map(([path, condition]): ConditionRow => {
    if (typeof condition === 'string') return { path, operator: 'equals', value: condition };
    if ('exists' in condition) return { path, operator: condition.exists ? 'exists' : 'missing', value: '' };
    const [operator, values] = Object.entries(condition)[0] as [ConditionOperator, string[]];
    return { path, operator, value: values.join(', ') };
  });
}

function rowCondition(row: ConditionRow): TriggerFilterValue {
  const operator = row.operator ?? 'equals';
  if (operator === 'equals') return row.value.trim();
  if (!conditionNeedsValue(operator)) return { exists: operator === 'exists' };
  const values = row.value.split(',').map((item) => item.trim()).filter(Boolean);
  return { [operator]: values } as TriggerFilterValue;
}

/** Blank paths are dropped. `null` means "run on everything". */
export function rowsToConditions(rows: ConditionRow[]): TriggerFilter | null {
  const out: TriggerFilter = {};
  for (const row of rows) {
    const path = row.path.trim();
    if (!path) continue;
    out[path] = rowCondition(row);
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function sameConditions(a: TriggerFilter | null, b: TriggerFilter | null | undefined): boolean {
  const left = a ?? {};
  const right = b ?? {};
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((k) => JSON.stringify(left[k]) === JSON.stringify(right[k]));
}

/** The label each operator shows in the editor and the read-only view. */
export function useConditionOperatorLabels(): Record<ConditionOperator, string> {
  const t = useTranslations('triggerConditions');
  return {
    equals: t('equals'),
    not: t('not'),
    in: t('in'),
    prefix: t('prefix'),
    not_prefix: t('notPrefix'),
    exists: t('exists'),
    missing: t('missing'),
  };
}

/**
 * Repeatable "field · operator · value" rows. Not a JSON box on purpose — the
 * shape is always a flat map, and the loop-breaking case in the help text is
 * the one nearly everybody needs.
 */
export function ConditionsEditor({
  rows,
  onChange,
  disabled,
}: {
  rows: ConditionRow[];
  onChange: (next: ConditionRow[]) => void;
  disabled?: boolean;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const tConditions = useTranslations('triggerConditions');
  const operatorLabel = useConditionOperatorLabels();
  const patch = (index: number, next: Partial<ConditionRow>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...next } : row)));

  return (
    <div className="space-y-3">
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-xs">{tI18nComplete.raw('text04dba7c76354')}</p>
      ) : (
        <div className="space-y-2">
          {rows.map((row, index) => (
            // Rows are edited in place and identified positionally; there is
            // no stable id to key on until a field is typed.
            // biome-ignore lint/suspicious/noArrayIndexKey: positional rows
            <div key={index} className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto] items-center gap-2">
              <Input
                value={row.path}
                onChange={(e) => patch(index, { path: e.target.value })}
                placeholder={tI18nComplete.raw('textf26d53b6b546')}
                aria-label={tI18nComplete('text74eb6d987ed6', { value0: index + 1 })}
                className="font-mono text-xs"
                disabled={disabled}
              />
              <Select
                value={row.operator ?? 'equals'}
                onValueChange={(v) => patch(index, { operator: v as ConditionOperator })}
                disabled={disabled}
              >
                <SelectTrigger
                  className="w-48 shrink-0 cursor-pointer text-xs"
                  aria-label={tConditions('operatorLabel', { value0: index + 1 })}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CONDITION_OPERATORS.map((op) => (
                    <SelectItem key={op} value={op} className="cursor-pointer text-xs">
                      {operatorLabel[op]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* exists / missing take no value; the empty cell keeps the columns aligned. */}
              {!conditionNeedsValue(row.operator) && <span aria-hidden />}
              {conditionNeedsValue(row.operator) && (
                <Input
                  value={row.value}
                  onChange={(e) => patch(index, { value: e.target.value })}
                  placeholder={
                    (row.operator ?? 'equals') === 'equals'
                      ? tI18nComplete.raw('textd62c9039203e')
                      : tConditions('listPlaceholder')
                  }
                  aria-label={tI18nComplete('text54dcdc410e46', { value0: index + 1 })}
                  className="font-mono text-xs"
                  disabled={disabled}
                />
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={tI18nComplete('textee6d71904b1b', { value0: index + 1 })}
                disabled={disabled}
                onClick={() => onChange(rows.filter((_, i) => i !== index))}
              >
                <TrashIcon className="size-4 shrink-0" />
              </Button>
            </div>
          ))}
        </div>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="gap-1.5"
        disabled={disabled}
        onClick={() => onChange([...rows, { path: '', operator: 'equals', value: '' }])}
      >
        <PlusIcon className="size-3.5 shrink-0" />
        {tI18nComplete.raw('text60a0d83510ea')}
      </Button>
      <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
        {tI18nComplete.raw('text0ba9223946de')}{' '}
        <code className="font-mono">body.data.direction</code>{' '}
        {tI18nComplete.raw('text663ea1bfffe5')} <code className="font-mono">inbound</code>{' '}
        {tI18nComplete.raw('text9df96b5f7d02')}
      </p>
    </div>
  );
}

/* ─── Timezone ──────────────────────────────────────────────────────────── */

export const TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Kolkata',
  'Australia/Sydney',
];

/** A labelled field, not the borderless pill this used to be — a timezone
 *  changes when every run happens, so it should look like a setting. */
export function TimezoneField({
  value,
  onChange,
  disabled,
  inline = false,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  /** A field in a row of fields: the daylight-saving note moves to the
   *  trigger's tooltip so the row keeps one height. */
  inline?: boolean;
  className?: string;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const hint = tI18nComplete.raw('textbd2b129daf78');
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label className="text-xs">{tI18nComplete.raw('text4ceca1d52ced')}</Label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger
          className={cn('w-full cursor-pointer text-sm', inline && 'h-9')}
          title={inline ? hint : undefined}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {TIMEZONES.map((tz) => (
            <SelectItem key={tz} value={tz} className="cursor-pointer">
              {tz}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {inline ? null : <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  );
}
