/**
 * One message, rendered.
 *
 * A user message is a dim-bordered block; an assistant message is plain, so
 * the eye separates "what I asked" from "what it did" without color.
 * Parts come from `classifyTurn` and are laid out by `collapseToolRuns`, so
 * the part `switch` below is exhaustive over `ClassifiedPart['kind']` and a
 * new opencode part type fails the build here.
 */

import { type ClassifiedPart, type MessageWithParts, classifyTurn } from '@kortix/sdk';
import { useMemo } from 'react';

import { type TurnRow, collapseToolRuns, formatRelativeTime } from '../../../lib/turn-layout.ts';
import { theme } from '../../../theme.ts';
import { ErrorBanner, describeTurnError } from './error-banner.tsx';
import {
  CompactionPart,
  FilePart,
  PatchPart,
  RetryPart,
  SubtaskPart,
  UnknownPart,
} from './parts/misc-parts.tsx';
import { ReasoningPart } from './parts/reasoning-part.tsx';
import { TextPart } from './parts/text-part.tsx';
import { StepsGroup } from './steps-group.tsx';
import { ToolCard } from './tool-card.tsx';

/** `❯` is the prompt the reader typed; `◆` is the agent answering. */
const ROLE_GLYPH = { user: '❯', assistant: '◆' } as const;

export interface TurnProps {
  message: MessageWithParts;
  width: number;
  /** Row keys the reader has expanded. */
  expanded: ReadonlySet<string>;
  /** The row the cursor is on, or null. Only drawn when the transcript has focus. */
  cursorKey: string | null;
  /** True when this is the last message of a turn that is still running. */
  streaming: boolean;
  /** Passed in, not read per turn, so one clock drives every header. */
  now: number;
}

function PartRow({
  part,
  width,
  expanded,
  cursor,
  streaming,
}: {
  part: ClassifiedPart;
  width: number;
  expanded: boolean;
  cursor: boolean;
  streaming: boolean;
}) {
  switch (part.kind) {
    case 'text':
      return <TextPart text={part.text} streaming={streaming} width={width} />;
    case 'reasoning':
      return <ReasoningPart text={part.text} expanded={expanded} cursor={cursor} width={width} />;
    // A lone tool call is its own card, never a one-row group. `collapseToolRuns`
    // already refuses to fold a run of one; wrapping it here put the
    // "▾ Completed 1 step" header back on top of a single card — verified in a
    // live run before this line existed.
    case 'tool':
      return <ToolCard tool={part.tool} width={width} />;
    case 'file':
      return <FilePart part={part} width={width} />;
    case 'subtask':
      return <SubtaskPart part={part} width={width} />;
    case 'patch':
      return <PatchPart part={part} width={width} />;
    case 'retry':
      return <RetryPart part={part} width={width} />;
    case 'compaction':
      return <CompactionPart part={part} width={width} />;
    // `isRenderablePart` drops these before a row is built; the cases exist so
    // the switch stays exhaustive.
    case 'step':
    case 'snapshot':
    case 'agent':
      return null;
    case 'unknown':
      return <UnknownPart width={width} />;
    default: {
      const _exhaustive: never = part;
      return _exhaustive;
    }
  }
}

function Header({
  message,
  now,
  width,
}: { message: MessageWithParts; now: number; width: number }) {
  const role = message.info.role === 'user' ? 'user' : 'assistant';
  const agent = 'agent' in message.info ? message.info.agent : undefined;
  const name = role === 'user' ? 'you' : agent || 'agent';
  const created = message.info.time?.created;
  const age = typeof created === 'number' ? formatRelativeTime(created, now) : '';
  return (
    <text fg={theme.dim} width={Math.max(width, 4)}>
      <span fg={theme.accent}>{ROLE_GLYPH[role]}</span>
      {` ${name}`}
      {age ? ` · ${age}` : ''}
    </text>
  );
}

export function Turn({ message, width, expanded, cursorKey, streaming, now }: TurnProps) {
  const classified = useMemo(() => classifyTurn(message), [message]);
  const rows: TurnRow[] = useMemo(() => collapseToolRuns(classified.parts), [classified.parts]);
  const isUser = message.info.role === 'user';
  const inner = Math.max(width - (isUser ? 4 : 0), 8);
  const lastRowKey = rows.at(-1)?.key;

  const body = (
    <box flexDirection="column" width={inner}>
      <Header message={message} now={now} width={inner} />
      {rows.map((row) =>
        row.kind === 'steps' ? (
          <StepsGroup
            key={row.key}
            tools={row.tools}
            expanded={expanded.has(row.key)}
            cursor={cursorKey === row.key}
            width={inner}
          />
        ) : (
          <PartRow
            key={row.key}
            part={row.part}
            width={inner}
            expanded={expanded.has(row.key)}
            cursor={cursorKey === row.key}
            streaming={streaming && row.key === lastRowKey}
          />
        ),
      )}
      {classified.error ? (
        <ErrorBanner content={describeTurnError(classified.error)} width={inner} />
      ) : null}
      {classified.isEmpty && rows.length === 0 ? <text fg={theme.faint}>(no content)</text> : null}
    </box>
  );

  if (!isUser) {
    return (
      <box flexDirection="column" marginBottom={1}>
        {body}
      </box>
    );
  }

  return (
    <box
      flexDirection="column"
      border
      borderStyle="single"
      borderColor={theme.border}
      paddingLeft={1}
      paddingRight={1}
      marginBottom={1}
      width={Math.max(width, 12)}
    >
      {body}
    </box>
  );
}
