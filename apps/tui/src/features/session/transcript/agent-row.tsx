/**
 * An `agent` call as a live row, as Claude Code draws its Task tool:
 *
 *   ⠙ reviewer · Review the diff                       background · kimi-k3
 *     ⎿ read src/auth.ts
 *
 * While the agent works, the second line is its last step, read live from its
 * own session (`useSessionView`: the API's log and stream, never its box). Once
 * it reported, the line is the first line of its report. A click opens the peek
 * (`features/agents/agent-nav.tsx`); `/agents` lists every agent with keys.
 */

import {
  type SessionLogMessage,
  type ToolView,
  type ToolViewModel,
  classifySessionLogMessage,
  sessionLogTurns,
  toolViewModel,
} from '@kortix/sdk';
import { useSessionChildren, useSessionView } from '@kortix/sdk/react';
import { useEffect, useMemo, useState } from 'react';

import { printable } from '../../../lib/printable.ts';
import { clip, orderedMessages } from '../../../lib/turn-layout.ts';
import { theme } from '../../../theme.ts';
import { Spinner } from '../../../ui/index.ts';
import { useAgentNav } from '../../agents/agent-nav.tsx';
import { useTranscriptSession } from './session-context.tsx';

type TaskModel = Extract<ToolViewModel, { kind: 'task' }>;

export interface AgentRowProps {
  tool: ToolView;
  model: TaskModel;
  width: number;
}

/** The last thing an agent did: its newest tool call's title, else its newest line of text. */
export function lastStep(messages: readonly SessionLogMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== 'assistant') continue;
    const parts = classifySessionLogMessage(message).parts;
    for (let j = parts.length - 1; j >= 0; j -= 1) {
      const part = parts[j];
      if (part?.kind === 'tool') return stepLabel(part.tool);
      if (part?.kind === 'text') {
        const line = part.text
          .split('\n')
          .map((value) => value.trim())
          .filter(Boolean)
          .at(-1);
        if (line) return line;
      }
    }
  }
  return null;
}

const CHILDREN_POLL_MS = 5_000;
const CHILDREN_LIMIT = 50;

function reportFailed(board: string | undefined): boolean {
  return board === 'failed';
}

/** What a tool call did, in a few words: `$ npm test`, `read src/auth.ts`, `search TODO`. */
export function stepLabel(tool: ToolView): string {
  const model = toolViewModel(tool);
  switch (model.kind) {
    case 'shell':
      return model.command ? `$ ${model.command.split('\n')[0]}` : tool.title;
    case 'file-read':
      return `read ${model.path}`;
    case 'file-write':
      return `write ${model.path}`;
    case 'file-edit':
      return `edit ${model.path}`;
    case 'search':
      return `search ${model.pattern}`;
    case 'web-search':
      return `web ${model.query}`;
    case 'task':
      return `agent · ${model.description}`;
    default:
      return tool.title || tool.name;
  }
}

export function AgentRow({ tool, model, width }: AgentRowProps) {
  const nav = useAgentNav();
  const { projectId, sessionId: parentId } = useTranscriptSession();
  const running = tool.status === 'running' || tool.status === 'pending' || Boolean(model.started);
  // A background agent's report, once its last turn ended. Latched: the row then stops
  // watching its session (no stream left open for a finished agent).
  const [report, setReport] = useState<string | null>(null);
  const live = running && report === null && Boolean(projectId && model.sessionId);
  const view = useSessionView(projectId ?? '', model.sessionId ?? '', { enabled: live, throttleMs: 500 });
  const childMessages = useMemo(
    () => (view.thread ? orderedMessages(sessionLogTurns(view.thread)) : []),
    [view.thread],
  );
  const childWorking = childMessages.at(-1)?.status === 'streaming';
  const step = live ? lastStep(childMessages) : null;
  // A background agent whose last turn ended has reported: its last words are the report.
  // The child's own record says when it is over (`board_state`), with its report's first
  // line: the same polled list the /agents panel reads, one query for every row.
  const children = useSessionChildren(projectId ?? '', parentId ?? '', {
    enabled: live && Boolean(parentId),
    refetchInterval: CHILDREN_POLL_MS,
    limit: CHILDREN_LIMIT,
  });
  const childRow = children.sessions.find((row) => row.session_id === model.sessionId);
  const board = childRow?.board_state;
  const childDone =
    board === 'completed' ||
    board === 'failed' ||
    board === 'stopped' ||
    (Boolean(model.started) && view.status === 'ready' && !childWorking && childMessages.at(-1)?.role === 'assistant' && board !== 'working');
  useEffect(() => {
    if (childDone && report === null) setReport(childRow?.result_excerpt ?? step ?? '');
  }, [childDone, report, step, childRow?.result_excerpt]);

  const label = printable(model.name || model.agent || 'agent');
  const tags = [model.teammate ? 'teammate' : model.background ? 'background' : null, model.model]
    .filter(Boolean)
    .join(' · ');
  const inner = Math.max(width - 2, 12);
  const failed = tool.status === 'error' || (report !== null && reportFailed(board));
  const done = !failed && (!running || report !== null);
  // A background agent the call started: working while its session streams.
  // Working: its log streams, or its record says so (polled; the log may lag a turn).
  const working = childWorking || board === 'working';
  const spinning = !done && !failed && (tool.status === 'running' || tool.status === 'pending' || (Boolean(model.started) && working));
  const detail = failed
    ? (tool.error ?? (report || 'failed'))
    : done
      ? (model.resultExcerpt ?? (report || step))
      : step
        ? step
        : working
          ? 'working'
          : model.started && view.status === 'ready'
            ? 'idle'
            : 'starting';

  const open = () => {
    if (model.sessionId) nav.peek({ sessionId: model.sessionId, title: label });
  };

  return (
    <box flexDirection="column" onMouseDown={open}>
      <box flexDirection="row" height={1}>
        {spinning ? <Spinner /> : <text fg={failed ? theme.danger : theme.dim}>{failed ? '✗' : done ? '✓' : '·'}</text>}
        <text wrapMode="none" flexGrow={1}>
          <span fg={theme.fg}>{` ${label}`}</span>
          <span fg={theme.dim}>{` · ${clip(printable(model.description), Math.max(inner - label.length - tags.length - 8, 8))}`}</span>
        </text>
        {tags ? (
          <text fg={theme.faint} wrapMode="none">
            {` ${tags}`}
          </text>
        ) : null}
      </box>
      {detail ? (
        <text fg={failed ? theme.danger : theme.faint} wrapMode="none">
          {`  ⎿ ${clip(plainLine(detail), inner - 4)}`}
        </text>
      ) : null}
    </box>
  );
}

/** One line of Markdown as plain text: no `**`, backticks or heading marks, no control characters. */
export function plainLine(text: string): string {
  return printable(text)
    .replace(/^#+\s+/, '')
    .replace(/\*\*|__|`/g, '')
    .trim();
}
