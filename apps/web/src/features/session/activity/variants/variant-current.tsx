'use client';

/**
 * "Today" — a faithful reproduction of what the transcript renders right now.
 *
 * Not a proposal. It exists so the demo compares against the real thing rather
 * than against a flattering memory of it. It deliberately keeps the bug: the
 * runtime's `step-start` / `step-finish` parts are treated as content, so every
 * run of tool calls fragments into singles and each one prints its raw command.
 * That is precisely why twelve identical `$ cd /workspace && …` rows appear.
 */

import { ToolPartRenderer } from '@/features/session/tool/tool-renderers';
import { type Turn, isTextPart, isToolPart, shouldShowToolPart } from '@/ui';
import { AssistantProse, UserBubble, useTurnParts, useTurns } from './shared';
import type { ChatVariantProps } from './types';

export function VariantCurrent({ messages, sessionId }: ChatVariantProps) {
  const turns = useTurns(messages);
  return (
    <div className="space-y-8">
      {turns.map((turn) => (
        <TurnBody key={turn.userMessage.info.id} turn={turn} sessionId={sessionId} />
      ))}
    </div>
  );
}

function TurnBody({ turn, sessionId }: { turn: Turn; sessionId: string }) {
  const parts = useTurnParts(turn);

  return (
    <div className="space-y-2">
      <UserBubble turn={turn} />
      {parts.map(({ part }) => {
        if (isTextPart(part) && part.text?.trim()) {
          return <AssistantProse key={part.id} text={part.text} />;
        }
        if (isToolPart(part) && shouldShowToolPart(part)) {
          return <ToolPartRenderer key={part.id} part={part} sessionId={sessionId} />;
        }
        return null;
      })}
    </div>
  );
}
