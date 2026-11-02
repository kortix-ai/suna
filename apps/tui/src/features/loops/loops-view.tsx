/**
 * The Loops screen, as pixels and keys only.
 *
 * A loop is a reminder: a prompt that wakes the open session on a schedule
 * (the SDK keeps the wire name `reminder`). Everything drawn arrives as a prop
 * and everything done leaves as a callback; `loops-screen.tsx` owns the SDK.
 *
 * Modes: `browse`, `details`, `create` (prompt + schedule form) and
 * `confirm-delete`. Overlays are drawn in the column, never as `ui/Modal`.
 */

import { useKeyboard } from '@opentui/react';
import { useCallback, useMemo, useState } from 'react';

import { relativeAge } from '../../lib/relative-time.ts';
import { glyph as GLYPH, theme } from '../../theme.ts';
import { Spinner, layoutRow, windowStart } from '../../ui/index.ts';
import { editText, matchesLoopsBinding } from './keys.ts';
import { SCHEDULE_HINT, parseSchedule } from './schedule.ts';

export interface LoopRow {
  id: string;
  /** The loop's name, else the first line of its prompt. */
  title: string;
  prompt: string;
  /** `every 1h` · `cron 0 9 * * *` · `once 2026-11-02 09:00`. */
  schedule: string;
  timezone: string;
  /** `active` · `paused` · `done`. */
  state: string;
  nextMs: number;
  lastMs: number;
  lastStatus: string | null;
  lastError: string | null;
}

export interface LoopsViewProps {
  rows: LoopRow[];
  focused: boolean;
  width: number;
  height: number;
  /** The clock the next-run column renders against. A prop, never `Date.now()`. */
  now: number;
  loading: boolean;
  errorMessage: string | null;
  /** One dim line under the list: `running…`. */
  busyMessage?: string | null;
  /** Called with the validated form. The host creates the loop. */
  onCreate(input: { prompt: string; schedule: string }): void;
  onToggle(row: LoopRow): void;
  onRun(row: LoopRow): void;
  onDelete(row: LoopRow): void;
  onRefresh(): void;
  /** Esc with nothing open. */
  onBack(): void;
}

const LABEL_WIDTH = 12;

/** `in 5m` for a future instant, `due` for a past one, `—` for none. */
export function untilText(targetMs: number, nowMs: number): string {
  if (!Number.isFinite(targetMs)) return '—';
  const delta = targetMs - nowMs;
  if (delta <= 0) return 'due';
  const minutes = Math.ceil(delta / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.floor(hours / 24)}d`;
}

function stateOf(row: LoopRow): { glyph: string; color: string } {
  if (row.lastError) return { glyph: GLYPH.failed, color: theme.danger };
  if (row.state === 'active') return { glyph: GLYPH.running, color: theme.ok };
  return { glyph: GLYPH.stopped, color: theme.faint };
}

/**
 * One list row as plain text, cursor gutter excluded:
 * `<glyph> <title>  <schedule>   <next run | state>`.
 */
export function loopRowText(row: LoopRow, now: number, width: number): string {
  const right = row.state === 'active' ? `next ${untilText(row.nextMs, now)}` : row.state;
  const scheduleRoom = Math.min(row.schedule.length, 22);
  const titleRoom = Math.max(width - 1 - 2 - scheduleRoom - 2 - right.length - 1, 8);
  const title = row.title.length > titleRoom ? `${row.title.slice(0, titleRoom - 1)}…` : row.title;
  return layoutRow(
    `${stateOf(row).glyph} ${title.padEnd(titleRoom, ' ')}  ${row.schedule.slice(0, scheduleRoom)}`,
    right,
    Math.max(width - 1, 0),
  );
}

function Field({ label, value, fg }: { label: string; value: string; fg?: string }) {
  return (
    <text fg={fg ?? theme.fg}>
      <span fg={theme.faint}>{label.padEnd(LABEL_WIDTH, ' ')}</span>
      {value}
    </text>
  );
}

export function LoopsView({
  rows,
  focused,
  width,
  height,
  now,
  loading,
  errorMessage,
  busyMessage = null,
  onCreate,
  onToggle,
  onRun,
  onDelete,
  onRefresh,
  onBack,
}: LoopsViewProps) {
  const [mode, setMode] = useState<'browse' | 'details' | 'create' | 'confirm-delete'>('browse');
  const [cursorId, setCursorId] = useState<string | null>(rows[0]?.id ?? null);
  const [prompt, setPrompt] = useState('');
  const [schedule, setSchedule] = useState('');
  const [field, setField] = useState<'prompt' | 'schedule'>('prompt');
  const [formError, setFormError] = useState<string | null>(null);

  const cursorIndex = useMemo(() => {
    const found = rows.findIndex((row) => row.id === cursorId);
    return found >= 0 ? found : 0;
  }, [rows, cursorId]);
  const current = rows[cursorIndex] ?? null;

  const moveTo = useCallback(
    (index: number) => {
      const row = rows[Math.min(Math.max(index, 0), rows.length - 1)];
      if (row) setCursorId(row.id);
    },
    [rows],
  );

  const submit = useCallback(() => {
    if (!prompt.trim()) {
      setField('prompt');
      setFormError('Enter the prompt the loop sends.');
      return;
    }
    const parsed = parseSchedule(schedule);
    if (!parsed.ok) {
      setField('schedule');
      setFormError(parsed.reason);
      return;
    }
    setMode('browse');
    onCreate({ prompt: prompt.trim(), schedule: schedule.trim() });
  }, [prompt, schedule, onCreate]);

  useKeyboard((key) => {
    if (!focused) return;

    if (mode === 'create') {
      if (matchesLoopsBinding(key, 'back')) return setMode('browse');
      if (matchesLoopsBinding(key, 'field')) {
        return setField((value) => (value === 'prompt' ? 'schedule' : 'prompt'));
      }
      if (key.name === 'return') {
        if (field === 'prompt') return setField('schedule');
        return submit();
      }
      const set = field === 'prompt' ? setPrompt : setSchedule;
      const value = field === 'prompt' ? prompt : schedule;
      const next = editText(value, key);
      if (next !== null) {
        set(next);
        setFormError(null);
      }
      return;
    }

    if (mode === 'confirm-delete') {
      if (matchesLoopsBinding(key, 'back') || matchesLoopsBinding(key, 'deny')) {
        setMode('browse');
        return;
      }
      if (matchesLoopsBinding(key, 'confirm')) {
        const target = current;
        setMode('browse');
        if (target) onDelete(target);
      }
      return;
    }

    if (mode === 'details') {
      if (matchesLoopsBinding(key, 'back')) setMode('browse');
      return;
    }

    if (matchesLoopsBinding(key, 'back')) return onBack();
    if (matchesLoopsBinding(key, 'down')) return moveTo(cursorIndex + 1);
    if (matchesLoopsBinding(key, 'up')) return moveTo(cursorIndex - 1);
    if (matchesLoopsBinding(key, 'first')) return moveTo(0);
    if (matchesLoopsBinding(key, 'last')) return moveTo(rows.length - 1);
    if (matchesLoopsBinding(key, 'refresh')) return onRefresh();
    if (matchesLoopsBinding(key, 'new')) {
      setPrompt('');
      setSchedule('');
      setField('prompt');
      setFormError(null);
      return setMode('create');
    }
    if (!current) return;
    if (matchesLoopsBinding(key, 'details')) return setMode('details');
    if (matchesLoopsBinding(key, 'toggle')) return onToggle(current);
    if (matchesLoopsBinding(key, 'run')) return onRun(current);
    if (matchesLoopsBinding(key, 'delete')) setMode('confirm-delete');
  });

  const bodyWidth = Math.max(width - 1, 0);

  if (mode === 'create') {
    const line = (
      name: 'prompt' | 'schedule',
      label: string,
      value: string,
      placeholder: string,
    ) => (
      <text fg={field === name ? theme.fg : theme.dim}>
        <span fg={theme.brand}>{field === name ? GLYPH.selected : ' '}</span>
        <span fg={theme.faint}>{label.padEnd(LABEL_WIDTH - 1, ' ')}</span>
        {value ? `${value}${field === name ? '▏' : ''}` : field === name ? '▏' : placeholder}
      </text>
    );
    return (
      <box flexDirection="column" width={width}>
        <text fg={theme.fg}>New loop</text>
        <text fg={theme.border}>{'─'.repeat(bodyWidth)}</text>
        {line('prompt', 'Prompt', prompt, 'what the session should do each time')}
        {line('schedule', 'Schedule', schedule, SCHEDULE_HINT)}
        {formError ? <text fg={theme.danger}>{layoutRow(formError, '', bodyWidth)}</text> : null}
        <text fg={theme.faint}>Tab switch field · Enter next/create · Esc cancel</text>
      </box>
    );
  }

  if (mode === 'details' && current) {
    return (
      <box flexDirection="column" width={width}>
        <text fg={theme.fg}>{layoutRow(current.title, current.state, bodyWidth)}</text>
        <text fg={theme.border}>{'─'.repeat(bodyWidth)}</text>
        <Field label="Schedule" value={`${current.schedule} (${current.timezone})`} />
        <Field label="Next run" value={untilText(current.nextMs, now)} />
        <Field
          label="Last run"
          value={
            Number.isFinite(current.lastMs)
              ? `${relativeAge(current.lastMs, now)} ago${current.lastStatus ? ` · ${current.lastStatus}` : ''}`
              : 'never'
          }
        />
        {current.lastError ? (
          <Field label="Error" value={current.lastError} fg={theme.danger} />
        ) : null}
        <Field label="Prompt" value={current.prompt} />
        <text fg={theme.faint}>Esc back</text>
      </box>
    );
  }

  const confirming = mode === 'confirm-delete';
  const rowsAvailable = Math.max(height - (confirming ? 3 : 0) - (busyMessage ? 1 : 0) - 1, 1);
  const start = windowStart(cursorIndex, rows.length, rowsAvailable);
  const visible = rows.slice(start, start + rowsAvailable);
  const hints =
    'n new · Space pause/resume · x run now · d delete · Enter details · r refresh · Esc back';

  return (
    <box flexDirection="column" width={width}>
      {confirming && current ? (
        <box flexDirection="column" width={width}>
          <text fg={theme.danger}>Delete loop</text>
          <text fg={theme.fg}>{layoutRow(current.title, '', bodyWidth)}</text>
          <text fg={theme.faint}>y delete · n or Esc cancel</text>
        </box>
      ) : null}

      {visible.map((row) => {
        const isCursor = row.id === current?.id;
        const body = loopRowText(row, now, width);
        return (
          <text
            key={row.id}
            fg={isCursor ? theme.fg : theme.dim}
            bg={isCursor ? theme.surface : undefined}
          >
            <span fg={theme.brand}>{isCursor && focused ? GLYPH.selected : ' '}</span>
            <span fg={stateOf(row).color}>{body.slice(0, 2)}</span>
            {body.slice(2)}
          </text>
        );
      })}

      {loading && rows.length === 0 ? <Spinner label="loading loops" /> : null}
      {!loading && !errorMessage && rows.length === 0 ? (
        <box flexDirection="column">
          <text fg={theme.fg}>No loops in this session</text>
          <text fg={theme.faint}>
            A loop sends a prompt to this session on a schedule. Press n.
          </text>
        </box>
      ) : null}
      {errorMessage ? (
        <text fg={theme.danger}>{layoutRow(errorMessage, '', bodyWidth)}</text>
      ) : null}
      {busyMessage ? <text fg={theme.faint}>{busyMessage}</text> : null}
      <text fg={theme.faint}>{layoutRow(hints, '', bodyWidth)}</text>
    </box>
  );
}
