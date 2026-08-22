/**
 * The host facts `SessionChat` derives around a transcript, computed the same
 * way for a fixture scenario — so the legacy turn list (the golden's source)
 * and `SessionTimelineList` (the golden's subject) are fed identical inputs.
 *
 * Each derivation mirrors the `useMemo` of the same name in `session-chat.tsx`.
 */
import { isAbortError } from '@kortix/sdk';
import { groupMessagesIntoTurns, type Turn } from '@/ui';

import { planAnchorMessageId } from '../../turn/plan-anchor';
import { resolveWorkingTurn } from '../../turn/working-turn';
import type { TimelineScenario } from './transcript';

export interface HostFacts {
  turns: Turn[];
  workingTurnId: string | null;
  pendingTurnIds: Set<string>;
  interruptedTurnIds: Set<string>;
  planAnchorId: string | null;
  lastUserMessageId: string | null;
  /** Identity aliasing: no optimistic origins in a fixture. */
  turnRenderKeys: Map<string, string>;
}

export function deriveHostFacts(scenario: TimelineScenario): HostFacts {
  const { messages, lastTurnWorking } = scenario;
  const turns = groupMessagesIntoTurns(messages);
  const workingTurn = resolveWorkingTurn({ turns, hintMessageId: null });
  const pendingTurnIds = new Set(workingTurn.pendingTurnIds);

  let interruptedTurnIds = new Set<string>();
  if (!lastTurnWorking) {
    let newestWithContent = -1;
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].assistantMessages.length > 0) {
        newestWithContent = i;
        break;
      }
    }
    if (newestWithContent >= 0 && newestWithContent !== turns.length - 1) {
      const last = turns[newestWithContent].assistantMessages.at(-1);
      if (last && isAbortError((last.info as { error?: unknown }).error)) {
        interruptedTurnIds = new Set(
          turns.slice(newestWithContent + 1).map((t) => t.userMessage.info.id),
        );
      }
    }
  }

  let lastUserMessageId: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].info.role === 'user') {
      lastUserMessageId = messages[i].info.id;
      break;
    }
  }

  return {
    turns,
    workingTurnId: workingTurn.workingTurnId,
    pendingTurnIds,
    interruptedTurnIds,
    planAnchorId: planAnchorMessageId(messages),
    lastUserMessageId,
    turnRenderKeys: new Map(turns.map((t) => [t.userMessage.info.id, t.userMessage.info.id])),
  };
}
