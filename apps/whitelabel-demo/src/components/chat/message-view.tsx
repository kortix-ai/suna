'use client';

/**
 * One message from the sync store, composed from the shadcn chat primitives.
 * User turns are a right-aligned `Bubble`; assistant turns render as a left
 * `Message` row (brand avatar + full-width content blocks: markdown, collapsible
 * reasoning, tool cards, file markers).
 */

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker';
import { Message, MessageAvatar, MessageContent } from '@/components/ui/message';
import type { MessageWithParts } from '@kortix/sdk/react';
import { Brain, ChevronRight, Paperclip } from 'lucide-react';
import { Markdown } from './markdown';
import { ToolCall } from './tool-call';

type AnyPart = MessageWithParts['parts'][number] & Record<string, any>;

function Reasoning({ text }: { text: string }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
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
    return (
      <Message align="end">
        <MessageContent>
          <Bubble variant="secondary" align="end">
            <BubbleContent>{text}</BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>
    );
  }

  if (parts.length === 0) return null;
  return (
    <Message align="start">
      <MessageAvatar>
        <Avatar className="size-7">
          <AvatarFallback className="bg-brand/15 text-xs font-semibold text-brand">K</AvatarFallback>
        </Avatar>
      </MessageAvatar>
      <MessageContent className="gap-2.5 pt-0.5">
        {parts.map((p, i) => (
          <PartView key={p.id ?? i} part={p} />
        ))}
      </MessageContent>
    </Message>
  );
}
