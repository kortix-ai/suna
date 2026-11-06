/**
 * One session-log message, rendered.
 *
 * A user message is a dim-bordered block; an assistant message is plain, so
 * the eye separates "what I asked" from "what it did" without color. A
 * compaction is one message (its marker and its summary) and renders plain,
 * under a `compaction` header.
 * Parts come from `classifySessionLogMessage` (the message's blocks as
 * `ClassifiedPart`s) and are laid out by `collapseToolRuns`, so
 * the part `switch` below is exhaustive over `ClassifiedPart['kind']` and a
 * new part type fails the build here.
 */

import {
  type ClassifiedPart,
  type NoticeBatchItem,
  type PeerMessagePromptInfo,
  type SessionLogMessage,
  type SubagentNotice,
  classifySessionLogMessage,
  parseNoticeBatch,
  parsePeerMessagePrompt,
  parseSubagentNotice,
  sessionLogMessageDelivery,
} from '@kortix/sdk';
import { useMemo } from 'react';

import { useAgentNav } from '../../agents/agent-nav.tsx';

import { printable } from '../../../lib/printable.ts';
import {
  type TurnRow,
  clip,
  collapseToolRuns,
  formatRelativeTime,
} from '../../../lib/turn-layout.ts';
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
  message: SessionLogMessage;
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

/** The prompt the reader typed; anything else (a reply, a compaction) is the agent's. */
const isPrompt = (message: SessionLogMessage) =>
  message.role === 'user' && message.kind !== 'compaction';

function Header({
  message,
  now,
  width,
}: { message: SessionLogMessage; now: number; width: number }) {
  const role = isPrompt(message) ? 'user' : 'assistant';
  const name =
    role === 'user'
      ? 'you'
      : message.kind === 'compaction'
        ? 'compaction'
        : message.agent || 'agent';
  const created = Date.parse(message.created_at);
  // A prompt the log does not hold yet says where it is instead of its age.
  const delivery = sessionLogMessageDelivery(message)?.delivery;
  const age =
    delivery === 'queued'
      ? 'queued'
      : delivery === 'delivering'
        ? 'sending'
        : Number.isFinite(created)
          ? formatRelativeTime(created, now)
          : '';
  return (
    <text fg={theme.dim} width={Math.max(width, 4)}>
      <span fg={theme.accent}>{ROLE_GLYPH[role]}</span>
      {` ${name}`}
      {age ? ` · ${age}` : ''}
    </text>
  );
}

export function Turn({ message, width, expanded, cursorKey, streaming, now }: TurnProps) {
  const classified = useMemo(() => classifySessionLogMessage(message), [message]);
  // A compaction is one line: its summary is the context the model continues from (with
  // the path of the full record it may read), written for the model, not for the reader.
  const shownParts = useMemo(
    () =>
      message.kind === 'compaction'
        ? classified.parts.filter((part) => part.kind === 'compaction')
        : classified.parts,
    [classified.parts, message.kind],
  );
  const rows: TurnRow[] = useMemo(() => collapseToolRuns(shownParts), [shownParts]);
  const isUser = isPrompt(message);
  const inner = Math.max(width - (isUser ? 4 : 0), 8);
  const lastRowKey = rows.at(-1)?.key;
  // A message another agent sent this session (`send_message`) arrives as a user turn in a
  // platform envelope. It is not the reader's words: one compact row names the sender.
  // The platform also writes a user turn when a background agent or a teammate finishes
  // (one notice, or a batch of them): one line per agent, not a turn of the reader's.
  const platform = useMemo(() => {
    if (message.role !== 'user') return null;
    const text = classified.parts.map((part) => (part.kind === 'text' ? part.text : '')).join('');
    const peer = parsePeerMessagePrompt(text);
    if (peer) return { peer } as const;
    const batch = parseNoticeBatch(text);
    if (batch?.length) return { notices: batch } as const;
    const notice = parseSubagentNotice(text);
    if (notice) return { notices: [{ kind: notice.kind, notice }] as NoticeBatchItem[] } as const;
    return null;
  }, [classified.parts, message.role]);
  if (platform && 'peer' in platform && platform.peer)
    return (
      <PeerMessageRow peer={platform.peer} width={width} now={now} createdAt={message.created_at} />
    );
  if (platform && 'notices' in platform)
    return <NoticeRows items={platform.notices} width={width} />;

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

const PEER_BODY_LINES = 4;

/** `✉ @reviewer · summary` and the first lines of the message, dim. */
function PeerMessageRow({
  peer,
  width,
  now,
  createdAt,
}: { peer: PeerMessagePromptInfo; width: number; now: number; createdAt: string }) {
  const created = Date.parse(createdAt);
  const age = Number.isFinite(created) ? formatRelativeTime(created, now) : '';
  const kind = peer.kind === 'message' ? '' : ` · ${peer.kind.replace(/_/g, ' ')}`;
  const lines = peer.text.split('\n').filter((line) => line.trim().length > 0);
  const shown = lines.slice(0, PEER_BODY_LINES);
  const inner = Math.max(width - 4, 8);
  return (
    <box flexDirection="column" marginBottom={1} paddingLeft={1}>
      <text wrapMode="none">
        <span fg={theme.brand}>{'✉ '}</span>
        <span fg={theme.fg}>{`@${printable(peer.from)}`}</span>
        <span
          fg={theme.dim}
        >{`${kind}${peer.summary ? ` · ${clip(printable(peer.summary), inner - peer.from.length - 8)}` : ''}`}</span>
        <span fg={theme.faint}>{age ? ` · ${age}` : ''}</span>
      </text>
      {shown.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: message lines have no id
        <text key={index} fg={theme.dim} wrapMode="none">
          {`  ${clip(printable(line), inner)}`}
        </text>
      ))}
      {lines.length > shown.length ? (
        <text fg={theme.faint}>{`  … ${lines.length - shown.length} more lines`}</text>
      ) : null}
    </box>
  );
}

/** `◇ reviewer finished · All 3 tests pass.`, one line per notice of the batch. */
function NoticeRows({ items, width }: { items: readonly NoticeBatchItem[]; width: number }) {
  const nav = useAgentNav();
  const inner = Math.max(width - 4, 8);
  return (
    <box flexDirection="column" marginBottom={1} paddingLeft={1}>
      {items.map((item, index) => {
        if (item.kind === 'peer_idle') {
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: notices have no id
            <text key={index} wrapMode="none" fg={theme.dim}>
              {`◇ @${printable(item.info.from)} is idle${item.info.summary ? ` · ${clip(printable(item.info.summary), inner - 20)}` : ''}`}
            </text>
          );
        }
        const notice: SubagentNotice = item.notice;
        const who = printable(
          notice.handle ? `@${notice.handle}` : notice.title || notice.agent || 'agent',
        );
        const verb =
          notice.status === 'completed'
            ? item.kind === 'teammate'
              ? 'is idle'
              : 'finished'
            : notice.status;
        const bad = notice.status !== 'completed';
        // A structured result (a workflow's JSON) has no first line worth showing.
        const excerpt = /^[[{]/.test(notice.excerpt.trim()) ? '' : notice.excerpt;
        return (
          <box
            // biome-ignore lint/suspicious/noArrayIndexKey: notices have no id
            key={index}
            onMouseDown={() => nav.peek({ sessionId: notice.sessionId, title: who })}
          >
            <text wrapMode="none">
              <span fg={bad ? theme.danger : theme.brand}>{'◇ '}</span>
              <span fg={theme.fg}>{who}</span>
              <span fg={theme.dim}>{` ${verb}`}</span>
              <span fg={theme.faint}>
                {excerpt
                  ? ` · ${clip(printable(excerpt), Math.max(inner - who.length - verb.length - 6, 8))}`
                  : ''}
              </span>
            </text>
          </box>
        );
      })}
    </box>
  );
}
