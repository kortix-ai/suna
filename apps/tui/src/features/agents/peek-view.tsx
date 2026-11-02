/**
 * A live, read-only look at another agent's session, over the open one.
 *
 * Enter on an agent (an `agent` call, a workflow agent, a row of /agents) opens
 * it here: the child's transcript streams in, an input below steers it (the
 * message reaches its running turn at the next step), and the open session stays
 * where it was underneath. `useSessionView` reads the API's log and stream only:
 * it never wakes the child's box.
 *
 *   Esc      back to the open session (with an empty input)
 *   Ctrl+O   open this agent as the main session
 *   Ctrl+X   stop it (press twice)
 */

import { createSessionPrompt, mintWireMessageId, sessionLogTurns } from '@kortix/sdk';
import { useSessionView } from '@kortix/sdk/react';
import type { ScrollBoxRenderable } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { CommandContext } from '../../commands/registry.ts';
import { kortix } from '../../kortix.ts';
import { printable } from '../../lib/printable.ts';
import { orderedMessages } from '../../lib/turn-layout.ts';
import { theme } from '../../theme.ts';
import { Spinner } from '../../ui/index.ts';
import { PromptInput } from '../session/composer/prompt-input.tsx';
import { TranscriptSessionProvider } from '../session/transcript/session-context.tsx';
import { Turn } from '../session/transcript/turn.tsx';
import type { PeekTarget } from './agent-nav.tsx';

const NO_COMMANDS: CommandContext = { hasProject: true, hasSession: true, hasAccount: true, capabilities: [] };

export interface PeekViewProps {
  projectId: string;
  target: PeekTarget;
  width: number;
  height: number;
  onClose(): void;
  onOpen(sessionId: string): void;
  onToast?(message: string, kind?: 'info' | 'error'): void;
}

export function PeekView({ projectId, target, width, height, onClose, onOpen, onToast }: PeekViewProps) {
  const view = useSessionView(projectId, target.sessionId, { throttleMs: 100 });
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const [armedStop, setArmedStop] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);

  const messages = useMemo(() => (view.thread ? orderedMessages(sessionLogTurns(view.thread)) : []), [view.thread]);
  const title = printable(target.title || view.thread?.title || 'Agent');
  const last = messages.at(-1);
  const working = last?.role === 'assistant' && last.status === 'streaming';

  useEffect(() => {
    const box = scrollRef.current;
    if (box) box.scrollTo(box.scrollHeight);
  });

  useKeyboard((key) => {
    if (key.ctrl && key.name === 'o') {
      key.preventDefault();
      onOpen(target.sessionId);
      return;
    }
    if (key.ctrl && key.name === 'x') {
      key.preventDefault();
      if (!armedStop) {
        setArmedStop(true);
        return;
      }
      setArmedStop(false);
      kortix()
        .session(projectId, target.sessionId)
        .stop()
        .then(() => onToast?.(`Stopped ${title}.`))
        .catch((error: unknown) => onToast?.(`Could not stop ${title}: ${String((error as Error)?.message ?? error)}`, 'error'));
      return;
    }
    if (armedStop) setArmedStop(false);
  });

  const steer = (text: string) => {
    const messageId = mintWireMessageId();
    createSessionPrompt(projectId, target.sessionId, {
      clientMessageId: messageId,
      messageId,
      remintOnDelivery: true,
      delivery: 'steer',
      parts: [{ type: 'text', text }],
      clientSentAtMs: Date.now(),
    })
      .then(() => onToast?.(`Sent to ${title}.`))
      .catch((error: unknown) => onToast?.(`Not sent: ${String((error as Error)?.message ?? error)}`, 'error'));
  };

  const status =
    view.status === 'loading'
      ? 'loading'
      : view.status === 'error'
        ? 'could not read it'
        : working
          ? 'working'
          : view.status === 'empty'
            ? 'no messages yet'
            : 'idle';
  const keys = armedStop ? 'Ctrl+X again to stop · any key cancels' : 'Esc back · Ctrl+O open · Ctrl+X stop';
  const inner = Math.max(width - 2, 12);

  return (
    <box flexDirection="column" width={width} height={height}>
      <box flexDirection="row" height={1} justifyContent="space-between" paddingLeft={1} paddingRight={1}>
        <text wrapMode="none">
          <span fg={theme.brand}>{'◇ '}</span>
          <span fg={theme.fg}>{title.slice(0, Math.max(inner - keys.length - 14, 8))}</span>
          <span fg={theme.faint}>{`  ${status}`}</span>
        </text>
        <text fg={armedStop ? theme.danger : theme.faint} wrapMode="none">
          {keys}
        </text>
      </box>
      <TranscriptSessionProvider projectId={projectId} sessionId={target.sessionId}>
      <scrollbox ref={scrollRef} flexGrow={1} stickyScroll stickyStart="bottom" contentOptions={{ flexDirection: 'column' }}>
        {view.status === 'loading' ? (
          <box flexDirection="row" paddingLeft={1}>
            <Spinner />
            <text fg={theme.faint}>{' Reading the session…'}</text>
          </box>
        ) : null}
        {messages.map((message) => (
          <Turn
            key={message.message_id}
            message={message}
            width={inner}
            expanded={EMPTY}
            cursorKey={null}
            streaming={working && message.message_id === last?.message_id}
            now={now}
          />
        ))}
      </scrollbox>
      </TranscriptSessionProvider>
      <PromptInput
        focused
        width={width}
        placeholder={`Message ${title} · it reads it at its next step`}
        context={NO_COMMANDS}
        busy={false}
        onSubmit={steer}
        onCommand={() => {}}
        onKey={(key) => {
          if (key.name === 'escape') {
            onClose();
            return true;
          }
          return false;
        }}
      />
    </box>
  );
}

const EMPTY: ReadonlySet<string> = new Set();
