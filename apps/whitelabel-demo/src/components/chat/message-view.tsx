'use client';

/**
 * One message from the sync store. User messages are a right-aligned bubble;
 * assistant messages render full-width as ordered content blocks (markdown text,
 * collapsible reasoning, tool cards, files) — the same shape Kortix uses.
 */

import type { MessageWithParts } from '@kortix/sdk/react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Markdown } from './markdown';
import { ToolCall } from './tool-call';
import { Brain, ChevronRight, Paperclip } from 'lucide-react';

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
        <div className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs text-muted-foreground">
          <Paperclip className="size-3" />
          {part.filename ?? part.url ?? 'file'}
        </div>
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
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-secondary px-4 py-2.5 text-sm text-secondary-foreground">
          {text}
        </div>
      </div>
    );
  }

  if (parts.length === 0) return null;
  return (
    <div className="space-y-2.5">
      {parts.map((p, i) => (
        <PartView key={p.id ?? i} part={p} />
      ))}
    </div>
  );
}
