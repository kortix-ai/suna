'use client';

/**
 * One message of the session log (`kortix.session/2`). The user turn is an
 * end-aligned `Bubble`; the assistant turn (and a compaction) renders full
 * width as ordered content blocks.
 *
 * `classifySessionLogMessage` (`@kortix/sdk`) types every block as a
 * `ClassifiedPart`, and `renderParts` (`@kortix/sdk/react`) requires a
 * renderer for every kind at compile time: a new part type fails the build
 * here instead of vanishing from the transcript. A host overrides any kind
 * through `renderers`, or only the tool card through `renderTool`.
 */

import {
  ArrowsClockwiseIcon,
  BrainIcon,
  CaretRightIcon,
  GitDiffIcon,
  PaperclipIcon,
  RobotIcon,
  ScissorsIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react';
import { type SessionLogMessage, type ToolView, classifySessionLogMessage } from '@kortix/sdk';
import { type PartRenderers, renderParts } from '@kortix/sdk/react';
import { Fragment, type ReactNode } from 'react';

import { Bubble, BubbleContent } from '../components/ui/bubble';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../components/ui/collapsible';
import { Marker, MarkerContent, MarkerIcon } from '../components/ui/marker';
import { Message } from '../components/ui/message';
import { type ChatStrings, useUiStrings } from '../providers/ui-provider';
import { Markdown } from './markdown';
import { ToolCall } from './tool-call';
import { userMessageParts } from './user-message-parts';

/** Replaces the default card for one tool call. Return `undefined` to keep the default. */
export type RenderTool = (tool: ToolView) => ReactNode | undefined;

export type MessageRenderers = Partial<PartRenderers<ReactNode>>;

function Reasoning({ text }: { text: string }) {
  const t = useUiStrings().chat;
  return (
    <Collapsible>
      <CollapsibleTrigger className="group text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-xs transition-colors motion-reduce:transition-none">
        <BrainIcon className="size-3.5" />
        <span>{t.thoughtProcess}</span>
        <CaretRightIcon className="size-3 transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="border-border text-muted-foreground mt-1.5 border-l-2 pl-3 text-xs leading-relaxed whitespace-pre-wrap">
          {text}
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}

function Note({ icon, children, tone = 'foreground' }: { icon: ReactNode; children: ReactNode; tone?: 'foreground' | 'muted' }) {
  return (
    <Marker className={tone === 'muted' ? 'w-fit' : 'text-foreground w-fit'}>
      <MarkerIcon>{icon}</MarkerIcon>
      <MarkerContent>{children}</MarkerContent>
    </Marker>
  );
}

/** One renderer per `ClassifiedPart['kind']`; the type requires every key. */
function defaultRenderers(t: ChatStrings, streaming: boolean, renderTool?: RenderTool): PartRenderers<ReactNode> {
  return {
    text: (part) => (part.text.trim() ? <Markdown streaming={streaming}>{part.text}</Markdown> : null),
    reasoning: (part) => (part.text.trim() ? <Reasoning text={part.text} /> : null),
    tool: (part) => renderTool?.(part.tool) ?? <ToolCall tool={part.tool} />,
    file: (part) => <Note icon={<PaperclipIcon />}>{part.filename ?? part.url}</Note>,
    // A sub-agent delegation; it stands alone, with no tool-state machine.
    subtask: (part) => (
      <Note icon={<RobotIcon />}>
        {part.description ? `${part.description} (${part.agent})` : t.delegatedTo(part.agent)}
      </Note>
    ),
    // A diff-stat line. The full diff belongs in a changes panel, not the transcript.
    patch: (part) => (
      <Note icon={<GitDiffIcon />}>
        {t.filesChanged(part.fileCount)}
      </Note>
    ),
    // An internal git checkpoint for revert: never user-facing.
    snapshot: () => null,
    // An inline `@agent` token: its text is already in the sibling text part.
    agent: () => null,
    // A model-call retry after a transient failure, so a stalled turn does not read as broken.
    retry: (part) => (
      <Note tone="muted" icon={<ArrowsClockwiseIcon />}>{t.retrying(part.attempt, part.message)}</Note>
    ),
    compaction: (part) => (
      <Note tone="muted" icon={<ScissorsIcon />}>
        {part.auto ? t.contextCompactedAuto : t.contextCompacted}
      </Note>
    ),
    // Step bookkeeping (cost and tokens) has no chat-visible content.
    step: () => null,
    // A part type this build does not know yet (client older than server).
    unknown: () => null,
  };
}

/**
 * A failed assistant turn: the runtime attaches a typed `error` and often
 * zero parts. Without this the turn renders as silence.
 */
function TurnError({ error, autoRetries }: { error: { name: string; message: string }; autoRetries?: number }) {
  const t = useUiStrings().chat;
  return (
    <div>
      <Marker className="text-foreground w-fit" role="alert">
        <MarkerIcon>
          <WarningCircleIcon weight="fill" className="text-destructive" />
        </MarkerIcon>
        <MarkerContent className="whitespace-normal">{error.message || error.name}</MarkerContent>
      </Marker>
      {autoRetries ? (
        <p className="text-muted-foreground mt-1 text-xs" data-auto-retry-note>
          {t.autoRetried(autoRetries)}
        </p>
      ) : null}
    </div>
  );
}

export function MessageView({
  message,
  renderers,
  renderTool,
  hideError,
  autoRetries,
}: {
  message: SessionLogMessage;
  /** Overrides the default renderer of any part kind. */
  renderers?: MessageRenderers;
  /** Overrides the tool card only; `undefined` keeps the default `ToolCall`. */
  renderTool?: RenderTool;
  /** Drops the error row: the harness continued this failure automatically. */
  hideError?: boolean;
  /** Automatic retries that ran before this failure; adds a note under the error row. */
  autoRetries?: number;
}) {
  const t = useUiStrings().chat;
  // A streaming message holds back half-written markdown syntax.
  const streaming = message.status === 'streaming';
  const all = { ...defaultRenderers(t, streaming, renderTool), ...renderers } as PartRenderers<ReactNode>;
  const { parts, error, isEmpty } = classifySessionLogMessage(message);
  const keyOf = (part: (typeof parts)[number], i: number) => (part.kind === 'unknown' ? i : part.id);

  if (message.role === 'user' && message.kind !== 'compaction') {
    const user = userMessageParts(parts);
    if (!user.text && !user.parts.length) return null;
    return (
      <Message align="end" data-message-role="user">
        <Bubble align="end">
          {user.text ? <BubbleContent>{user.text}</BubbleContent> : null}
          {renderParts(user.parts, all).map((node, i) => (
            <Fragment key={keyOf(user.parts[i], i)}>{node}</Fragment>
          ))}
        </Bubble>
      </Message>
    );
  }

  if (isEmpty) return null;
  const shownError = hideError ? null : error;
  const nodes = renderParts(parts, all);
  // A continued failure with no content of its own leaves nothing to show.
  if (!shownError && nodes.every((node) => node == null)) return null;
  return (
    <div data-message-role="assistant" className="space-y-2.5 text-sm leading-relaxed">
      {/* Fragments, so parts that render null leave no spacer under space-y. */}
      {nodes.map((node, i) => (
        <Fragment key={keyOf(parts[i], i)}>{node}</Fragment>
      ))}
      {shownError ? <TurnError error={shownError} autoRetries={autoRetries} /> : null}
    </div>
  );
}
