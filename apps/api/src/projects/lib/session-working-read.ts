import type { SessionWorking } from '@kortix/api-contract';
import { listInboxPromptsForSessions } from '../session-lifecycle/inbox-rows';
import { readSessionTurnStates } from './session-turn-read';
import { sessionRuntimeTurnEnds } from './session-runtime-turn-ends';
import { deriveSessionWorking } from './session-working';

/** Call only after visibility/pagination: no work state from inaccessible sessions. */
export async function readSessionsWorking(sessionIds: string[]): Promise<Map<string, SessionWorking>> {
  if (sessionIds.length === 0) return new Map();
  const [turns, prompts] = await Promise.all([
    readSessionTurnStates(sessionIds),
    listInboxPromptsForSessions(sessionIds),
  ]);
  const promptsBySession = new Map<string, Awaited<ReturnType<typeof listInboxPromptsForSessions>>>();
  for (const row of prompts) {
    if (!row.sessionId) continue;
    const queue = promptsBySession.get(row.sessionId) ?? [];
    queue.push(row);
    promptsBySession.set(row.sessionId, queue);
  }
  return new Map(sessionIds.map(id => [id, deriveSessionWorking(
    turns.get(id) ?? { turns: [] },
    promptsBySession.get(id) ?? [],
    sessionRuntimeTurnEnds(id),
  )]));
}
