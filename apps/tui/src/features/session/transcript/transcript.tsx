/**
 * The session transcript.
 *
 * It takes the `useSession` return value as a prop and reads it — it never
 * calls the hook. The integrator's `session-view.tsx` calls `useSession` once
 * and hands the same object to the transcript, the composer and the prompts,
 * so one session is one hook (SPEC §1.3) no matter how many components render
 * it.
 *
 * Scroll model: one `<scrollbox stickyScroll stickyStart="bottom">`. Sticky
 * stays on until the reader moves the viewport themselves; `G` turns it back
 * on and jumps to the newest turn. `PgUp` at the very top is the "load older"
 * gesture, not a scroll.
 */

import { type MessageWithParts, classifyTurn, groupMessagesIntoTurns } from '@kortix/sdk';
import type { useSession } from '@kortix/sdk/react';
import type { ScrollBoxRenderable } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  collapseToolRuns,
  findToolCall,
  orderedMessages,
  toggleableKeys,
} from '../../../lib/turn-layout.ts';
import { theme } from '../../../theme.ts';
import { PermissionPrompt } from '../prompts/permission-prompt.tsx';
import { QuestionPrompt } from '../prompts/question-prompt.tsx';
import { ErrorBanner, describeSendError, describeStartError } from './error-banner.tsx';
import { matchesTranscriptBinding } from './keys.ts';
import { Turn } from './turn.tsx';
import { WorkingLine } from './working-line.tsx';

/** The whole session, exactly as `useSession` returns it. */
export type SessionState = ReturnType<typeof useSession>;

export interface TranscriptProps {
  session: SessionState;
  focused: boolean;
  width: number;
  height: number;
  onToast?(message: string, kind?: 'info' | 'error'): void;
  /**
   * Render the pending question/permission cards inside the transcript column.
   * Default true. An integrator that positions the prompts itself (directly
   * above the composer) sets this false and renders `<QuestionPrompt/>` /
   * `<PermissionPrompt/>` from `features/session/prompts` instead.
   */
  renderPrompts?: boolean;
}

/** Rows the header clock re-renders on. One second is the finest unit any
 *  header prints, so anything faster is wasted work. */
const CLOCK_INTERVAL_MS = 1000;

export function Transcript({
  session,
  focused,
  width,
  height,
  onToast,
  renderPrompts = true,
}: TranscriptProps) {
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const [sticky, setSticky] = useState(true);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [cursorIndex, setCursorIndex] = useState(-1);
  const [now, setNow] = useState(() => Date.now());

  const messages = session.messages as unknown as MessageWithParts[];
  const ordered = useMemo(() => orderedMessages(groupMessagesIntoTurns(messages)), [messages]);

  // Every collapsible row in the whole transcript, in document order. The
  // cursor is an index into THIS list, so `J`/`K` never land on a row that
  // cannot be opened.
  const rowKeys = useMemo(
    () =>
      ordered.flatMap((message) => toggleableKeys(collapseToolRuns(classifyTurn(message).parts))),
    [ordered],
  );

  // A clock tick only while something is running: an idle transcript's
  // "3m ago" does not need to become "4m ago" on a session nobody is watching.
  const busy = session.isBusy || session.working.state === 'working';
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setNow(Date.now()), CLOCK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [busy]);

  const cursorKey = focused && cursorIndex >= 0 ? (rowKeys[cursorIndex] ?? null) : null;

  const toggle = useCallback((key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const scrollBy = useCallback((delta: number) => {
    setSticky(false);
    scrollRef.current?.scrollBy(delta);
  }, []);

  const questions = session.questions;
  const permissions = session.permissions;
  const promptOpen = renderPrompts && (questions.length > 0 || permissions.length > 0);

  useKeyboard((key) => {
    // An open prompt owns the keyboard: `j`/`k` must move its option cursor,
    // not scroll the transcript out from under the question.
    if (!focused || promptOpen) return;

    if (matchesTranscriptBinding(key, 'transcript.bottom')) {
      setSticky(true);
      const box = scrollRef.current;
      if (box) box.scrollTo(box.scrollHeight);
      return;
    }
    if (matchesTranscriptBinding(key, 'transcript.top')) {
      setSticky(false);
      scrollRef.current?.scrollTo(0);
      return;
    }
    if (matchesTranscriptBinding(key, 'transcript.older')) {
      const box = scrollRef.current;
      if (box && box.scrollTop <= 0) {
        if (session.hasOlder && !session.isLoadingOlder) {
          onToast?.('Loading older turns…');
          void session.loadOlder();
        }
        return;
      }
      scrollBy(-Math.max(height - 2, 1));
      return;
    }
    if (matchesTranscriptBinding(key, 'transcript.pageDown'))
      return scrollBy(Math.max(height - 2, 1));
    if (matchesTranscriptBinding(key, 'transcript.down')) return scrollBy(1);
    if (matchesTranscriptBinding(key, 'transcript.up')) return scrollBy(-1);
    if (matchesTranscriptBinding(key, 'transcript.rowNext')) {
      if (rowKeys.length === 0) return;
      setCursorIndex((index) => Math.min(index + 1, rowKeys.length - 1));
      return;
    }
    if (matchesTranscriptBinding(key, 'transcript.rowPrev')) {
      if (rowKeys.length === 0) return;
      setCursorIndex((index) => Math.max(index - 1, 0));
      return;
    }
    if (matchesTranscriptBinding(key, 'transcript.toggle')) {
      // No cursor yet: open the newest collapsible row, which is what a reader
      // who just watched a turn run wants to see.
      const index = cursorIndex >= 0 ? cursorIndex : rowKeys.length - 1;
      const target = rowKeys[index];
      if (!target) return;
      setCursorIndex(index);
      toggle(target);
    }
  });

  const lastMessageId = ordered.at(-1)?.info.id;
  const startFailed = session.phase === 'error';

  // Re-pin to the bottom after EVERY commit while sticky is on.
  //
  // `stickyScroll` alone does not survive a content-height jump: expanding a
  // steps group adds ~30 rows in one commit, and the viewport stayed where it
  // was, showing the middle of an older turn. Verified in a live run — frame 8
  // of `scripts/dev-transcript.tsx` before this effect existed. `scrollTo` is a
  // native setter, and a commit only happens when something actually changed,
  // so running it unconditioned is cheaper than tracking a content signature
  // that has to include every streaming part.
  useEffect(() => {
    if (!sticky) return;
    const box = scrollRef.current;
    if (box) box.scrollTo(box.scrollHeight);
  });

  return (
    // `overflow: hidden` is load-bearing, not tidiness: without it the
    // scrollbox's last row painted over the working line below it ("idle"
    // overwrote "◆ kortix · now" in a live frame).
    <box flexDirection="column" width={width} height={height} overflow="hidden">
      <scrollbox
        ref={scrollRef}
        focused={focused}
        stickyScroll={sticky}
        stickyStart="bottom"
        flexGrow={1}
        // NOT `scrollbarOptions={{ visible: true }}` — forcing both bars on
        // blanks the viewport in 0.5.11 (verified: the content rows render
        // empty and only the bar glyphs paint). Let the bars auto-show.
        contentOptions={{ flexDirection: 'column' }}
      >
        {session.isLoadingOlder ? <text fg={theme.faint}>loading older turns…</text> : null}
        {ordered.length === 0 ? (
          <text fg={theme.faint}>No messages yet. Type a prompt below.</text>
        ) : null}
        {ordered.map((message) => (
          <Turn
            key={message.info.id}
            message={message}
            width={Math.max(width - 2, 12)}
            expanded={expanded}
            cursorKey={cursorKey}
            streaming={busy && message.info.id === lastMessageId}
            now={now}
          />
        ))}
      </scrollbox>

      {session.sendError ? (
        <ErrorBanner content={describeSendError(session.sendError)} width={width} />
      ) : null}
      {startFailed && (session.startError || session.failure) ? (
        <ErrorBanner
          content={describeStartError(session.startError, session.failure)}
          width={width}
        />
      ) : null}

      <WorkingLine working={session.working} isBusy={session.isBusy} />

      {renderPrompts ? (
        <SessionPrompts session={session} focused={focused} width={width} onToast={onToast} />
      ) : null}
    </box>
  );
}

export interface SessionPromptsProps {
  session: SessionState;
  focused: boolean;
  width: number;
  onToast?(message: string, kind?: 'info' | 'error'): void;
}

/**
 * Every pending question and permission for this session.
 *
 * Exported on its own so the integrator can pin the same cards directly above
 * the composer (`renderPrompts={false}` on the transcript) without rebuilding
 * the reply plumbing.
 *
 * Only the TOP card takes keys. Two cards both answering `y` would let one
 * keystroke approve a request the reader never looked at.
 */
export function SessionPrompts({ session, focused, width, onToast }: SessionPromptsProps) {
  const messages = session.messages as unknown as MessageWithParts[];
  const permission = session.permissions[0];
  const question = session.questions[0];

  const fail = useCallback(
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      onToast?.(message, 'error');
    },
    [onToast],
  );

  if (permission) {
    return (
      <PermissionPrompt
        permission={permission}
        focused={focused}
        width={width}
        toolCall={findToolCall(messages, permission.tool)}
        onReply={(id, reply) => {
          void session.answerPermission(id, reply).catch(fail);
        }}
      />
    );
  }

  if (question) {
    return (
      <QuestionPrompt
        question={question}
        focused={focused}
        width={width}
        onAnswer={(id, answers) => {
          void session.answerQuestion(id, answers).catch(fail);
        }}
        onReject={(id) => {
          void session.rejectQuestion(id).catch(fail);
        }}
      />
    );
  }

  return null;
}
