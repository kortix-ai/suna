'use client';

/**
 * Pieces every chat variant needs and none of them should own an opinion
 * about — the user bubble, assistant prose, and the turn walk.
 *
 * Anything that expresses a variant's THESIS (how work folds, what a collapsed
 * run looks like) belongs in the variant file, not here.
 */

import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { cn } from '@/lib/utils';
import {
  type MessageWithParts,
  type Turn,
  collectTurnParts,
  groupMessagesIntoTurns,
  isTextPart,
} from '@/ui';
import { useMemo } from 'react';

export function useTurns(messages: MessageWithParts[]): Turn[] {
  return useMemo(() => groupMessagesIntoTurns(messages) as Turn[], [messages]);
}

export function useTurnParts(turn: Turn) {
  return useMemo(() => collectTurnParts(turn), [turn]);
}

/** The user's own message. Right-aligned bubble, the one thing that never folds. */
export function UserBubble({ turn }: { turn: Turn }) {
  const body = useMemo(
    () =>
      turn.userMessage.parts
        .filter(isTextPart)
        .map((p) => p.text ?? '')
        .join('\n')
        .trim(),
    [turn.userMessage.parts],
  );
  if (!body) return null;
  return (
    <div className="flex justify-end">
      <div className="bg-muted/70 text-foreground max-w-[85%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap">
        {body}
      </div>
    </div>
  );
}

/** Assistant prose. The thing the transcript is actually for. */
export function AssistantProse({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  if (!text.trim()) return null;
  return (
    <div className={cn('min-w-0 text-sm', className)}>
      <UnifiedMarkdown content={text} />
    </div>
  );
}
