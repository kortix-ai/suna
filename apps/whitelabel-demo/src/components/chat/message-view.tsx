'use client';

/**
 * Renders one agent/user message from the sync store. A message is an `info`
 * (role + metadata) plus an ordered list of `parts` (text, reasoning, tool
 * calls, files). We render the part types that matter for a chat transcript and
 * skip the structural ones (step-start/step-finish/snapshot).
 */

import type { MessageWithParts } from '@kortix/sdk/react';
import { cn } from '@/lib/utils';
import { Wrench } from 'lucide-react';

// The opencode Part union is broad; read fields defensively.
type AnyPart = MessageWithParts['parts'][number] & Record<string, any>;

function ToolPart({ part }: { part: AnyPart }) {
  const name = part.tool ?? 'tool';
  const stateStatus: string | undefined = part.state?.status;
  const done = stateStatus === 'completed';
  const errored = stateStatus === 'error';
  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs',
        errored
          ? 'border-red-500/30 bg-red-500/5 text-red-300'
          : 'border-[var(--color-border)] bg-[var(--color-panel-2)] text-[var(--color-muted)]',
      )}
    >
      <Wrench className="size-3.5 shrink-0" />
      <span className="font-medium text-[var(--color-fg)]">{name}</span>
      {stateStatus && !done && !errored && (
        <span className="animate-pulse">{stateStatus}…</span>
      )}
      {errored && <span>failed</span>}
    </div>
  );
}

function Part({ part }: { part: AnyPart }) {
  switch (part.type) {
    case 'text':
      return part.text ? (
        <p className="whitespace-pre-wrap leading-relaxed">{part.text}</p>
      ) : null;
    case 'reasoning':
      return part.text ? (
        <p className="whitespace-pre-wrap text-xs italic leading-relaxed text-[var(--color-muted)]">
          {part.text}
        </p>
      ) : null;
    case 'tool':
      return <ToolPart part={part} />;
    case 'file':
      return (
        <div className="text-xs text-[var(--color-muted)]">
          📎 {part.filename ?? part.url ?? 'file'}
        </div>
      );
    default:
      return null; // step-start, step-finish, snapshot, agent — structural
  }
}

export function MessageView({ message }: { message: MessageWithParts }) {
  const isUser = message.info.role === 'user';
  const parts = message.parts.filter(
    (p) => p.type !== 'step-start' && p.type !== 'step-finish',
  );
  if (parts.length === 0) return null;

  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[80%] space-y-2 rounded-2xl px-4 py-2.5 text-sm',
          isUser
            ? 'bg-[var(--color-accent)] text-[var(--color-accent-fg)]'
            : 'bg-[var(--color-panel)] text-[var(--color-fg)]',
        )}
      >
        {parts.map((p, i) => (
          <Part key={(p as AnyPart).id ?? i} part={p as AnyPart} />
        ))}
      </div>
    </div>
  );
}
