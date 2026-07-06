'use client';

/**
 * One message from the sync store. The user turn is a right-aligned `Bubble`;
 * the assistant turn renders full-width as ordered content blocks — clean and
 * monochrome.
 *
 * Rendering is driven by `classifyTurn`/`classifyPart` (`@kortix/sdk/turns`):
 * every one of opencode's 12 part types is classified into a typed
 * `ClassifiedPart`, and `renderParts` (`@kortix/sdk/react`) requires a
 * renderer for every kind at compile time — so a new part type (or one we
 * used to silently drop) fails the build here instead of quietly vanishing
 * from the transcript. See the per-kind comments below for what each
 * renderer deliberately does or doesn't show.
 */

import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker';
import { Message } from '@/components/ui/message';
import { type MessageWithParts, type PartRenderers, renderParts } from '@kortix/sdk/react';
import { classifyTurn } from '@kortix/sdk/turns';
import {
  Brain,
  ChevronRight,
  FileDiff,
  Paperclip,
  RefreshCw,
  Scissors,
  SquareDashedBottom,
  TriangleAlert,
} from 'lucide-react';
import { Fragment } from 'react';
import { Markdown } from './markdown';
import { ToolCall } from './tool-call';

function Reasoning({ text }: { text: string }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
        <Brain className="size-3.5" />
        <span>Thought process</span>
        <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="mt-1.5 whitespace-pre-wrap border-l-2 border-border pl-3 text-xs italic leading-relaxed text-muted-foreground">
          {text}
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * One renderer per `ClassifiedPart['kind']`. `PartRenderers<T>`'s type
 * requires every key, so removing a case (or opencode adding a new part
 * type) is a compile error here, not a silent drop in production.
 */
const partRenderers: PartRenderers<React.ReactNode> = {
  text: (part) => (part.text.trim() ? <Markdown>{part.text}</Markdown> : null),
  reasoning: (part) => (part.text.trim() ? <Reasoning text={part.text} /> : null),
  tool: (part) => <ToolCall tool={part.tool} />,
  file: (part) => (
    <Marker className="w-fit text-foreground">
      <MarkerIcon>
        <Paperclip />
      </MarkerIcon>
      <MarkerContent>{part.filename ?? part.url}</MarkerContent>
    </Marker>
  ),
  // A sub-agent delegation. `part.description`/`part.agent` mirror the
  // `task` tool card, but subtask parts stand alone (no tool-state machine).
  subtask: (part) => (
    <Marker className="w-fit text-foreground">
      <MarkerIcon>
        <SquareDashedBottom />
      </MarkerIcon>
      <MarkerContent>
        {part.description ? `${part.description} (${part.agent})` : `Delegated to ${part.agent}`}
      </MarkerContent>
    </Marker>
  ),
  // Compact diff-stat line — the full diff lives in the Changes panel, not the
  // chat transcript.
  patch: (part) => (
    <Marker className="w-fit text-foreground">
      <MarkerIcon>
        <FileDiff />
      </MarkerIcon>
      <MarkerContent>
        {part.fileCount} file{part.fileCount === 1 ? '' : 's'} changed
      </MarkerContent>
    </Marker>
  ),
  // An internal git checkpoint hash used for session revert — never
  // user-facing content, so there is nothing worth rendering here.
  snapshot: () => null,
  // An inline `@agent` mention token. Its text already appears verbatim
  // inside the sibling text part it was parsed out of (`source.start/end`
  // point back into that text) — rendering it again here would duplicate it.
  agent: () => null,
  // A model-call retry after a transient failure (rate limit, provider
  // hiccup). Worth a subtle system note so a stalled-looking turn doesn't
  // read as broken.
  retry: (part) => (
    <Marker className="w-fit text-muted-foreground">
      <MarkerIcon>
        <RefreshCw />
      </MarkerIcon>
      <MarkerContent>{`Retrying (attempt ${part.attempt}): ${part.message}`}</MarkerContent>
    </Marker>
  ),
  // Context was compacted (auto or manual) to make room in the context
  // window. Subtle system note, not an error.
  compaction: (part) => (
    <Marker className="w-fit text-muted-foreground">
      <MarkerIcon>
        <Scissors />
      </MarkerIcon>
      <MarkerContent>
        {part.auto ? 'Context compacted automatically' : 'Context compacted'}
      </MarkerContent>
    </Marker>
  ),
  // step-start/step-finish are pure model-step bookkeeping (cost/token
  // accounting lives in the session-level cost summary elsewhere) — no
  // chat-visible content of their own.
  step: () => null,
  // Forward-compat: a part type this build doesn't recognize yet (client
  // older than server). Drop silently rather than break the transcript.
  unknown: () => null,
};

/**
 * A failed assistant turn — the runtime attaches a typed `error` to the
 * message (provider auth, model unavailable, abort, context overflow, …) and
 * often produces ZERO parts. Without this block such a turn renders as
 * complete silence, which reads as "the app is broken" when it's really
 * "the model call failed" — surface the reason instead. `classifyTurn`
 * normalizes `info.error` into `{name, message}` at the SDK layer, so this
 * component doesn't need to know about opencode's error-union shape at all.
 */
function TurnError({ error }: { error: { name: string; message: string } }) {
  return (
    <Marker className="w-fit text-destructive" role="alert">
      <MarkerIcon>
        <TriangleAlert />
      </MarkerIcon>
      <MarkerContent>{error.message || error.name}</MarkerContent>
    </Marker>
  );
}

export function MessageView({ message }: { message: MessageWithParts }) {
  const isUser = message.info.role === 'user';
  const { parts, error, isEmpty } = classifyTurn(message);

  if (isUser) {
    const text = parts
      .filter((p) => p.kind === 'text')
      .map((p) => p.text)
      .join('\n')
      .trim();
    if (!text) return null;
    // Bubble sits directly in the row (no min-w-0 column) so it sizes to its
    // content up to max-width — never collapses to a sliver.
    return (
      <Message align="end">
        <Bubble variant="secondary" align="end">
          <BubbleContent>{text}</BubbleContent>
        </Bubble>
      </Message>
    );
  }

  if (isEmpty) return null;
  return (
    <div className="space-y-2.5 text-sm leading-relaxed">
      {/* Fragment (not a div) so parts that deliberately render `null`
          (step/snapshot/agent/unknown) don't leave behind an empty spacer
          under `space-y-2.5`. */}
      {renderParts(parts, partRenderers).map((node, i) => {
        const part = parts[i];
        // `ClassifiedUnknownPart` has no `id` (it's raw, unrecognized wire
        // data) — fall back to index for that one kind, which is safe since
        // a message's parts array is append-only for the lifetime of the
        // render.
        const key = part.kind === 'unknown' ? i : part.id;
        return <Fragment key={key}>{node}</Fragment>;
      })}
      {error ? <TurnError error={error} /> : null}
    </div>
  );
}
