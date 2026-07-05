'use client';

/**
 * One message from the sync store. The user turn is a right-aligned `Bubble`;
 * the assistant turn renders full-width as ordered content blocks (markdown,
 * collapsible reasoning, tool cards, file markers) — clean and monochrome.
 */

import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker';
import { Message } from '@/components/ui/message';
import type { MessageWithParts } from '@kortix/sdk/react';
import { Brain, ChevronRight, Paperclip, TriangleAlert } from 'lucide-react';
import { Markdown } from './markdown';
import { ToolCall } from './tool-call';

type AnyPart = MessageWithParts['parts'][number] & Record<string, any>;

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

function PartView({ part }: { part: AnyPart }) {
  switch (part.type) {
    case 'text':
      return part.text?.trim() ? <Markdown>{part.text}</Markdown> : null;
    case 'reasoning':
      return part.text?.trim() ? <Reasoning text={part.text} /> : null;
    case 'tool':
      return <ToolCall part={part} />;
    case 'file':
      return (
        <Marker className="w-fit text-foreground">
          <MarkerIcon>
            <Paperclip />
          </MarkerIcon>
          <MarkerContent>{part.filename ?? part.url ?? 'file'}</MarkerContent>
        </Marker>
      );
    default:
      return null; // step-start, step-finish, snapshot, agent
  }
}

/**
 * A failed assistant turn — the runtime attaches a typed `error` to the
 * message (provider auth, model unavailable, abort, context overflow, …) and
 * often produces ZERO parts. Without this block such a turn renders as
 * complete silence, which reads as "the app is broken" when it's really
 * "the model call failed" — surface the reason instead.
 */
function TurnError({ error }: { error: NonNullable<Extract<MessageWithParts['info'], { role: 'assistant' }>['error']> }) {
  const data = 'data' in error ? (error.data as { message?: string } | undefined) : undefined;
  const text = data?.message?.trim() || error.name || 'The agent run failed.';
  return (
    <Marker className="w-fit text-destructive" role="alert">
      <MarkerIcon>
        <TriangleAlert />
      </MarkerIcon>
      <MarkerContent>{text}</MarkerContent>
    </Marker>
  );
}

export function MessageView({ message }: { message: MessageWithParts }) {
  const isUser = message.info.role === 'user';
  const parts = (message.parts as AnyPart[]).filter(
    (p) => p.type !== 'step-start' && p.type !== 'step-finish',
  );

  if (isUser) {
    const text = parts
      .filter((p) => p.type === 'text')
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

  const error = message.info.role === 'assistant' ? message.info.error : undefined;
  if (parts.length === 0 && !error) return null;
  return (
    <div className="space-y-2.5 text-sm leading-relaxed">
      {parts.map((p, i) => (
        <PartView key={p.id ?? i} part={p} />
      ))}
      {error ? <TurnError error={error} /> : null}
    </div>
  );
}
