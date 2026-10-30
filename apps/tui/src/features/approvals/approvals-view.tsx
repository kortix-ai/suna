/**
 * The Approvals screen (the web's Review Center), as pixels and keys only.
 *
 * Everything drawn arrives as a prop and everything done leaves as a callback,
 * like `features/apps/apps-view.tsx`. `approvals-screen.tsx` owns the SDK.
 * Prompts are drawn in the column, never as `ui/Modal` (a panel scissors an
 * absolute overlay to its own rectangle).
 *
 * Verdicts are given from the detail pane only: the person reads the
 * parameters of a call before approving it.
 */

import type { ReviewItem, ReviewSegment } from '@kortix/sdk';
import { useKeyboard } from '@opentui/react';
import { useCallback, useMemo, useState } from 'react';

import { glyph as GLYPH, theme } from '../../theme.ts';
import { Spinner, layoutRow, windowStart } from '../../ui/index.ts';
import {
  type ApprovalRow,
  type DetailLine,
  KIND_LABEL,
  type RowTone,
  SEGMENTS,
  SEGMENT_LABEL,
  VERB_LABEL,
  type Verb,
  decisionOptions,
  detailLines,
  promptFor,
  rightText,
  verbsFor,
} from './approvals-model.ts';
import { editText } from './edit-text.ts';
import { matchesApprovalsBinding, optionIndexOf } from './keys.ts';

/** The item whose detail pane is open. `item` is the mapped SDK item. */
export interface ApprovalDetail {
  item: ReviewItem;
  /** A connector call's content is still loading (read by id once). */
  loading: boolean;
}

export interface ApprovalsViewProps {
  rows: ApprovalRow[];
  segment: ReviewSegment;
  /** The server's needs-you total, or `null` before it loads. */
  needsYouCount: number | null;
  focused: boolean;
  width: number;
  height: number;
  /** The clock the times render against. A prop, never `Date.now()`. */
  now: number;
  loading: boolean;
  /** Rendered in place of the list. The SDK error message, verbatim. */
  errorMessage: string | null;
  busyMessage?: string | null;
  /** True while the server has more pages of this list. */
  hasMore: boolean;
  detail: ApprovalDetail | null;
  onSegmentChange(segment: ReviewSegment): void;
  /** `null` closes the pane. The caller reads the item for a non-null id. */
  onOpenDetails(id: string | null): void;
  /** `text` is a reason, a note, an answer, or empty. */
  onAct(id: string, verb: Verb, text: string): void;
  onOpenSession(sessionId: string): void;
  onOpenWeb(id: string): void;
  onLoadMore(): void;
  onRefresh(): void;
  /** Esc with nothing open. */
  onBack(): void;
}

type Mode = 'browse' | 'detail' | 'confirm' | 'input';

interface Pending {
  verb: Verb;
  /** A confirm question, or an input label. */
  label: string;
  required: boolean;
  /** For an option answer: the text to send. */
  send?: string;
}

const TONE_COLOR: Record<RowTone, string> = {
  ok: theme.ok,
  idle: theme.faint,
  busy: theme.busy,
  bad: theme.danger,
};

const DETAIL_COLOR: Record<NonNullable<DetailLine['style']>, string> = {
  heading: theme.dim,
  danger: theme.danger,
  dim: theme.dim,
  faint: theme.faint,
};

type ListLine =
  | { kind: 'header'; label: string; count: number }
  | { kind: 'row'; row: ApprovalRow };

/** Kind headers and rows in one array, so the window and the cursor share it. `rows` arrive grouped. */
export function listLines(rows: readonly ApprovalRow[]): ListLine[] {
  const lines: ListLine[] = [];
  let kind: ApprovalRow['kind'] | null = null;
  for (const row of rows) {
    if (row.kind !== kind) {
      kind = row.kind;
      lines.push({
        kind: 'header',
        label: KIND_LABEL[row.kind],
        count: rows.filter((candidate) => candidate.kind === row.kind).length,
      });
    }
    lines.push({ kind: 'row', row });
  }
  return lines;
}

/** One row as plain text, cursor gutter excluded. */
export function approvalRowText(row: ApprovalRow, now: number, width: number): string {
  return layoutRow(`${row.glyph} ${row.title}`, rightText(row, now), Math.max(width - 1, 0));
}

export function ApprovalsView({
  rows,
  segment,
  needsYouCount,
  focused,
  width,
  height,
  now,
  loading,
  errorMessage,
  busyMessage = null,
  hasMore,
  detail,
  onSegmentChange,
  onOpenDetails,
  onAct,
  onOpenSession,
  onOpenWeb,
  onLoadMore,
  onRefresh,
  onBack,
}: ApprovalsViewProps) {
  const [mode, setMode] = useState<Mode>('browse');
  const [cursorId, setCursorId] = useState<string | null>(rows[0]?.id ?? null);
  const [scroll, setScroll] = useState(0);
  const [pending, setPending] = useState<Pending | null>(null);
  const [text, setText] = useState('');

  const lines = useMemo(() => listLines(rows), [rows]);
  const cursorIndex = useMemo(() => {
    const found = rows.findIndex((row) => row.id === cursorId);
    return found >= 0 ? found : 0;
  }, [rows, cursorId]);
  const current = rows[cursorIndex] ?? null;
  const bodyWidth = Math.max(width - 1, 0);

  const verbs = useMemo(() => (detail ? verbsFor(detail.item, now) : []), [detail, now]);
  const options = useMemo(() => (detail ? decisionOptions(detail.item) : []), [detail]);
  const body = useMemo(
    () => (detail ? detailLines(detail.item, bodyWidth - 1, now) : []),
    [detail, bodyWidth, now],
  );

  const moveTo = useCallback(
    (index: number) => {
      if (rows.length === 0) return;
      const at = Math.min(Math.max(index, 0), rows.length - 1);
      const row = rows[at];
      if (row) setCursorId(row.id);
      if (at === rows.length - 1 && hasMore) onLoadMore();
    },
    [rows, hasMore, onLoadMore],
  );

  const closeDetail = useCallback(() => {
    setMode('browse');
    setScroll(0);
    setPending(null);
    onOpenDetails(null);
  }, [onOpenDetails]);

  const ask = useCallback(
    (verb: Verb, send?: string) => {
      if (!detail || !verbs.includes(verb)) return;
      const prompt = promptFor(verb, detail.item);
      setText('');
      // A picked option is already the answer: it only needs a yes.
      if (send !== undefined) {
        setPending({ verb, label: `Answer "${send}"?`, required: false, send });
        setMode('confirm');
      } else if (prompt.kind === 'confirm') {
        setPending({ verb, label: prompt.question, required: false });
        setMode('confirm');
      } else {
        setPending({ verb, label: prompt.label, required: prompt.required });
        setMode('input');
      }
    },
    [detail, verbs],
  );

  const finish = useCallback(
    (value: string) => {
      if (!detail || !pending) return;
      onAct(detail.item.id, pending.verb, value);
      closeDetail();
    },
    [detail, pending, onAct, closeDetail],
  );

  const switchSegment = useCallback(
    (step: 1 | -1) => {
      const at = SEGMENTS.indexOf(segment);
      const next = SEGMENTS[(at + step + SEGMENTS.length) % SEGMENTS.length];
      if (next) {
        setCursorId(null);
        onSegmentChange(next);
      }
    },
    [segment, onSegmentChange],
  );

  useKeyboard((key) => {
    if (!focused) return;

    if (mode === 'input') {
      if (matchesApprovalsBinding(key, 'approvals.back')) {
        setMode('detail');
        return;
      }
      if (matchesApprovalsBinding(key, 'approvals.open')) {
        const value = text.trim();
        if (!value && pending?.required) return;
        finish(value);
        return;
      }
      // Functional update: a fast burst (typing, a paste) lands before React re-renders.
      setText((previous) => editText(previous, key) ?? previous);
      return;
    }

    if (mode === 'confirm') {
      if (
        matchesApprovalsBinding(key, 'approvals.back') ||
        matchesApprovalsBinding(key, 'approvals.deny')
      ) {
        setMode('detail');
        return;
      }
      if (matchesApprovalsBinding(key, 'approvals.confirm')) finish(pending?.send ?? '');
      return;
    }

    if (mode === 'detail') {
      const max = Math.max(body.length - 1, 0);
      if (matchesApprovalsBinding(key, 'approvals.back')) return closeDetail();
      if (matchesApprovalsBinding(key, 'approvals.down'))
        return setScroll((i) => Math.min(i + 1, max));
      if (matchesApprovalsBinding(key, 'approvals.up')) return setScroll((i) => Math.max(i - 1, 0));
      if (matchesApprovalsBinding(key, 'approvals.first')) return setScroll(0);
      if (matchesApprovalsBinding(key, 'approvals.last')) return setScroll(max);
      if (matchesApprovalsBinding(key, 'approvals.approve')) return ask('approve');
      if (matchesApprovalsBinding(key, 'approvals.reject')) return ask('reject');
      if (matchesApprovalsBinding(key, 'approvals.changes')) return ask('changes');
      if (matchesApprovalsBinding(key, 'approvals.dismiss')) return ask('dismiss');
      if (matchesApprovalsBinding(key, 'approvals.answer')) return ask('answer');
      const option = optionIndexOf(key);
      if (option !== null) {
        const picked = options[option];
        if (picked) ask('answer', picked.label);
        return;
      }
      if (matchesApprovalsBinding(key, 'approvals.session')) {
        if (detail?.item.sessionId) onOpenSession(detail.item.sessionId);
        return;
      }
      if (matchesApprovalsBinding(key, 'approvals.web') && detail) onOpenWeb(detail.item.id);
      return;
    }

    if (matchesApprovalsBinding(key, 'approvals.back')) return onBack();
    if (matchesApprovalsBinding(key, 'approvals.down')) return moveTo(cursorIndex + 1);
    if (matchesApprovalsBinding(key, 'approvals.up')) return moveTo(cursorIndex - 1);
    if (matchesApprovalsBinding(key, 'approvals.first')) return moveTo(0);
    if (matchesApprovalsBinding(key, 'approvals.last')) return moveTo(rows.length - 1);
    if (matchesApprovalsBinding(key, 'approvals.segment.next')) return switchSegment(1);
    if (matchesApprovalsBinding(key, 'approvals.segment.prev')) return switchSegment(-1);
    if (matchesApprovalsBinding(key, 'approvals.refresh')) return onRefresh();
    if (matchesApprovalsBinding(key, 'approvals.open')) {
      if (!current) return;
      setMode('detail');
      setScroll(0);
      onOpenDetails(current.id);
      return;
    }
    if (matchesApprovalsBinding(key, 'approvals.web') && current) onOpenWeb(current.id);
  });

  if (mode !== 'browse' && detail) {
    const prompting = mode === 'confirm' || mode === 'input';
    const room = Math.max(height - 2 - (prompting ? 1 : 0), 1);
    const top = Math.min(scroll, Math.max(body.length - room, 0));
    const visible = body.slice(top, top + room);
    const hints = [
      ...verbs.map((verb) => `${VERB_KEY[verb]} ${VERB_LABEL[verb].toLowerCase()}`),
      options.length > 0 && verbs.includes('answer') ? `1-${options.length} pick` : null,
      detail.item.sessionId ? 's session' : null,
      'o web',
      'Esc back',
    ]
      .filter(Boolean)
      .join(' · ');
    return (
      <box flexDirection="column" width={width}>
        <text fg={theme.border}>{'─'.repeat(bodyWidth)}</text>
        {visible.map((line, index) => (
          <text key={`${top + index}`} fg={line.style ? DETAIL_COLOR[line.style] : theme.fg}>
            {` ${line.text}`}
          </text>
        ))}
        {detail.loading ? <Spinner label="loading content" /> : null}
        {mode === 'input' && pending ? (
          <box flexDirection="column" width={width}>
            <text fg={theme.fg}>
              <span fg={theme.accent}>{`${pending.label} › `}</span>
              {text}
              <span fg={theme.accent}>▏</span>
            </text>
            <text fg={theme.faint}>Enter send · Esc cancel</text>
          </box>
        ) : mode === 'confirm' && pending ? (
          <box flexDirection="column" width={width}>
            <text fg={theme.fg}>{pending.label}</text>
            <text fg={theme.faint}>y confirm · Esc cancel</text>
          </box>
        ) : (
          <text fg={theme.faint}>
            {busyMessage ?? (verbs.length === 0 ? `Read only · ${hints}` : hints)}
          </text>
        )}
      </box>
    );
  }

  if (mode !== 'browse' && !detail) {
    return (
      <box flexDirection="column" width={width}>
        <Spinner label="loading item" />
      </box>
    );
  }

  const room = Math.max(height - 3 - (busyMessage ? 1 : 0), 1);
  const cursorLine = Math.max(
    lines.findIndex((line) => line.kind === 'row' && line.row.id === current?.id),
    0,
  );
  const start = windowStart(cursorLine, lines.length, room);
  const visible = lines.slice(start, start + room);
  const hints = ['Enter open', 'h/l list', 'o web', 'r refresh', 'Esc back'].join(' · ');

  return (
    <box flexDirection="column" width={width}>
      <text fg={theme.dim}>
        {SEGMENTS.map((seg) => (
          <span key={seg} fg={seg === segment ? theme.fg : theme.faint}>
            <span fg={theme.brand}>{seg === segment ? GLYPH.selected : ' '}</span>
            {SEGMENT_LABEL[seg]}
            {seg === 'needs_you' && needsYouCount !== null ? ` ${needsYouCount}` : ''}
            {'  '}
          </span>
        ))}
      </text>

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
        const rowText = approvalRowText(row, now, width);
        return (
          <text
            key={row.id}
            fg={isCursor ? theme.fg : theme.dim}
            bg={isCursor ? theme.surface : undefined}
          >
            <span fg={theme.brand}>{isCursor && focused ? GLYPH.selected : ' '}</span>
            <span fg={TONE_COLOR[row.tone]}>{rowText.slice(0, 1)}</span>
            {rowText.slice(1)}
          </text>
        );
      })}

      {loading && rows.length === 0 ? <Spinner label="loading review items" /> : null}
      {!loading && !errorMessage && rows.length === 0 ? (
        <box flexDirection="column">
          <text fg={theme.fg}>{EMPTY_TITLE[segment]}</text>
          <text fg={theme.faint}>Approvals, outputs and decisions from your agents land here.</text>
        </box>
      ) : null}
      {errorMessage ? (
        <text fg={theme.danger}>{layoutRow(errorMessage, '', bodyWidth)}</text>
      ) : null}
      {busyMessage ? <text fg={theme.faint}>{busyMessage}</text> : null}
      <text fg={theme.dim}>
        {current?.summary
          ? layoutRow(current.summary.replace(/\s+/g, ' '), hasMore ? 'more below' : '', bodyWidth)
          : ' '}
      </text>
      <text fg={theme.faint}>{hints}</text>
    </box>
  );
}

/** The key that gives each verb, for the hint line. */
const VERB_KEY: Record<Verb, string> = {
  approve: 'a',
  reject: 'x',
  changes: 'c',
  dismiss: 'd',
  answer: 'w',
};

const EMPTY_TITLE: Record<ReviewSegment, string> = {
  needs_you: 'Nothing needs you',
  waiting: 'Nothing is waiting',
  done: 'Nothing decided yet',
};
