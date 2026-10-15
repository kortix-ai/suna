/**
 * Test fixtures for the session log. Tests build v1 transcript rows (the
 * shape a fixture is easiest to write in); these convert them to what the app
 * renders: the `fromV1` live view the SDK serves while a session reads v1
 * (`sessionLogOfV1Rows`, `useSessionLogThread`), and its block turns
 * (`sessionLogTurns`). Test-only.
 */
import {
  sessionLogOfV1Rows,
  sessionLogTurns,
  type SessionLogBlock,
  type SessionLogThread,
  type SessionLogTurn,
  type SessionLogTurnsOptions,
} from '@kortix/sdk';

/** v1 rows as one thread: `{ info, parts }[]`, any order. */
export function threadOf(rows: readonly unknown[], runtimeSessionId = 'ses_test'): SessionLogThread {
  return (
    sessionLogOfV1Rows('kses_test', runtimeSessionId, rows as never).threads[0] ?? {
      schema: 'kortix.session/2',
      v: 1,
      thread_id: runtimeSessionId,
      parent_thread_id: null,
      spawned_by: null,
      agent: null,
      title: null,
      created_at: '',
      messages: [],
    }
  );
}

/** v1 rows as the block turns the transcript renders. */
export function turnsOf(rows: readonly unknown[], options?: SessionLogTurnsOptions): SessionLogTurn[] {
  return sessionLogTurns(threadOf(rows), options);
}

/** v1 parts as the blocks of one assistant message (`fromV1`, live). */
export function blocksOf(parts: readonly unknown[]): SessionLogBlock[] {
  const user = { info: { id: 'msg_blocks_user', role: 'user', sessionID: 'ses_test', time: { created: 1 } }, parts: [] };
  const reply = {
    info: { id: 'msg_blocks', role: 'assistant', parentID: 'msg_blocks_user', sessionID: 'ses_test', time: { created: 2 } },
    parts,
  };
  return threadOf([user, reply]).messages.find((m) => m.message_id === 'msg_blocks')?.blocks ?? [];
}
