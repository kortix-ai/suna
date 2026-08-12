'use client';

/**
 * The controls the create flow and the detail panel both use, so the two can
 * never drift. Everything here is presentational — the caller decides whether
 * a change is staged locally or written straight back.
 */

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { errorToast, successToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { copyToClipboard } from '@/lib/utils/clipboard';
import { CheckIcon, CopyIcon, PlusIcon, TrashIcon } from '@phosphor-icons/react';
import { AnimatePresence, m } from 'motion/react';
import { type ReactNode, useState } from 'react';

import {
  SESSION_MODE_HELP,
  SESSION_MODE_LABEL,
  SESSION_MODES,
  type SessionMode,
} from './schedule-copy';

/* ─── Panel ─────────────────────────────────────────────────────────────── */

/**
 * One titled block. The detail panel is a stack of these, which is what gives
 * it a hierarchy — before, every setting sat at the same level in one flat
 * column, so nothing told you which knobs belonged together.
 *
 * The header owns its own padding rather than the bordered element, so a
 * flush child (a code block, a table) can still sit edge-to-edge.
 */
export function PanelSection({
  title,
  description,
  action,
  children,
  className,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('bg-popover overflow-hidden rounded-md border', className)}>
      <header className="border-border/60 flex items-start justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0 space-y-0.5">
          <h3 className="text-foreground text-sm font-medium">{title}</h3>
          {description ? (
            <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
              {description}
            </p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </header>
      <div className="space-y-4 px-4 py-4">{children}</div>
    </section>
  );
}

/**
 * A save control that is always present and disabled until there is something
 * to save. The old panel mounted and unmounted its Save buttons on every
 * keystroke that crossed the dirty threshold, so the header jumped while you
 * typed.
 */
export function SaveButton({
  dirty,
  pending,
  onSave,
  label = 'Save',
}: {
  dirty: boolean;
  pending: boolean;
  onSave: () => void;
  label?: string;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="gap-1.5"
      disabled={!dirty || pending}
      onClick={onSave}
    >
      {pending ? <Loading className="size-3.5 shrink-0" /> : null}
      {label}
    </Button>
  );
}

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
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    const ok = await copyToClipboard(value);
    if (!ok) {
      errorToast('Copy failed — select the text and copy it manually');
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
        copied ? 'border-kortix-green/40' : 'border-transparent',
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
          <AnimatePresence initial={false} mode="popLayout">
            <m.span
              key={copied ? 'check' : 'copy'}
              initial={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
              animate={{ scale: 1, opacity: 1, filter: 'blur(0px)' }}
              exit={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
              transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
              className="absolute inset-0 inline-flex items-center justify-center"
            >
              {copied ? (
                <CheckIcon className="text-kortix-green size-3.5" />
              ) : (
                <CopyIcon className="size-3.5" />
              )}
            </m.span>
          </AnimatePresence>
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
          <Label className="text-xs">Session</Label>
          <Select
            value={pinnedSessionId ?? ''}
            onValueChange={onPinnedSessionChange}
            disabled={sessionsLoading || disabled}
          >
            <SelectTrigger className="w-full cursor-pointer text-sm">
              <SelectValue
                placeholder={sessionsLoading ? 'Loading sessions…' : 'Choose a session'}
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
                  This project has no sessions yet.
                </div>
              )}
            </SelectContent>
          </Select>
        </div>
      )}

      {mode === 'keyed' && (
        <div className="space-y-1.5">
          <Label className="text-xs">Group runs by</Label>
          <div className="flex gap-2">
            <Input
              value={sessionKey}
              onChange={(e) => onSessionKeyChange(e.target.value)}
              placeholder="{{ body.data.chat_id }}"
              className="font-mono text-sm"
              disabled={disabled}
            />
            {sessionKeyAction}
          </div>
          <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
            Point this at whatever identifies a conversation in the incoming message — a chat id, a
            customer id, an email address. Each distinct value gets its own session. Leave it
            unmatched and that run starts fresh.
          </p>
        </div>
      )}
    </div>
  );
}

/* ─── Conditions (the wire calls this `filter`) ─────────────────────────── */

export interface ConditionRow {
  path: string;
  value: string;
}

export function conditionsToRows(
  filter: Record<string, string> | null | undefined,
): ConditionRow[] {
  return Object.entries(filter ?? {}).map(([path, value]) => ({ path, value }));
}

/** Blank paths are dropped. `null` means "run on everything". */
export function rowsToConditions(rows: ConditionRow[]): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const path = row.path.trim();
    if (!path) continue;
    out[path] = row.value.trim();
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function sameConditions(
  a: Record<string, string> | null,
  b: Record<string, string> | null | undefined,
): boolean {
  const left = a ?? {};
  const right = b ?? {};
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((k) => left[k] === right[k]);
}

/**
 * Repeatable "this must equal that" rows. Not a JSON box on purpose — the
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
  const patch = (index: number, next: Partial<ConditionRow>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...next } : row)));

  return (
    <div className="space-y-3">
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          No conditions yet — every request starts a run.
        </p>
      ) : (
        <div className="space-y-2">
          {rows.map((row, index) => (
            // Rows are edited in place and identified positionally; there is
            // no stable id to key on until a field is typed.
            // biome-ignore lint/suspicious/noArrayIndexKey: positional rows
            <div key={index} className="flex items-center gap-2">
              <Input
                value={row.path}
                onChange={(e) => patch(index, { path: e.target.value })}
                placeholder="body.data.direction"
                aria-label={`Condition ${index + 1} — field`}
                className="font-mono text-xs"
                disabled={disabled}
              />
              <span className="text-muted-foreground shrink-0 text-xs">is</span>
              <Input
                value={row.value}
                onChange={(e) => patch(index, { value: e.target.value })}
                placeholder="inbound"
                aria-label={`Condition ${index + 1} — value`}
                className="font-mono text-xs"
                disabled={disabled}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remove condition ${index + 1}`}
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
        onClick={() => onChange([...rows, { path: '', value: '' }])}
      >
        <PlusIcon className="size-3.5 shrink-0" />
        Add condition
      </Button>
      <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
        Every condition has to match, or the request is accepted and recorded but starts no run. The
        usual reason to add one is to stop a reply loop: set{' '}
        <code className="font-mono">body.data.direction</code> to{' '}
        <code className="font-mono">inbound</code> so the agent&apos;s own outgoing messages
        can&apos;t set it off again.
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
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">Timezone</Label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger className="w-full cursor-pointer text-sm">
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
      <p className="text-muted-foreground text-xs">
        Times above are read in this timezone. Daylight saving is handled for you.
      </p>
    </div>
  );
}
