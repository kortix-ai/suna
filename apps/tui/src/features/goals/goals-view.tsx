/**
 * The Goals screen, as pixels and keys only.
 *
 * Everything drawn arrives as a prop and everything done leaves as a callback,
 * like `features/apps/apps-view.tsx`. `goals-screen.tsx` owns the SDK. Inputs
 * and the stop prompt are drawn in the column, never as `ui/Modal` (a panel
 * scissors an absolute overlay to its own rectangle).
 */

import { useKeyboard } from '@opentui/react';
import { useCallback, useMemo, useState } from 'react';

import { glyph as GLYPH, theme } from '../../theme.ts';
import { Spinner, layoutRow, windowStart } from '../../ui/index.ts';
import { editText } from './edit-text.ts';
import {
  type DetailLine,
  GROUP_LABEL,
  type GoalDetail,
  type GoalRow,
  type GoalTone,
  detailLines,
} from './goals-model.ts';
import { matchesGoalsBinding } from './keys.ts';

export interface GoalsViewProps {
  rows: GoalRow[];
  focused: boolean;
  width: number;
  height: number;
  /** The clock the times render against. A prop, never `Date.now()`. */
  now: number;
  loading: boolean;
  /** Rendered in place of the list. The SDK error message, verbatim. */
  errorMessage: string | null;
  /** One dim line under the list: `stopping…`. */
  busyMessage?: string | null;
  /** The detail for the goal whose pane is open. */
  detail: GoalDetail | null;
  /** Printed under the empty state. */
  emptyHint?: string;
  onOpenDetails(goalId: string | null): void;
  onOpenSession(sessionId: string): void;
  /** Enter on the new-goal input, with the outcome text. */
  onCreate(outcome: string): void;
  onReply(goalId: string, text: string): void;
  /** `reason` is empty when the person typed none. */
  onStop(goalId: string, reason: string): void;
  onOpenWeb(goalId: string): void;
  onRefresh(): void;
  /** Esc with nothing open. */
  onBack(): void;
}

type Mode = 'browse' | 'detail' | 'new' | 'reply' | 'stop';

const TONE_COLOR: Record<GoalTone, string> = {
  ok: theme.ok,
  idle: theme.faint,
  busy: theme.busy,
  bad: theme.danger,
};

type ListLine = { kind: 'header'; label: string; count: number } | { kind: 'row'; row: GoalRow };

/** Group headers and rows in one array, so the window and the cursor share it. */
export function listLines(rows: readonly GoalRow[]): ListLine[] {
  const lines: ListLine[] = [];
  let group: GoalRow['group'] | null = null;
  for (const row of rows) {
    if (row.group !== group) {
      group = row.group;
      lines.push({
        kind: 'header',
        label: GROUP_LABEL[row.group],
        count: rows.filter((candidate) => candidate.group === row.group).length,
      });
    }
    lines.push({ kind: 'row', row });
  }
  return lines;
}

/** One goal row as plain text, cursor gutter excluded. */
export function goalRowText(row: GoalRow, width: number): string {
  const right = [row.progress, row.status].filter(Boolean).join(' · ');
  return layoutRow(`${row.glyph} ${row.title}`, right, Math.max(width - 1, 0));
}

const DETAIL_COLOR: Record<NonNullable<DetailLine['style']>, string> = {
  heading: theme.dim,
  danger: theme.danger,
  dim: theme.dim,
  faint: theme.faint,
};

export function GoalsView({
  rows,
  focused,
  width,
  height,
  now,
  loading,
  errorMessage,
  busyMessage = null,
  detail,
  emptyHint,
  onOpenDetails,
  onOpenSession,
  onCreate,
  onReply,
  onStop,
  onOpenWeb,
  onRefresh,
  onBack,
}: GoalsViewProps) {
  const [mode, setMode] = useState<Mode>('browse');
  const [cursorId, setCursorId] = useState<string | null>(rows[0]?.id ?? null);
  const [detailCursor, setDetailCursor] = useState(0);
  const [text, setText] = useState('');

  const lines = useMemo(() => listLines(rows), [rows]);
  const cursorIndex = useMemo(() => {
    const found = rows.findIndex((row) => row.id === cursorId);
    return found >= 0 ? found : 0;
  }, [rows, cursorId]);
  const current = rows[cursorIndex] ?? null;
  const bodyWidth = Math.max(width - 1, 0);

  const detailBody = useMemo(
    () => (detail ? detailLines(detail, bodyWidth - 1, now) : []),
    [detail, bodyWidth, now],
  );

  const moveTo = useCallback(
    (index: number) => {
      const row = rows[Math.min(Math.max(index, 0), rows.length - 1)];
      if (row) setCursorId(row.id);
    },
    [rows],
  );

  const closeDetail = useCallback(() => {
    setMode('browse');
    setDetailCursor(0);
    onOpenDetails(null);
  }, [onOpenDetails]);

  const startInput = useCallback((next: 'new' | 'reply' | 'stop') => {
    setText('');
    setMode(next);
  }, []);

  useKeyboard((key) => {
    if (!focused) return;

    if (mode === 'new' || mode === 'reply' || mode === 'stop') {
      if (matchesGoalsBinding(key, 'goals.back')) {
        setMode(mode === 'new' ? 'browse' : 'detail');
        return;
      }
      if (matchesGoalsBinding(key, 'goals.open')) {
        const value = text.trim();
        // A stop needs no reason; a new goal and an answer need words.
        if (!value && mode !== 'stop') return;
        if (mode === 'new') {
          setMode('browse');
          onCreate(value);
        } else if (detail) {
          setMode('detail');
          if (mode === 'reply') onReply(detail.id, value);
          else onStop(detail.id, value);
        }
        return;
      }
      // Functional update: a fast burst (typing, a paste) lands before React re-renders.
      setText((value) => editText(value, key) ?? value);
      return;
    }

    if (mode === 'detail') {
      if (matchesGoalsBinding(key, 'goals.back')) return closeDetail();
      if (matchesGoalsBinding(key, 'goals.down'))
        return setDetailCursor((i) => Math.min(i + 1, Math.max(detailBody.length - 1, 0)));
      if (matchesGoalsBinding(key, 'goals.up')) return setDetailCursor((i) => Math.max(i - 1, 0));
      if (matchesGoalsBinding(key, 'goals.first')) return setDetailCursor(0);
      if (matchesGoalsBinding(key, 'goals.last'))
        return setDetailCursor(Math.max(detailBody.length - 1, 0));
      if (matchesGoalsBinding(key, 'goals.open')) {
        const sessionId = detailBody[detailCursor]?.sessionId;
        if (sessionId) onOpenSession(sessionId);
        return;
      }
      if (matchesGoalsBinding(key, 'goals.reply')) {
        if (detail?.canReply) startInput('reply');
        return;
      }
      if (matchesGoalsBinding(key, 'goals.stop')) {
        if (detail?.canStop) startInput('stop');
        return;
      }
      if (matchesGoalsBinding(key, 'goals.web')) {
        if (detail) onOpenWeb(detail.id);
      }
      return;
    }

    if (matchesGoalsBinding(key, 'goals.back')) return onBack();
    if (matchesGoalsBinding(key, 'goals.down')) return moveTo(cursorIndex + 1);
    if (matchesGoalsBinding(key, 'goals.up')) return moveTo(cursorIndex - 1);
    if (matchesGoalsBinding(key, 'goals.first')) return moveTo(0);
    if (matchesGoalsBinding(key, 'goals.last')) return moveTo(rows.length - 1);
    if (matchesGoalsBinding(key, 'goals.refresh')) return onRefresh();
    if (matchesGoalsBinding(key, 'goals.new')) return startInput('new');
    if (matchesGoalsBinding(key, 'goals.open')) {
      if (!current) return;
      setMode('detail');
      setDetailCursor(0);
      onOpenDetails(current.id);
      return;
    }
    if (matchesGoalsBinding(key, 'goals.web') && current) onOpenWeb(current.id);
  });

  if ((mode === 'detail' || mode === 'reply' || mode === 'stop') && detail) {
    const prompt =
      mode === 'reply' ? 'Answer › ' : mode === 'stop' ? 'Stop reason (optional) › ' : null;
    const inputRows = prompt ? 2 : 0;
    const room = Math.max(height - 2 - inputRows, 1);
    const start = windowStart(detailCursor, detailBody.length, room);
    const visible = detailBody.slice(start, start + room);
    const hints = [
      detailBody[detailCursor]?.sessionId ? 'Enter open session' : null,
      detail.canReply ? 'a answer' : null,
      detail.canStop ? 's stop' : null,
      'o web',
      'Esc back',
    ]
      .filter(Boolean)
      .join(' · ');
    return (
      <box flexDirection="column" width={width}>
        <text fg={theme.border}>{'─'.repeat(bodyWidth)}</text>
        {visible.map((line, index) => {
          const isCursor = start + index === detailCursor && Boolean(line.sessionId);
          return (
            <text
              key={`${start + index}`}
              fg={isCursor ? theme.fg : line.style ? DETAIL_COLOR[line.style] : theme.fg}
              bg={isCursor ? theme.surface : undefined}
            >
              <span fg={theme.accent}>{isCursor && focused ? GLYPH.selected : ' '}</span>
              {line.text}
            </text>
          );
        })}
        {prompt ? (
          <box flexDirection="column" width={width}>
            <text fg={theme.fg}>
              <span fg={theme.accent}>{prompt}</span>
              {text}
              <span fg={theme.accent}>▏</span>
            </text>
            <text fg={theme.faint}>
              {mode === 'stop' ? 'Enter stop the goal · Esc cancel' : 'Enter send · Esc cancel'}
            </text>
          </box>
        ) : (
          <text fg={theme.faint}>{busyMessage ?? hints}</text>
        )}
      </box>
    );
  }

  if (mode === 'detail' && !detail) {
    return (
      <box flexDirection="column" width={width}>
        <Spinner label="loading goal" />
      </box>
    );
  }

  const adding = mode === 'new';
  const reserved = 2 + (adding ? 2 : 0) + (busyMessage ? 1 : 0);
  const room = Math.max(height - reserved, 1);
  const cursorLine = Math.max(
    lines.findIndex((line) => line.kind === 'row' && line.row.id === current?.id),
    0,
  );
  const start = windowStart(cursorLine, lines.length, room);
  const visible = lines.slice(start, start + room);
  const hints = ['Enter open', 'n new goal', 'o web', 'r refresh', 'Esc back'].join(' · ');

  return (
    <box flexDirection="column" width={width}>
      {adding ? (
        <box flexDirection="column" width={width}>
          <text fg={theme.fg}>
            <span fg={theme.accent}>{'Outcome › '}</span>
            {text}
            <span fg={theme.accent}>▏</span>
          </text>
          <text fg={theme.faint}>Enter start in a new session · Esc cancel</text>
        </box>
      ) : null}

      {visible.map((line) => {
        if (line.kind === 'header') {
          return (
            <text key={`h-${line.label}`} fg={theme.dim}>
              {`${line.label} ${line.count}`}
            </text>
          );
        }
        const row = line.row;
        const isCursor = row.id === current?.id;
        const body = goalRowText(row, width);
        return (
          <text
            key={row.id}
            fg={isCursor ? theme.fg : theme.dim}
            bg={isCursor ? theme.surface : undefined}
          >
            <span fg={theme.accent}>{isCursor && focused ? GLYPH.selected : ' '}</span>
            <span fg={TONE_COLOR[row.tone]}>{body.slice(0, 1)}</span>
            {body.slice(1)}
          </text>
        );
      })}

      {loading && rows.length === 0 ? <Spinner label="loading goals" /> : null}
      {!loading && !errorMessage && rows.length === 0 ? (
        <box flexDirection="column">
          <text fg={theme.fg}>No goals yet</text>
          <text fg={theme.faint}>
            A goal is an outcome plus a definition of done. An agent works it until a verifier
            confirms it.
          </text>
          {emptyHint ? <text fg={theme.dim}>{`  ${emptyHint}`}</text> : null}
        </box>
      ) : null}
      {errorMessage ? (
        <text fg={theme.danger}>{layoutRow(errorMessage, '', bodyWidth)}</text>
      ) : null}
      {busyMessage ? <text fg={theme.faint}>{busyMessage}</text> : null}
      {current?.line ? <text fg={theme.dim}>{layoutRow(current.line, '', bodyWidth)}</text> : null}
      <text fg={theme.faint}>{hints}</text>
    </box>
  );
}
